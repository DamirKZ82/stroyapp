"""
Обработка ошибок.

Два типа исключений:
    WarnException  — ожидаемая пользовательская ошибка (404/400/403). Логируется в warns.
    ErrorException — системная ошибка. Логируется в errors_back, уведомление в Telegram.

Глобальный хендлер перехватывает ЛЮБОЕ необработанное исключение
и сохраняет в БД с полным контекстом (SQL, traceback, метод, путь, user_id).
"""
import time
import traceback as tb_module
from typing import Optional

from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from connections.connect_postgres import LOG_ACQUIRE_TIMEOUT, PoolBusy, pool_exhausted, query_db
from libs.common import fit_to_sql
from libs.date import get_timestamp_now
from libs.telegram import send_to_admins


class WarnException(Exception):
    """Пользовательская ошибка: плохой запрос, не найдено, нет прав и т.п."""
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


class ErrorException(Exception):
    """Системная ошибка: упал SQL или что-то пошло не так на сервере."""
    def __init__(self, err: Exception, sql: Optional[str] = None):
        self.err = err
        self.sql = sql
        self.traceback = tb_module.format_exc()
        # У части исключений текста нет вовсе (TimeoutError) — тогда хотя бы имя.
        self.message = str(err) or err.__class__.__name__
        super().__init__(self.message)


# Сообщение, которое видит пользователь при системной ошибке. Без технических подробностей.
GENERIC_ERROR_MESSAGE = 'Произошла ошибка на сервере. Попробуйте позже или обратитесь в техподдержку.'


def _user_id_from_request(request: Request) -> Optional[int]:
    """Достать user_id из request.state, если auth-мидлварь положила."""
    return getattr(request.state, 'user_id', None)


async def _save_warn(request: Request, code: int, message: str):
    try:
        await _log_query(f"""
            INSERT INTO warns (code, message, method, path, user_id, created_at)
            VALUES (
                {fit_to_sql(code)},
                {fit_to_sql(message)},
                {fit_to_sql(request.method)},
                {fit_to_sql(str(request.url.path))},
                {fit_to_sql(_user_id_from_request(request))},
                {fit_to_sql(get_timestamp_now())}
            )
        """)
    except Exception as err:
        # В базу отказ не попал — в логе контейнера он остаётся целиком.
        print(
            f"[{get_timestamp_now()}] ⚠️ Failed to save warn: {err} | {code} {request.method} "
            f"{request.url.path} user={_user_id_from_request(request)}: {message}"
        )


async def _log_query(sql: str):
    """
    Запись в журнал (warns, errors_back). Когда все соединения заняты, ждёт
    недолго: иначе каждый ответ — и обычный отказ 400, которому база не
    нужна, — задерживался бы на всё время ожидания пула.

    Короткий срок — только для этого случая. У asyncpg в срок ожидания
    входит и открытие нового соединения, и при свободном пуле и медленной
    базе секунды на него не хватало: запись пропадала, а в логе стояло
    «нет свободного соединения».
    """
    return await query_db(sql, wait=LOG_ACQUIRE_TIMEOUT if pool_exhausted() else None)


async def _save_error(request: Request, message: str, traceback: str, sql: Optional[str]) -> Optional[int]:
    try:
        rows = await _log_query(f"""
            INSERT INTO errors_back (message, traceback, sql, method, path, user_id, created_at)
            VALUES (
                {fit_to_sql(message)},
                {fit_to_sql(traceback)},
                {fit_to_sql(sql)},
                {fit_to_sql(request.method)},
                {fit_to_sql(str(request.url.path))},
                {fit_to_sql(_user_id_from_request(request))},
                {fit_to_sql(get_timestamp_now())}
            )
            RETURNING id
        """)
        if rows:
            return rows[0]['id']
    except Exception as err:
        print(f"[{get_timestamp_now()}] ❌ Failed to save error: {err}")
        # В базу сбой не попал — запрос и трассировка остаются в логе
        # контейнера: больше их взять неоткуда.
        print(
            f"[{get_timestamp_now()}] ❌ {request.method} {request.url.path} "
            f"user={_user_id_from_request(request)}: {message}\n"
            f"{(sql or '').strip()[:2000]}\n{traceback}"
        )
    return None


async def _notify_telegram(error_id: Optional[int], message: str, path: str):
    """Отправить уведомление в Telegram. Если токен не задан — тихо пропускаем."""
    await send_to_admins(f"🚨 ToiApp error #{error_id}\n{path}\n{message[:500]}")


# Когда о занятом пуле сообщали в Telegram в последний раз (time.monotonic);
# None — ещё ни разу.
_pool_alert_at: Optional[float] = None
# Не чаще раза в столько секунд: при занятом пуле отказ получает каждый
# запрос, и сообщение на каждый — это сотни одинаковых строк и лишние
# секунды к каждому ответу.
_POOL_ALERT_EVERY = 60


async def _report_pool_busy(request: Request, message: str):
    """
    Сбой «нет свободного соединения». В базу его не пишем: запись ждала бы
    того же пула, и ответ ушёл бы позже, чем приложение перестаёт его ждать.
    Остаются строка в логе контейнера и сообщение в Telegram.
    """
    global _pool_alert_at
    path = str(request.url.path)
    print(f"[{get_timestamp_now()}] ❌ {message} ({request.method} {path})")
    now = time.monotonic()
    if _pool_alert_at is not None and now - _pool_alert_at < _POOL_ALERT_EVERY:
        return
    _pool_alert_at = now
    await _notify_telegram(None, message, path)


# ---- Хендлеры, подключаются в main.py через app.add_exception_handler ---------


async def warn_handler(request: Request, exc: WarnException):
    await _save_warn(request, exc.status_code, exc.message)
    return JSONResponse(status_code=exc.status_code, content={'message': exc.message})


async def error_handler(request: Request, exc: ErrorException):
    if isinstance(exc.err, PoolBusy):
        await _report_pool_busy(request, exc.message)
        return JSONResponse(status_code=500, content={'message': GENERIC_ERROR_MESSAGE})
    error_id = await _save_error(request, exc.message, exc.traceback, exc.sql)
    await _notify_telegram(error_id, exc.message, str(request.url.path))
    print(f"[{get_timestamp_now()}] ❌ Error #{error_id}: {exc.message}")
    return JSONResponse(status_code=500, content={'message': GENERIC_ERROR_MESSAGE})


async def unhandled_handler(request: Request, exc: Exception):
    """Последний рубеж — всё, что не ErrorException и не Warn, сюда."""
    traceback = tb_module.format_exc()
    message = str(exc) or exc.__class__.__name__
    if isinstance(exc, PoolBusy):
        await _report_pool_busy(request, message)
        return JSONResponse(status_code=500, content={'message': GENERIC_ERROR_MESSAGE})
    error_id = await _save_error(request, message, traceback, None)
    await _notify_telegram(error_id, message, str(request.url.path))
    print(f"[{get_timestamp_now()}] ❌ Unhandled #{error_id}: {message}")
    return JSONResponse(status_code=500, content={'message': GENERIC_ERROR_MESSAGE})


async def validation_handler(request: Request, exc: RequestValidationError):
    """
    Ошибки валидации Pydantic → 400 с понятным текстом.
    Если валидатор поля бросал ValueError('Название не может быть пустым') —
    именно этот текст и покажем пользователю.
    """
    errors = exc.errors()
    message = 'Некорректные данные'
    if errors:
        first = errors[0]
        msg = first.get('msg', '')
        # pydantic v2 добавляет префикс "Value error, " перед пользовательским сообщением
        if msg.startswith('Value error, '):
            msg = msg[len('Value error, '):]
        if msg:
            message = msg
    await _save_warn(request, 400, message)
    return JSONResponse(status_code=400, content={'message': message})
