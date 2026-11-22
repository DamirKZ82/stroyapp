"""
JWT токены: выпуск и декодирование.
Используется HS256 + секрет из config['jwt']['secret'].

Токенов три вида, и каждый открывает только своё:

    обычный   { user_id, exp, iat }
        Выдаётся после кода из SMS и живёт config['jwt']['ttl_days']. С ним
        работает приложение. В админку он не пускает даже админа.

    админки   { user_id, exp, iat, adm: N }
        Выдаётся после входа по паролю и живёт config['admin']['session_hours'].
        N — session_version из admin_credentials: смена пароля меняет его, и
        все выданные раньше токены админки перестают работать.

    пароля    { user_id, exp, iat, pwd: true }
        Выдаётся админу после шестизначного кода из SMS и живёт
        config['admin']['setup_minutes']. Годится для одного: задать пароль
        админки. Ни в приложение, ни в админку с ним не войти.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt

from config import config


def _encode(payload: dict) -> str:
    return jwt.encode(payload, config['jwt']['secret'], algorithm=config['jwt']['algorithm'])


def issue_token(user_id: int) -> str:
    """Обычный токен: вход в приложение."""
    now = datetime.now(timezone.utc)
    return _encode({
        'user_id': user_id,
        'exp': now + timedelta(days=config['jwt']['ttl_days']),
        'iat': now,
    })


def issue_admin_token(user_id: int, session_version: int) -> str:
    """Токен админки: админ вошёл по паролю."""
    now = datetime.now(timezone.utc)
    return _encode({
        'user_id': user_id,
        'exp': now + timedelta(hours=config['admin']['session_hours']),
        'iat': now,
        'adm': session_version,
    })


def issue_setup_token(user_id: int) -> str:
    """Токен пароля: админ только что подтвердил номер кодом из SMS."""
    now = datetime.now(timezone.utc)
    return _encode({
        'user_id': user_id,
        'exp': now + timedelta(minutes=config['admin']['setup_minutes']),
        'iat': now,
        'pwd': True,
    })


def decode_token(token: str) -> Optional[dict]:
    """
    Декодировать токен. Вернуть payload или None, если токен невалидный/истёк.
    Никогда не бросает исключение — вызывающий решает, что делать с None.
    """
    try:
        return jwt.decode(token, config['jwt']['secret'], algorithms=[config['jwt']['algorithm']])
    except jwt.PyJWTError:
        return None
