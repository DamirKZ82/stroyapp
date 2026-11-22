"""
Доступ в админку: вход по паролю и назначение админов.

    POST /admin/api/login                     вход по номеру и паролю
    POST /admin/api/sms/request               запросить код для задания пароля -> талон
    POST /admin/api/sms/verify                проверить код по талону -> токен пароля
    POST /admin/api/password                  задать пароль         (токен пароля)
    POST /admin/api/admins                    назначить админа      (админ и его пароль)
    POST /admin/api/users/{id}/revoke-admin   снять права админа    (админ и его пароль)

Как это устроено и почему — в services/admin_access.py.

Вход по паролю и запрос кода не говорят, админ ли номер: нет такого номера,
номер не админ, пароль ещё не задан или он неверный — ответ один. Иначе
перебором номеров можно было бы узнать, кто у нас админ.
"""
import re
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from pydantic import BaseModel, field_validator

from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from handlers.h03_auth import BLOCKED_MESSAGE, auth_admin, auth_admin_setup
from libs.auth import issue_admin_token, issue_setup_token
from libs.common import clean_text, fit_to_sql
from libs.passwords import PASSWORD_MAX, password_problem
from libs.phone import normalize_phone
from libs.sms import send_admin_code
from libs.telegram import send_to_admins
from routers.r01_auth import REVIEW_PHONE
from services.admin_access import (
    check_password,
    client_address,
    confirm_subject,
    credentials_of,
    grant_admin,
    login_subject,
    note_login,
    request_sms_code,
    revoke_admin,
    set_password,
    verify_sms_code,
)
from services.moderation import log_action


router = APIRouter(prefix='/admin/api')


# -------------------------------------------------------------------------
# Pydantic модели
# -------------------------------------------------------------------------

def _typed_password(val: str) -> str:
    # Пароль не обрезаем и не правим: пробел в нём — такой же символ. Отсекаем
    # только пустой и заведомо слишком длинный, чтобы не считать хэш от мегабайта.
    if not val:
        raise ValueError('Введите пароль')
    if len(val) > PASSWORD_MAX:
        raise ValueError(f'Пароль не должен быть длиннее {PASSWORD_MAX} символов')
    return val


class LoginBody(BaseModel):
    phone: str
    password: str

    @field_validator('password')
    @classmethod
    def password_typed(cls, val):
        return _typed_password(val)


class SmsRequestBody(BaseModel):
    phone: str


class SmsVerifyBody(BaseModel):
    phone: str
    ticket: str     # талон, выданный на запрос кода
    code: str

    @field_validator('ticket')
    @classmethod
    def ticket_shaped(cls, val):
        if not val or len(val) > 100:
            raise ValueError('Получите код ещё раз')
        return val

    @field_validator('code')
    @classmethod
    def code_format(cls, val):
        val = (val or '').strip()
        if len(val) != 6 or not val.isascii() or not val.isdigit():
            raise ValueError('Код должен состоять из 6 цифр')
        return val


class PasswordBody(BaseModel):
    password: str

    @field_validator('password')
    @classmethod
    def password_typed(cls, val):
        return _typed_password(val)


class GrantBody(BaseModel):
    phone: str
    full_name: Optional[str] = None
    password: str       # пароль того, кто назначает

    @field_validator('full_name')
    @classmethod
    def name_valid(cls, val):
        if val is None:
            return None
        val = clean_text(val).strip()
        if len(val) > 200:
            raise ValueError('Имя не должно быть длиннее 200 символов')
        return val or None

    @field_validator('password')
    @classmethod
    def password_typed(cls, val):
        return _typed_password(val)


# -------------------------------------------------------------------------
# Хелперы
# -------------------------------------------------------------------------

def _label(user: dict) -> str:
    return f"{user['phone']} {user['full_name'] or ''}".strip()


_NOT_NAME = re.compile(r"[^\w \-']|[\d_]")


def _name(user: dict) -> str:
    """
    Как назвать админа в уведомлении. Номер целиком в чужой сервис не уходит.
    От имени остаются только буквы, пробелы и дефисы: его задаёт сам человек,
    и с точками, косыми чертами или переносами строк оно могло бы поставить в
    наше сообщение ссылку или целую строку от себя.
    """
    phone = user['phone']
    name = ' '.join(_NOT_NAME.sub(' ', user['full_name'] or '').split())[:60]
    return name or f'номер, который кончается на {phone[-4:-2]} {phone[-2:]}'


async def _confirm_by_password(admin: dict, password: str, request: Request) -> None:
    """Назначение и снятие админа подтверждаются паролем того, кто это делает."""
    creds = await credentials_of(admin['id'])
    if not await check_password(confirm_subject(admin['id']), client_address(request), password,
                                creds['password_hash'] if creds else None):
        # 403, а не 401: вход не истёк, неверен только введённый пароль.
        raise WarnException(403, 'Неверный пароль')


# -------------------------------------------------------------------------
# Вход по паролю
# -------------------------------------------------------------------------

@router.post('/login')
async def login(body: LoginBody, request: Request):
    phone = normalize_phone(body.phone)
    rows = await query_db(f"""
        SELECT u.id, u.phone, u.full_name, u.is_admin, u.is_service, u.is_blocked,
               c.password_hash, c.session_version
        FROM users u
        LEFT JOIN admin_credentials c ON c.user_id = u.id
        WHERE u.phone = {fit_to_sql(phone)}
    """)
    user = rows[0] if rows else None
    allowed = bool(user and user['is_admin'] and not user['is_service'] and user['password_hash'])

    matched = await check_password(login_subject(phone), client_address(request), body.password,
                                   user['password_hash'] if allowed else None)
    if not (allowed and matched):
        raise WarnException(401, 'Неверный номер или пароль')
    # О блокировке говорим только тому, кто знает пароль.
    if user['is_blocked']:
        raise WarnException(403, BLOCKED_MESSAGE)

    await note_login(user['id'])
    return {
        'token': issue_admin_token(user['id'], user['session_version']),
        'user': {'id': user['id'], 'phone': user['phone'], 'full_name': user['full_name']},
    }


# -------------------------------------------------------------------------
# Первый вход и смена пароля: код из SMS, затем пароль
# -------------------------------------------------------------------------

@router.post('/sms/request')
async def sms_request(body: SmsRequestBody, request: Request, background: BackgroundTasks):
    phone = normalize_phone(body.phone)
    ticket, issued = await request_sms_code(phone, client_address(request))
    if issued:
        admin, code = issued
        # После ответа, а не до: по времени ответа не должно быть видно, ушла ли SMS.
        background.add_task(send_admin_code, phone, code)
        background.add_task(
            send_to_admins,
            f'🔐 StroyApp: {_name(admin)} — запрошен код для пароля админки.\n'
            'Если код запрашивали не вы, никому его не сообщайте.')
    # Ответ один и для админа, и для чужого номера. Талон нужен, чтобы
    # проверить код: его знает только тот, кто код запросил.
    return {'sent': True, 'ticket': ticket}


@router.post('/sms/verify')
async def sms_verify(body: SmsVerifyBody):
    phone = normalize_phone(body.phone)
    admin = await verify_sms_code(phone, body.ticket, body.code)
    return {
        'token': issue_setup_token(admin['id']),
        'phone': admin['phone'],
        'full_name': admin['full_name'],
        'has_password': await credentials_of(admin['id']) is not None,
    }


@router.post('/password')
async def choose_password(body: PasswordBody, request: Request, background: BackgroundTasks,
                          admin=Depends(auth_admin_setup)):
    problem = password_problem(body.password, admin['phone'])
    if problem:
        raise WarnException(400, problem)

    first_time = await credentials_of(admin['id']) is None
    version = await set_password(admin, body.password, request.state.sms_confirmed_at)
    await log_action(admin, 'admin_password_set', 'user', admin['id'], _label(admin),
                     'первый вход: доступ включён' if first_time
                     else 'пароль сменён, прежние входы закрыты',
                     subjects=[admin['id']])
    # Чтобы чужая смена пароля не прошла незаметно.
    background.add_task(
        send_to_admins,
        f"🔐 StroyApp: {_name(admin)} — {'задан' if first_time else 'сменён'} пароль админки.\n"
        'Если это не вы и не ваш коллега — подтвердите номер по SMS и задайте пароль заново.')
    return {'token': issue_admin_token(admin['id'], version)}


# -------------------------------------------------------------------------
# Назначение и снятие админов
# -------------------------------------------------------------------------

@router.post('/admins')
async def add_admin(body: GrantBody, request: Request, background: BackgroundTasks,
                    admin=Depends(auth_admin)):
    phone = normalize_phone(body.phone)
    if REVIEW_PHONE is not None and phone == REVIEW_PHONE:
        raise WarnException(409, 'Это демо-номер для ревью сторов с постоянным кодом — '
                                 'права админа ему не выдаются.')
    await _confirm_by_password(admin, body.password, request)

    target, created = await grant_admin(phone, body.full_name)
    await log_action(admin, 'admin_grant', 'user', target['id'], _label(target),
                     'номер раньше не входил в приложение' if created else None,
                     subjects=[target['id']])
    background.add_task(
        send_to_admins,
        f'🔐 StroyApp: {_name(admin)} назначил админом — {_name(target)}.\n'
        'Доступ появится, когда тот сам подтвердит номер по SMS и задаст пароль.')
    return {'user': {'id': target['id'], 'phone': target['phone'], 'full_name': target['full_name']},
            'created': created}


@router.post('/users/{user_id}/revoke-admin')
async def remove_admin(user_id: int, body: PasswordBody, request: Request,
                       background: BackgroundTasks, admin=Depends(auth_admin)):
    if user_id == admin['id']:
        raise WarnException(400, 'Снять права с самого себя нельзя — попросите другого админа')
    await _confirm_by_password(admin, body.password, request)

    target = await revoke_admin(admin['id'], user_id)
    await log_action(admin, 'admin_revoke', 'user', user_id, _label(target), subjects=[user_id])
    background.add_task(send_to_admins,
                        f'🔐 StroyApp: {_name(admin)} снял права админа — {_name(target)}.')
    return {'ok': True}
