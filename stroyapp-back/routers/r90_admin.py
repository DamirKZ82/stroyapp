"""
Веб-админка: страница и служебные аккаунты.

    GET   /admin                              страница
    GET   /admin/admin.css, /admin/admin.js   её стили и код
    GET   /admin/api/me                       кто вошёл         (админ)
    GET   /admin/api/service-users            служебные аккаунты (админ)
    POST  /admin/api/service-users            создать            (админ)
    PATCH /admin/api/service-users/{id}       изменить           (админ)

Остальные разделы админки — в r91_admin_users.py (обзор, пользователи,
журналы), r92_admin_content.py (объявления, отзывы, заявки),
r93_admin_complaints.py (жалобы) и r94_admin_access.py (вход по паролю,
назначение админов).

Служебный аккаунт — обычный пользователь приложения, который входит по
фиксированному коду без SMS: для ревьюеров Google Play / App Store и для
проверки приложения на своих устройствах.

Сделать служебным номер существующего обычного пользователя нельзя:
иначе админ получил бы вход в чужой аккаунт по известному ему коду.

«Отключить» служебный аккаунт — та же блокировка, что и у обычного
пользователя (services/moderation.py): вход закрыт, объявления скрыты.
"""
import pathlib
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from handlers.h03_auth import auth_admin
from libs.common import fit_to_sql, new_guid
from libs.date import get_timestamp_now
from libs.phone import normalize_phone
from routers.r01_auth import review_phone
from services.moderation import block_user, log_action, unblock_user


router = APIRouter(prefix='/admin')

_STATIC_DIR = pathlib.Path(__file__).resolve().parent.parent / 'static'


# -------------------------------------------------------------------------
# Pydantic модели
# -------------------------------------------------------------------------

def _check_code(val: Optional[str]) -> Optional[str]:
    if val is None:
        return None
    val = val.strip()
    # Приложение принимает только 4 цифры — другой код ввести не получится
    if len(val) != 4 or not val.isdigit():
        raise ValueError('Код должен состоять из 4 цифр')
    return val


def _check_name(val: Optional[str]) -> Optional[str]:
    if val is None:
        return None
    val = val.strip()
    if not val:
        raise ValueError('Имя не может быть пустым')
    if len(val) > 200:
        raise ValueError('Имя не должно быть длиннее 200 символов')
    return val


class CreateServiceUserBody(BaseModel):
    phone: str
    full_name: str
    code: Optional[str] = None      # не задан -> сгенерируем

    @field_validator('code')
    @classmethod
    def code_format(cls, val):
        return _check_code(val)

    @field_validator('full_name')
    @classmethod
    def name_valid(cls, val):
        return _check_name(val)


class UpdateServiceUserBody(BaseModel):
    full_name: Optional[str] = None
    code: Optional[str] = None
    is_blocked: Optional[bool] = None

    @field_validator('code')
    @classmethod
    def code_format(cls, val):
        return _check_code(val)

    @field_validator('full_name')
    @classmethod
    def name_valid(cls, val):
        return _check_name(val)


# -------------------------------------------------------------------------
# Хелперы
# -------------------------------------------------------------------------

_SERVICE_FIELDS = 'id, phone, full_name, service_code, is_blocked, is_admin, created_at'
SERVICE_OFF_REASON = 'Служебный аккаунт отключён'


def _service_public(row: dict) -> dict:
    return {
        'id': row['id'],
        'phone': row['phone'],
        'full_name': row['full_name'],
        # Код админа не отдаём даже другим админам — см. update_service_user.
        'code': None if row['is_admin'] else row['service_code'],
        'is_blocked': row['is_blocked'],
        'created_at': row['created_at'],
    }


# -------------------------------------------------------------------------
# Эндпоинты
# -------------------------------------------------------------------------

# Страница админки и два её файла. Раздаём только их, по списку: ничего
# другого из static по этому адресу получить нельзя.
_PAGE_FILES = {
    'admin.css': 'text/css; charset=utf-8',
    'admin.js': 'text/javascript; charset=utf-8',
}

# Страница грузит скрипты, стили, картинки и данные только со своего сервера:
# даже если в текст объявления попадёт разметка, чужой скрипт она не запустит.
_CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
        "connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'")


def _page_file(name: str, media_type: str) -> FileResponse:
    path = _STATIC_DIR / name
    if not path.exists():
        raise HTTPException(status_code=404, detail='Admin page not found')
    # no-store: админку не кэшируем ни в браузере, ни на прокси — после
    # выкладки сразу открывается новая версия.
    # DENY: не даём встроить её во фрейм на чужом сайте (кликджекинг).
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            'Cache-Control': 'no-store',
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': _CSP,
        },
    )


@router.get('', include_in_schema=False)
async def admin_page():
    return _page_file('admin.html', 'text/html; charset=utf-8')


@router.get('/{name}', include_in_schema=False)
async def admin_page_file(name: str):
    if name not in _PAGE_FILES:
        raise HTTPException(status_code=404, detail='Not found')
    return _page_file(name, _PAGE_FILES[name])


@router.get('/api/me')
async def admin_me(admin=Depends(auth_admin)):
    return {'id': admin['id'], 'phone': admin['phone'], 'full_name': admin['full_name']}


@router.get('/api/service-users')
async def list_service_users(admin=Depends(auth_admin)):
    rows = await query_db(f"""
        SELECT {_SERVICE_FIELDS}
        FROM users
        WHERE is_service = true
        ORDER BY id DESC
    """)
    return {'items': [_service_public(r) for r in rows]}


@router.post('/api/service-users')
async def create_service_user(body: CreateServiceUserBody, admin=Depends(auth_admin)):
    phone = normalize_phone(body.phone)

    if phone == review_phone():
        raise WarnException(
            409,
            'Этот номер уже задан на сервере как демо-номер для ревью — '
            'у него свой код из «Настроек». Выберите другой номер.',
        )

    existing = await query_db(f"""
        SELECT id, is_service FROM users WHERE phone = {fit_to_sql(phone)}
    """)
    if existing:
        if existing[0]['is_service']:
            raise WarnException(409, 'Служебный аккаунт с этим номером уже есть')
        raise WarnException(
            409,
            'Этим номером уже пользуется обычный пользователь. '
            'Сделать его служебным нельзя — выберите другой номер.',
        )

    code = body.code or f'{secrets.randbelow(10000):04d}'
    now = get_timestamp_now()
    rows = await query_db(f"""
        INSERT INTO users (guid, phone, full_name, language,
                           is_service, service_code, created_at, updated_at)
        VALUES (
            {fit_to_sql(new_guid())},
            {fit_to_sql(phone)},
            {fit_to_sql(body.full_name)},
            'ru',
            true,
            {fit_to_sql(code)},
            {fit_to_sql(now)},
            {fit_to_sql(now)}
        )
        RETURNING {_SERVICE_FIELDS}
    """)
    await log_action(admin, 'service_create', 'user', rows[0]['id'], f"{phone} {body.full_name}",
                     subjects=[rows[0]['id']])
    return {'item': _service_public(rows[0])}


@router.patch('/api/service-users/{user_id}')
async def update_service_user(user_id: int, body: UpdateServiceUserBody,
                              admin=Depends(auth_admin)):
    if body.full_name is None and body.code is None and body.is_blocked is None:
        raise WarnException(400, 'Нечего менять')

    # is_service = true в условии: этим эндпоинтом нельзя тронуть
    # обычного пользователя, даже зная его id.
    only_service = f'id = {fit_to_sql(user_id)} AND is_service = true'
    found = await query_db(f'SELECT {_SERVICE_FIELDS} FROM users WHERE {only_service}')
    if not found:
        raise WarnException(404, 'Служебный аккаунт не найден')
    before = found[0]
    if before['is_admin']:
        # Служебный аккаунт с правами админа появляется только по ошибке: ни
        # админка, ни make_admin их такому не выдают. В админку он не войдёт
        # (auth_admin), но и менять его отсюда незачем: сначала снять права.
        raise WarnException(403, 'У этого служебного аккаунта права администратора — так быть не '
                                 'должно. Снимите их в карточке пользователя.')

    # В журнал идёт только то, что действительно изменилось.
    changes = []
    sets = []
    if body.full_name is not None and body.full_name != before['full_name']:
        sets.append(f'full_name = {fit_to_sql(body.full_name)}')
        changes.append('имя')
    if body.code is not None and body.code != before['service_code']:
        sets.append(f'service_code = {fit_to_sql(body.code)}')
        changes.append('код')   # сам код в журнал не пишем
    if sets:
        sets.append(f'updated_at = {fit_to_sql(get_timestamp_now())}')
        await query_db(f"UPDATE users SET {', '.join(sets)} WHERE {only_service}")
    if 'код' in changes:
        # Смена кода гасит уже выданные коды: старый код больше не сработает
        await query_db(f"""
            UPDATE otp_codes SET used = true
             WHERE phone = {fit_to_sql(before['phone'])} AND used = false
        """)

    # Вход закрывается и открывается так же, как у обычных пользователей:
    # вместе с объявлениями аккаунта.
    if body.is_blocked is True and not before['is_blocked']:
        await block_user(user_id, SERVICE_OFF_REASON)
        changes.append('отключён')
    elif body.is_blocked is False and before['is_blocked']:
        await unblock_user(user_id)
        changes.append('включён')

    rows = await query_db(f'SELECT {_SERVICE_FIELDS} FROM users WHERE {only_service}')
    if changes:
        await log_action(admin, 'service_update', 'user', user_id,
                         f"{rows[0]['phone']} {rows[0]['full_name'] or ''}".strip(),
                         ', '.join(changes), subjects=[user_id])
    return {'item': _service_public(rows[0])}
