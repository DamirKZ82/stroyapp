"""
Подключение к PostgreSQL.
Пул инициализируется один раз в lifespan FastAPI.
Единственная функция для запросов — query_db.
"""
import asyncpg
from typing import Optional

from config import config
from libs.common import clean_text
from libs.date import get_timestamp_now


_pool: Optional[asyncpg.Pool] = None


async def init_db():
    """Создаёт пул соединений. Вызывается в lifespan при старте."""
    global _pool
    db = config['db']
    _pool = await asyncpg.create_pool(
        host=db['host'],
        port=db['port'],
        database=db['name'],
        user=db['user'],
        password=db['password'],
        min_size=db['min_size'],
        max_size=db['max_size'],
    )
    print(f"[{get_timestamp_now()}] ✅ DB pool ready: {db['host']}:{db['port']}/{db['name']}")


async def close_db():
    """Закрывает пул. Вызывается в lifespan при остановке."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
        print(f"[{get_timestamp_now()}] 🛑 DB pool closed")


# Сколько секунд запрос ждёт соединения. Запросы короткие, и ждать дольше —
# значит, пул кто-то держит или база не отвечает. Без предела запросы
# копились бы в очереди молча, а воркер выглядел бы зависшим; с пределом —
# отказ PoolBusy. У asyncpg в этот срок входит и открытие нового соединения,
# если свободное место в пуле есть, а открытого соединения нет.
_ACQUIRE_TIMEOUT = 10
# Столько ждут записи в журналы (errors_back, warns), когда все соединения
# заняты: журнал не стоит того, чтобы держать из-за него ответ. Запись тогда
# пропадает, а её текст остаётся в логе контейнера (handlers/h01_errors.py).
LOG_ACQUIRE_TIMEOUT = 1


class PoolBusy(Exception):
    """
    Соединения с базой не дождались: все заняты либо база не открыла новое.
    Отдельным исключением, а не TimeoutError: у того пустой текст, и в логе
    и в Telegram от такого сбоя оставалась бы строка без единого слова. По
    нему же обработчик ошибок понимает, что писать сбой в базу бесполезно
    (handlers/h01_errors.py).
    """
    def __init__(self, waited: float, exhausted: bool = True):
        reason = 'Нет свободного соединения с базой' if exhausted else 'База не открыла новое соединение'
        super().__init__(f'{reason}: ждали {waited:g} с')


def pool_exhausted() -> bool:
    """Все соединения пула заняты, и открыть ещё одно нельзя: свободного придётся ждать."""
    if _pool is None:
        return False
    return _pool.get_idle_size() == 0 and _pool.get_size() >= _pool.get_max_size()


def _sendable(sql: str) -> str:
    """
    Текст запроса, который точно дойдёт до сервера.

    Значения попадают в запрос через fit_to_sql, и он их уже чистит. Это
    вторая линия — на случай строки, собранной мимо него. Запрос, который
    нельзя закодировать в UTF-8 («половинка» суррогатной пары), asyncpg 0.31
    обрывает уже после того, как взял соединение, и в пул его не возвращает:
    десять таких запросов — и воркер перестаёт отвечать. Поэтому проверяем
    до того, как тронули соединение.
    """
    try:
        sql.encode('utf-8')
    except UnicodeEncodeError:
        return clean_text(sql)
    return sql


async def query_db(sql: str, wait: Optional[float] = None):
    """
    Выполнить SQL.
    - SELECT / RETURNING  -> список словарей (может быть пустым)
    - INSERT/UPDATE/DELETE без RETURNING -> None

    wait — сколько секунд ждать соединения (по умолчанию _ACQUIRE_TIMEOUT);
    не дождались — ErrorException с PoolBusy внутри.

    При любом падении asyncpg выбрасывает ErrorException(err, sql),
    которое глобальный хендлер ловит и сохраняет в errors_back с полным контекстом.
    """
    if _pool is None:
        raise RuntimeError('DB pool is not initialized')

    # Импорт внутри функции — чтобы избежать циклической зависимости
    # (h01_errors импортирует libs, а мы здесь — handlers).
    from handlers.h01_errors import ErrorException

    sql = _sendable(sql)
    if wait is None:
        wait = _ACQUIRE_TIMEOUT
    acquired = False
    # Чего ждём, известно до ожидания: все соединения заняты — значит,
    # свободного; место есть — значит, базы, которая открывает новое. После
    # ожидания пул уже может выглядеть иначе.
    exhausted = pool_exhausted()
    try:
        conn = await _pool.acquire(timeout=wait)
        acquired = True
        try:
            sql_upper = sql.strip().upper()
            is_select = sql_upper.startswith('SELECT') or 'RETURNING' in sql_upper
            if is_select:
                rows = await conn.fetch(sql)
                return [dict(row) for row in rows]
            await conn.execute(sql)
            return None
        finally:
            # Возврат — со своим сроком, а не через async with: тот отвёл бы
            # на возврат (это ещё одно обращение к базе — сброс состояния)
            # столько же, сколько было отпущено на ожидание. При коротком
            # ожидании журнала и медленной базе asyncpg рвал бы исправное
            # соединение, а следующие запросы открывали бы его заново.
            await _pool.release(conn, timeout=_ACQUIRE_TIMEOUT)
    except ErrorException:
        # Уже наше — пробрасываем как есть
        raise
    except Exception as err:
        # TimeoutError без текста до того, как соединение получено, — это
        # вышел срок ожидания. С текстом — отказ сети при открытии соединения,
        # а после получения — сбой самого запроса: их не трогаем.
        if not acquired and isinstance(err, TimeoutError) and not err.args:
            err = PoolBusy(wait, exhausted=exhausted)
        raise ErrorException(err=err, sql=sql)


class _TxRunner:
    """
    Объект, который можно передать в transaction-аware функции.
    У него есть метод query() с той же семантикой, что и у глобального query_db,
    но работает на конкретном соединении внутри транзакции.
    """
    def __init__(self, conn: asyncpg.Connection):
        self._conn = conn

    async def query(self, sql: str):
        from handlers.h01_errors import ErrorException
        sql = _sendable(sql)
        try:
            sql_upper = sql.strip().upper()
            is_select = sql_upper.startswith('SELECT') or 'RETURNING' in sql_upper
            if is_select:
                rows = await self._conn.fetch(sql)
                return [dict(row) for row in rows]
            await self._conn.execute(sql)
            return None
        except ErrorException:
            raise
        except Exception as err:
            raise ErrorException(err=err, sql=sql)


class transaction:
    """
    Контекстный менеджер для транзакции.

        async with transaction() as tx:
            await tx.query(f"INSERT ... ")
            await tx.query(f"UPDATE ... ")

    Если внутри with поднимется исключение — транзакция откатывается.
    """
    def __init__(self):
        self._conn = None
        self._tx = None
        self._acquire_ctx = None

    async def __aenter__(self):
        if _pool is None:
            raise RuntimeError('DB pool is not initialized')
        from handlers.h01_errors import ErrorException
        exhausted = pool_exhausted()
        self._acquire_ctx = _pool.acquire(timeout=_ACQUIRE_TIMEOUT)
        try:
            self._conn = await self._acquire_ctx.__aenter__()
        except TimeoutError as err:
            # ErrorException, как и в query_db: у него свой обработчик. Голое
            # исключение ушло бы в «последний рубеж», после которого сервер
            # на каждый такой запрос пишет в лог страницу трассировки.
            # TimeoutError с текстом — отказ сети, а не вышедший срок.
            raise ErrorException(err=err if err.args else PoolBusy(_ACQUIRE_TIMEOUT, exhausted=exhausted))
        try:
            self._tx = self._conn.transaction()
            await self._tx.start()
        except BaseException as err:
            # __aexit__ после сбоя в __aenter__ не вызывается — соединение
            # возвращаем сами, иначе оно осталось бы за этим запросом.
            await self._acquire_ctx.__aexit__(type(err), err, err.__traceback__)
            raise
        return _TxRunner(self._conn)

    async def __aexit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                await self._tx.commit()
            else:
                await self._tx.rollback()
        finally:
            await self._acquire_ctx.__aexit__(exc_type, exc, tb)
