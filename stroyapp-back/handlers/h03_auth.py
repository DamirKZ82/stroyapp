"""
Зависимости аутентификации.

auth_user — обязательная авторизация. Достаёт JWT из заголовка
Authorization: Bearer <token>, декодирует, находит юзера в БД,
кладёт user_id в request.state (чтобы попадал в errors_back/warns),
возвращает полный dict юзера.

Если токена нет / невалидный / юзер удалён        -> WarnException(401)
Если юзер заблокирован (is_blocked = true)        -> WarnException(403)

auth_admin — вход в админку: тот же пользователь, но с правами админа и с
токеном, выданным после входа по паролю (libs/auth.py). Не админ -> 403,
админ с обычным токеном или с токеном от прежнего пароля -> 401.

auth_admin_setup — админ, только что подтвердивший номер кодом из SMS
(токен пароля): с этим можно одно — задать пароль для админки.
"""
from fastapi import Request

from config import config
from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from libs.auth import decode_token
from libs.common import fit_to_sql


# Причину блокировки человеку не показываем: админ пишет её для своих, в журнал.
BLOCKED_MESSAGE = f"Аккаунт заблокирован. Вопросы — на {config['support_email']}"


async def _authenticate(request: Request) -> dict:
    """Пользователь по токену любого вида. Какой вид годится — решает вызывающий."""
    # 1) Authorization: Bearer <token>
    header = request.headers.get('Authorization') or request.headers.get('authorization')
    if not header or not header.lower().startswith('bearer '):
        raise WarnException(401, 'Требуется авторизация')

    token = header[7:].strip()
    if not token:
        raise WarnException(401, 'Требуется авторизация')

    # 2) Декодируем
    payload = decode_token(token)
    if payload is None:
        raise WarnException(401, 'Недействительный токен')

    user_id = payload.get('user_id')
    if not isinstance(user_id, int):
        raise WarnException(401, 'Недействительный токен')

    # 3) Ищем юзера в БД
    rows = await query_db(f"""
        SELECT id, guid, phone, full_name, language, fcm_token, is_blocked, is_admin, is_service
        FROM users
        WHERE id = {fit_to_sql(user_id)}
    """)
    if not rows:
        raise WarnException(401, 'Пользователь не найден')

    user = rows[0]
    if user['is_blocked']:
        raise WarnException(403, BLOCKED_MESSAGE)

    # Кладём id в state — чтобы глобальный error-handler мог писать его в errors_back
    request.state.user_id = user['id']
    # Содержимое токена: его вид решает, что этим токеном можно.
    request.state.token_payload = payload
    return user


async def auth_user(request: Request) -> dict:
    user = await _authenticate(request)
    # В приложение пускает только обычный токен. У токенов админки и пароля
    # свой срок и своя отмена (смена пароля, снятие прав) — здесь их никто не
    # проверяет, и «закрытый» вход в админку продолжал бы работать в приложении.
    payload = request.state.token_payload
    if 'adm' in payload or 'pwd' in payload:
        raise WarnException(401, 'Недействительный токен')
    return user


def _admin_only(user: dict) -> None:
    # Служебный аккаунт входит по постоянному коду из четырёх цифр, который
    # видят другие админы, — в админку он не попадает, даже если по ошибке
    # получил права.
    if not user['is_admin'] or user['is_service']:
        raise WarnException(403, 'Доступ только для администраторов')


async def auth_admin(request: Request) -> dict:
    user = await _authenticate(request)
    _admin_only(user)

    # Обычный токен (после SMS) в админку не пускает: нужен выданный после
    # входа по паролю и не устаревший — смена пароля и снятие прав гасят все
    # прежние входы.
    version = request.state.token_payload.get('adm')
    rows = await query_db(f"""
        SELECT session_version FROM admin_credentials WHERE user_id = {fit_to_sql(user['id'])}
    """)
    if type(version) is not int or not rows or rows[0]['session_version'] != version:
        raise WarnException(401, 'Вход в админку устарел — войдите снова')
    return user


async def auth_admin_setup(request: Request) -> dict:
    try:
        user = await _authenticate(request)
    except WarnException as err:
        # Срок токена пароля вышел — человеку нужно не «войти», а новый код.
        if err.status_code == 401:
            raise WarnException(401, 'Подтверждение по SMS устарело. Получите код ещё раз.')
        raise
    _admin_only(user)

    payload = request.state.token_payload
    issued_at = payload.get('iat')
    if payload.get('pwd') is not True or type(issued_at) is not int:
        raise WarnException(401, 'Подтверждение по SMS устарело. Получите код ещё раз.')
    # Когда подтверждён номер — чтобы одним подтверждением пароль задавали один раз.
    request.state.sms_confirmed_at = issued_at
    return user
