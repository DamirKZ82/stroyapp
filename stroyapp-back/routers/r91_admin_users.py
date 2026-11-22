"""
Админка: обзор, пользователи, журнал действий, журналы ошибок.

    GET    /admin/api/stats                  цифры для первой страницы
    GET    /admin/api/users                  список с поиском и фильтром
    GET    /admin/api/users/{id}             человек и всё его: объявления, заявки, отзывы
    POST   /admin/api/users/{id}/block       заблокировать (причина обязательна)
    POST   /admin/api/users/{id}/unblock     разблокировать
    DELETE /admin/api/users/{id}             удалить насовсем со всеми данными
    POST   /admin/api/users/{id}/grant-pro   подарить Pro на N месяцев (причина обязательна)
    GET    /admin/api/actions                кто из админов что делал
    GET    /admin/api/logs                   ошибки сервера, приложения и отказы

Всё — только для админов (auth_admin). Каждое изменение пишется в журнал.

Переписку пользователей админка не показывает: это личные сообщения, и
читать их без жалобы от участника незачем. Видны только счётчики.
"""
import re
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, field_validator

from connections.connect_postgres import query_db, transaction
from handlers.h01_errors import WarnException
from handlers.h03_auth import auth_admin
from libs.admin_query import MAX_PAGE, like, limit_offset, paged, phone_match, where_sql
from libs.common import fit_to_sql, new_guid
from libs.plans import extend_pro, get_plan
from libs.date import KZ_TZ, add_minutes, get_timestamp_now
from services.account import purge_users
from services.admin_listings import fetch_providers
from services.moderation import block_user, log_action, unblock_user
from services.terms import TERMS_VERSION


router = APIRouter(prefix='/admin/api')

SERIES_DAYS = 14

USER_FILTERS = {
    'all': None,
    'blocked': 'u.is_blocked',
    'owners': 'EXISTS (SELECT 1 FROM providers p WHERE p.owner_id = u.id)',
    'clients': 'EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = u.id)',
    'admins': 'u.is_admin',
    'service': 'u.is_service',
}

# admin_active — админ уже задал пароль, то есть может войти. Назначенный, но
# ещё не заходивший админ — is_admin без admin_active.
_USER_FIELDS = """u.id, u.phone, u.full_name, u.language, u.is_blocked, u.blocked_at,
                  u.blocked_reason, u.is_admin, u.is_service, u.created_at,
                  EXISTS (SELECT 1 FROM admin_credentials ac WHERE ac.user_id = u.id) AS admin_active"""

# Что удалилось вместе с аккаунтом — для журнала (ключи из purge_users).
_REMOVED = (
    ('providers', 'объявлений'),
    ('bookings', 'заявок'), ('reviews', 'отзывов'), ('chats', 'переписок'), ('favorites', 'избранного'),
    ('complaints', 'жалоб'), ('peer_blocks', 'блокировок собеседников'),
)


class ReasonBody(BaseModel):
    reason: str

    @field_validator('reason')
    @classmethod
    def reason_valid(cls, val):
        val = (val or '').strip()
        if len(val) < 3:
            raise ValueError('Укажите причину — её увидят другие админы в журнале')
        if len(val) > 500:
            raise ValueError('Причина не должна быть длиннее 500 символов')
        return val


class GrantProBody(ReasonBody):
    months: int

    @field_validator('months')
    @classmethod
    def months_ok(cls, val):
        if val < 1 or val > 12:
            raise ValueError('От 1 до 12 месяцев')
        return val


# -------------------------------------------------------------------------
# Обзор
# -------------------------------------------------------------------------

@router.get('/stats')
async def stats(admin=Depends(auth_admin)):
    now = get_timestamp_now()
    week = fit_to_sql(add_minutes(now, -7 * 24 * 60))
    day = fit_to_sql(add_minutes(now, -24 * 60))

    rows = await query_db(f"""
        SELECT
            (SELECT COUNT(*) FROM users)::int AS users_total,
            (SELECT COUNT(*) FROM users WHERE created_at >= {week})::int AS users_week,
            (SELECT COUNT(*) FROM users WHERE is_blocked)::int AS users_blocked,
            (SELECT COUNT(*) FROM providers)::int AS providers_total,
            (SELECT COUNT(*) FROM providers p JOIN categories c ON c.id = p.category_id
              WHERE c.kind = 'material')::int AS shops_total,
            (SELECT COUNT(*) FROM providers p JOIN categories c ON c.id = p.category_id
              WHERE c.kind = 'service')::int AS crews_total,
            (SELECT COUNT(*) FROM provider_items)::int AS items_total,
            (SELECT COUNT(*) FROM providers WHERE is_active)::int AS providers_public,
            (SELECT COUNT(*) FROM providers WHERE hidden_at IS NOT NULL)::int AS providers_hidden,
            (SELECT COUNT(*) FROM bookings)::int AS bookings_total,
            (SELECT COUNT(*) FROM bookings WHERE created_at >= {week})::int AS bookings_week,
            (SELECT COUNT(*) FROM bookings WHERE status = 'pending')::int AS bookings_pending,
            (SELECT COUNT(*) FROM bookings WHERE status = 'confirmed')::int AS bookings_confirmed,
            (SELECT COUNT(*) FROM bookings WHERE status = 'rejected')::int AS bookings_rejected,
            (SELECT COUNT(*) FROM bookings WHERE status = 'cancelled')::int AS bookings_cancelled,
            (SELECT COUNT(*) FROM reviews)::int AS reviews_total,
            (SELECT COALESCE(AVG(rating), 0)::float FROM reviews) AS reviews_avg,
            (SELECT COUNT(*) FROM chats)::int AS chats_total,
            (SELECT COUNT(*) FROM chat_messages)::int AS messages_total,
            (SELECT COUNT(*) FROM errors_back WHERE created_at >= {day})::int AS errors_back_day,
            (SELECT COUNT(*) FROM errors_front WHERE created_at >= {day})::int AS errors_front_day,
            (SELECT COUNT(*) FROM warns WHERE created_at >= {day})::int AS warns_day,
            (SELECT COUNT(*) FROM complaints WHERE status = 'new')::int AS complaints_new,
            (SELECT COUNT(*) FROM complaints)::int AS complaints_total,
            (SELECT COUNT(*) FROM seller_plans WHERE paid_until > {fit_to_sql(now)})::int AS sellers_pro,
            (SELECT COUNT(*) FROM seller_plans WHERE trial_ends_at > {fit_to_sql(now)}
               AND (paid_until IS NULL OR paid_until <= {fit_to_sql(now)}))::int AS sellers_trial,
            (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'paid' AND gateway <> 'admin'
               AND paid_at >= {fit_to_sql(add_minutes(now, -30 * 24 * 60))})::int AS revenue_30d,
            (SELECT COUNT(*) FROM providers WHERE verify_requested_at IS NOT NULL
               AND verified_at IS NULL)::int AS verify_wait
    """)
    totals = rows[0]
    totals['reviews_avg'] = round(totals['reviews_avg'], 2)

    # По дням за две недели. substr, а не сравнение строк целиком: в старых
    # записях дата и время разделены пробелом, а не «T».
    today = datetime.now(KZ_TZ).date()
    days = [(today - timedelta(days=i)).isoformat() for i in range(SERIES_DAYS - 1, -1, -1)]
    since = fit_to_sql(days[0])

    async def per_day(table: str) -> dict:
        found = await query_db(f"""
            SELECT substr(created_at, 1, 10) AS day, COUNT(*)::int AS n
            FROM {table}
            WHERE substr(created_at, 1, 10) >= {since}
            GROUP BY 1
        """)
        return {r['day']: r['n'] for r in found}

    users, bookings = await per_day('users'), await per_day('bookings')
    providers = await per_day('providers')
    series = [{
        'day': d,
        'users': users.get(d, 0),
        'bookings': bookings.get(d, 0),
        'listings': providers.get(d, 0),
    } for d in days]

    return {'totals': totals, 'series': series}


# -------------------------------------------------------------------------
# Пользователи
# -------------------------------------------------------------------------

@router.get('/users')
async def list_users(
    admin=Depends(auth_admin),
    q: Optional[str] = Query(None, max_length=100),
    filter: str = Query('all'),
    page: int = Query(1, ge=1, le=MAX_PAGE),
    page_size: int = Query(30, ge=1, le=100),
):
    if filter not in USER_FILTERS:
        raise WarnException(400, f'filter должен быть одним из: {sorted(USER_FILTERS)}')

    conditions = []
    if USER_FILTERS[filter]:
        conditions.append(USER_FILTERS[filter])
    if q and q.strip():
        conditions.append(f"(u.full_name ILIKE {like(q)} OR {phone_match('u.phone', q)})")

    items = await query_db(f"""
        SELECT {_USER_FIELDS},
               (SELECT COUNT(*) FROM providers p WHERE p.owner_id = u.id)::int AS providers,
               (SELECT COUNT(*) FROM bookings b WHERE b.client_id = u.id)::int AS bookings
        FROM users u
        WHERE {where_sql(conditions)}
        ORDER BY u.id DESC
        {limit_offset(page, page_size)}
    """)
    total = await query_db(f"SELECT COUNT(*)::int AS n FROM users u WHERE {where_sql(conditions)}")
    return paged(items, total[0]['n'], page, page_size)


async def _user_or_404(user_id: int) -> dict:
    rows = await query_db(f"""
        SELECT {_USER_FIELDS}, u.updated_at
        FROM users u
        WHERE u.id = {fit_to_sql(user_id)}
    """)
    if not rows:
        raise WarnException(404, 'Пользователь не найден')
    return rows[0]


def _user_label(user: dict) -> str:
    return f"{user['phone']} {user['full_name'] or ''}".strip()


@router.get('/users/{user_id}')
async def get_user(user_id: int, admin=Depends(auth_admin)):
    user = await _user_or_404(user_id)
    uid = fit_to_sql(user_id)

    bookings = await query_db(f"""
        SELECT b.id, b.status, b.event_date, b.address, b.created_at,
               p.name AS subject
        FROM bookings b
        LEFT JOIN providers p ON p.id = b.provider_id
        WHERE b.client_id = {uid}
        ORDER BY b.id DESC
        LIMIT 20
    """)
    reviews = await query_db(f"""
        SELECT r.id, r.rating, r.text, r.created_at, p.name AS subject
        FROM reviews r
        LEFT JOIN providers p ON p.id = r.provider_id
        WHERE r.client_id = {uid}
        ORDER BY r.id DESC
        LIMIT 20
    """)
    # Чёрные списки собеседников — тоже только числом: peer_blocks_on — у
    # скольких людей он в чёрном списке, peer_blocks_by — скольких внёс сам.
    # Списка «кто кого заблокировал» в админке нет, как нет и переписки:
    # модератору хватает чисел. Номера пары называет только сообщение о новой
    # блокировке (services/peer_blocks.notice_text).
    counts = await query_db(f"""
        SELECT
            (SELECT COUNT(*) FROM bookings WHERE client_id = {uid})::int AS bookings,
            (SELECT COUNT(*) FROM reviews WHERE client_id = {uid})::int AS reviews,
            (SELECT COUNT(*) FROM chats WHERE client_id = {uid} OR owner_id = {uid})::int AS chats,
            (SELECT COUNT(*) FROM chat_messages WHERE sender_id = {uid})::int AS messages,
            (SELECT COUNT(*) FROM complaints WHERE target_user_id = {uid})::int AS complaints_on,
            (SELECT COUNT(*) FROM complaints WHERE target_user_id = {uid} AND status = 'new')::int AS complaints_on_new,
            (SELECT COUNT(*) FROM complaints WHERE reporter_id = {uid})::int AS complaints_by,
            (SELECT COUNT(*) FROM peer_blocks WHERE peer_id = {uid})::int AS peer_blocks_on,
            (SELECT COUNT(*) FROM peer_blocks WHERE user_id = {uid})::int AS peer_blocks_by
    """)
    # Когда админ задал пароль и когда последний раз входил: по этому видно
    # и «ещё не активирован», и вход, которого сам человек не делал.
    access = await query_db(f"""
        SELECT password_set_at, last_login_at FROM admin_credentials WHERE user_id = {uid}
    """)
    # Какую версию Условий использования человек принял последней и когда.
    # Нет строки — входил из сборки приложения, где согласия ещё не было,
    # или остановился на шаге согласия.
    terms = await query_db(f"""
        SELECT version, accepted_at FROM terms_acceptances
        WHERE user_id = {uid}
        ORDER BY accepted_at DESC, version DESC
        LIMIT 1
    """)
    payments = await query_db(f"""
        SELECT id, months, amount, status, gateway, note, created_at, paid_at
        FROM payments WHERE user_id = {uid}
        ORDER BY id DESC
        LIMIT 20
    """)
    return {
        'user': user,
        'plan': await get_plan(user_id),
        'payments': payments,
        'terms': {'current': TERMS_VERSION, 'accepted': terms[0] if terms else None},
        'admin_access': access[0] if access else None,
        'providers': await fetch_providers([f'p.owner_id = {uid}']),
        'bookings': bookings,
        'reviews': reviews,
        'counts': counts[0],
    }


def _refuse_self_or_admin(target: dict, admin: dict, verb: str) -> None:
    if target['id'] == admin['id']:
        raise WarnException(400, f'Нельзя {verb} самого себя')
    if target['is_admin']:
        # Два шага вместо одного: снять права можно только со своим паролем
        # (r94_admin_access), так что одним нажатием админа из админки не выбить.
        raise WarnException(403, f'Нельзя {verb} администратора. Сначала снимите с него права админа.')


@router.post('/users/{user_id}/block')
async def block(user_id: int, body: ReasonBody, admin=Depends(auth_admin)):
    target = await _user_or_404(user_id)
    _refuse_self_or_admin(target, admin, 'заблокировать')
    await block_user(user_id, body.reason)
    await log_action(admin, 'user_block', 'user', user_id, _user_label(target), body.reason,
                     subjects=[user_id])
    return {'user': await _user_or_404(user_id)}


@router.post('/users/{user_id}/unblock')
async def unblock(user_id: int, admin=Depends(auth_admin)):
    target = await _user_or_404(user_id)
    await unblock_user(user_id)
    await log_action(admin, 'user_unblock', 'user', user_id, _user_label(target), subjects=[user_id])
    return {'user': await _user_or_404(user_id)}


@router.post('/users/{user_id}/grant-pro')
async def grant_pro(user_id: int, body: GrantProBody, admin=Depends(auth_admin)):
    """
    Подарить Pro: компенсация, акция, оплата по счёту. В оплатах — строка
    с gateway 'admin' и суммой 0, в журнале — кто и почему.
    """
    target = await _user_or_404(user_id)
    now = get_timestamp_now()
    async with transaction() as tx:
        await tx.query(f"""
            INSERT INTO payments (guid, user_id, months, amount, status, gateway,
                                  granted_by, note, created_at, paid_at)
            VALUES ({fit_to_sql(new_guid())}, {fit_to_sql(user_id)}, {fit_to_sql(body.months)}, 0,
                    'paid', 'admin', {fit_to_sql(admin['id'])}, {fit_to_sql(body.reason)},
                    {fit_to_sql(now)}, {fit_to_sql(now)})
        """)
        until = await extend_pro(tx, user_id, body.months)
    await log_action(admin, 'pro_grant', 'user', user_id, _user_label(target),
                     f'{body.months} мес. до {until[:10]}: {body.reason}', subjects=[user_id])
    return {'plan': await get_plan(user_id)}


@router.delete('/users/{user_id}')
async def delete_user(user_id: int, admin=Depends(auth_admin)):
    target = await _user_or_404(user_id)
    _refuse_self_or_admin(target, admin, 'удалить')
    removed = await purge_users([user_id])
    parts = [f'{name} {removed[key]}' for key, name in _REMOVED if removed.get(key)]
    details = 'Вместе с аккаунтом удалено: ' + ', '.join(parts) if parts else None
    # Ни номера, ни имени: после удаления аккаунта их не хранит и журнал.
    await log_action(admin, 'user_delete', 'user', user_id, f'аккаунт №{user_id}', details)
    return {'deleted': True, 'removed': removed}


# -------------------------------------------------------------------------
# Журнал действий админов
# -------------------------------------------------------------------------

@router.get('/actions')
async def list_actions(
    admin=Depends(auth_admin),
    page: int = Query(1, ge=1, le=MAX_PAGE),
    page_size: int = Query(50, ge=1, le=100),
):
    items = await query_db(f"""
        SELECT id, admin_id, admin_phone, action, target_type, target_id,
               target_label, details, created_at
        FROM admin_actions
        ORDER BY id DESC
        {limit_offset(page, page_size)}
    """)
    total = await query_db('SELECT COUNT(*)::int AS n FROM admin_actions')
    return paged(items, total[0]['n'], page, page_size)


# -------------------------------------------------------------------------
# Журналы ошибок
# -------------------------------------------------------------------------

# Вид журнала -> (таблица, где случилось, подробности, код ответа, запрос).
# Имена колонок — из этого словаря, из запроса в SQL попадает только ключ.
_LOGS = {
    'back': ('errors_back', "COALESCE(e.method || ' ', '') || COALESCE(e.path, '')",
             "COALESCE(e.traceback, '')", 'null::int', 'e.sql'),
    'front': ('errors_front', "COALESCE(e.screen, '')", "COALESCE(e.stack, '')", 'null::int', 'null'),
    'warns': ('warns', "COALESCE(e.method || ' ', '') || COALESCE(e.path, '')", "''", 'e.code', 'null'),
}

_SQL_STRING = re.compile(r"'(?:[^']|'')*'")


def _sql_without_values(sql: str) -> str:
    """
    Запрос, на котором упал сервер, — без строковых значений. Они вшиты прямо
    в текст запроса, и среди них бывает то, что админу читать незачем: текст
    личного сообщения, код служебного аккаунта. Для разбора сбоя хватает формы
    запроса.
    """
    return _SQL_STRING.sub("'…'", sql)


@router.get('/logs')
async def list_logs(
    admin=Depends(auth_admin),
    kind: str = Query('back'),
    q: Optional[str] = Query(None, max_length=100),
    page: int = Query(1, ge=1, le=MAX_PAGE),
    page_size: int = Query(50, ge=1, le=100),
):
    if kind not in _LOGS:
        raise WarnException(400, f'kind должен быть одним из: {sorted(_LOGS)}')
    table, place, details, code, failed_sql = _LOGS[kind]

    conditions = []
    if q and q.strip():
        conditions.append(f"(e.message ILIKE {like(q)} OR {place} ILIKE {like(q)})")

    items = await query_db(f"""
        SELECT e.id, e.created_at, e.message, {place} AS place, {details} AS details,
               {code} AS code, {failed_sql} AS failed_sql, e.user_id, u.phone AS user_phone
        FROM {table} e
        LEFT JOIN users u ON u.id = e.user_id
        WHERE {where_sql(conditions)}
        ORDER BY e.id DESC
        {limit_offset(page, page_size)}
    """)
    for item in items:
        failed = item.pop('failed_sql')
        if failed:
            item['details'] = (f"{item['details']}\n\n" if item['details'] else '') + \
                              'Запрос (значения скрыты):\n' + _sql_without_values(failed)
    total = await query_db(f"SELECT COUNT(*)::int AS n FROM {table} e WHERE {where_sql(conditions)}")
    return paged(items, total[0]['n'], page, page_size)
