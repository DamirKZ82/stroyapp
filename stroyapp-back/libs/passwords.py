"""
Пароли админки: хэш, проверка и требования к паролю.

Хэш — scrypt из стандартной библиотеки: без новых зависимостей и с расходом
памяти, который мешает перебору на видеокартах. Параметры записаны в самой
строке хэша, поэтому их можно поднять позже, не ломая уже заданные пароли.

Один хэш считается доли секунды и занимает десятки мегабайт, поэтому:
- он считается в отдельном потоке — остальным сервер в это время отвечает;
- одновременно считается не больше двух: поток запросов на вход не съест
  память сервера;
- очередь к ним короткая: кому не хватило места, получает отказ сразу
  (TooBusy), а не висит минутами вместе с тысячей таких же. Место занимают
  на весь запрос (place_in_line), до любой работы с базой: поток запросов
  на вход тогда не копит ни ожидающих, ни строк в таблице попыток.
"""
import asyncio
import base64
import binascii
import contextlib
import hashlib
import hmac
import re
import secrets
import unicodedata
from typing import Optional


# Рекомендация OWASP для scrypt: N = 2^15, r = 8, p = 3 — это 32 МБ памяти.
_LOG_N, _R, _P = 15, 8, 3
_KEY_LEN = 32
_SALT_LEN = 16
# OpenSSL по умолчанию не даёт scrypt больше 32 МБ, а нужно чуть больше.
_MAX_MEM = 64 * 1024 * 1024

PASSWORD_MIN = 8
PASSWORD_MAX = 128

_slots = asyncio.Semaphore(2)
# Сколько запросов считают хэш или ждут своей очереди. Выше предела — отказ.
_MAX_IN_LINE = 10
_in_line = 0


class TooBusy(Exception):
    """Очередь на хэш заполнена."""


@contextlib.asynccontextmanager
async def place_in_line():
    """Место в очереди на хэш. Мест нет — TooBusy. Внутри зовут hash_password / verify_password."""
    global _in_line
    if _in_line >= _MAX_IN_LINE:
        raise TooBusy()
    _in_line += 1
    try:
        yield
    finally:
        _in_line -= 1

# Пароли, которые подбирают первыми. Список короткий намеренно: от перебора
# защищает лимит попыток, а здесь отсекается только то, что угадывают с ходу.
_COMMON = frozenset((
    'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword',
    'qwertyui', 'qwertyuiop', 'qwerty12', 'qwerty123', 'qwerty1234', 'qwerty12345',
    '1q2w3e4r', '1q2w3e4r5t', 'q1w2e3r4', 'q1w2e3r4t5', '1qaz2wsx', '1qazxsw2', 'zaq12wsx',
    'asdfghjk', 'asdfghjkl', 'zxcvbnm1', 'abc12345', 'abcd1234', 'a1234567', 'a12345678',
    'admin123', 'admin1234', 'admin12345', 'administrator', 'iloveyou', 'letmein1', 'welcome1',
    'йцукенгш', 'йцукен123', 'пароль123', 'парольпароль', 'админ123', 'привет123',
    'toiapp123', 'toiapp2026', 'toiappadmin', 'toyhana123', 'toyhanaadmin',
))


def _normalized(password: str) -> str:
    # Один и тот же пароль с разных клавиатур и систем должен дать одни и те
    # же байты: буква «й» бывает и одним знаком, и двумя.
    return unicodedata.normalize('NFKC', password)


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode('ascii')


def _scrypt(password: str, salt: bytes, log_n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(_normalized(password).encode('utf-8'), salt=salt,
                          n=1 << log_n, r=r, p=p, dklen=_KEY_LEN, maxmem=_MAX_MEM)


def _hash(password: str) -> str:
    salt = secrets.token_bytes(_SALT_LEN)
    return f'scrypt${_LOG_N}${_R}${_P}${_b64(salt)}${_b64(_scrypt(password, salt, _LOG_N, _R, _P))}'


def _verify(password: str, stored: str) -> bool:
    try:
        kind, log_n, r, p, salt, digest = stored.split('$')
        if kind != 'scrypt':
            return False
        expected = base64.b64decode(digest, validate=True)
        actual = _scrypt(password, base64.b64decode(salt, validate=True), int(log_n), int(r), int(p))
    except (ValueError, OverflowError, binascii.Error):
        # Строка не нашего вида или параметры, которые scrypt не принял.
        return False
    return hmac.compare_digest(actual, expected)


# Хэш, которому не подходит ни один пароль. С ним сверяется вход по номеру,
# у которого пароля нет, — см. verify_password.
_NOBODY = f'scrypt${_LOG_N}${_R}${_P}${_b64(secrets.token_bytes(_SALT_LEN))}${_b64(secrets.token_bytes(_KEY_LEN))}'


async def hash_password(password: str) -> str:
    async with _slots:
        return await asyncio.to_thread(_hash, password)


async def verify_password(password: str, stored: Optional[str]) -> bool:
    """
    Подходит ли пароль к сохранённому хэшу.

    stored=None — пароля у этого номера нет. Хэш считаем всё равно: иначе по
    времени ответа было бы видно, есть ли у номера доступ в админку.
    """
    async with _slots:
        matched = await asyncio.to_thread(_verify, password, stored or _NOBODY)
    return matched and stored is not None


def password_problem(password: str, phone: str) -> Optional[str]:
    """Чем пароль не годится — словами для человека. None, если годится."""
    text = _normalized(password)
    if len(text) < PASSWORD_MIN:
        return f'Пароль должен быть не короче {PASSWORD_MIN} символов'
    if len(text) > PASSWORD_MAX:
        return f'Пароль не должен быть длиннее {PASSWORD_MAX} символов'
    # Cc — управляющие (перенос строки, табуляция), Cs — «половинки» символов,
    # которые не превратить в байты: хэш от такого пароля не посчитать.
    if any(unicodedata.category(ch) in ('Cc', 'Cs') for ch in text):
        return 'В пароле есть невидимые символы (перенос строки или табуляция). Наберите его заново.'
    if text.isdigit():
        return 'Пароль из одних цифр подбирается слишком быстро — добавьте буквы'
    if len(set(text)) < 4:
        return 'Пароль слишком простой: в нём повторяются одни и те же символы'
    if text.lower() in _COMMON:
        return 'Это один из самых частых паролей — такие проверяют первыми. Придумайте другой.'
    # Номер без «+7»: его набирают и с восьмёркой, и вовсе без кода страны.
    national = phone[2:]
    if len(national) >= 7 and national in re.sub(r'\D', '', text):
        return 'Пароль не должен содержать ваш номер телефона'
    return None
