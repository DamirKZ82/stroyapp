"""
Заявки магазину или бригаде.

Клиент пишет, что нужно (comment), куда (address) и к какому сроку
(event_date — желаемая дата доставки или начала работ). Календаря
занятости нет: принятая заявка не закрывает дату для других.

    POST   /bookings                 — создать заявку (клиент или его мастер)
    GET    /bookings/my              — мои заявки (клиентские)
    GET    /bookings/ordered         — заявки, которые я оформил как мастер клиентов
    POST   /bookings/{guid}/approve  — подтвердить заявку мастера: уходит продавцу (клиент)
    POST   /bookings/{guid}/decline  — не подтверждать заявку мастера (клиент)
    GET    /bookings/incoming        — входящие заявки (по всем моим объявлениям)
    POST   /bookings/{guid}/confirm  — принять (владелец)
    POST   /bookings/{guid}/reject   — отклонить (владелец), нужен reason
    POST   /bookings/{guid}/cancel   — отменить заявку (клиент; мастер — пока её не подтвердили)
    GET    /bookings/{guid}          — детали

Заявка мастера (routers/r36_masters.py): мастер оформляет её от имени
клиента (client_id — клиент, ordered_by — мастер). Сначала она в статусе
'awaiting_client' и продавцу не видна: ни во входящих, ни в чате, ни в пуше.
Клиент подтверждает — она становится обычной 'pending' и уходит продавцу;
отказывается — 'declined'.
"""
import re
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, field_validator

from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from handlers.h03_auth import auth_user
from libs.common import fit_to_sql, new_guid
from libs.date import get_date_today, get_timestamp_now
from libs.fcm import send_push
from libs.ownership import get_provider_by_guid
from libs.text_filter import Clean
from routers.r36_masters import active_link_for_master
from services.peer_blocks import blocked_by_sql, either_blocked_sql, refusal


router = APIRouter()


DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
ALLOWED_STATUS_FILTERS = {'awaiting_client', 'pending', 'confirmed', 'rejected', 'cancelled',
                          'declined', 'withdrawn'}
# Заявки, которых продавец не видит: мастер оформил, а клиент ещё не
# подтвердил (awaiting_client), отказался (declined) или мастер отозвал
# заявку раньше (withdrawn). До продавца такие заявки не доходили.
HIDDEN_FROM_OWNER = ('awaiting_client', 'declined', 'withdrawn')
_NOT_HIDDEN_FROM_OWNER = "b.status NOT IN ('awaiting_client', 'declined', 'withdrawn')"

# «Клиент заблокировал владельца объявления» — колонка для запросов заявок,
# где есть bookings b и присоединены providers p. От неё зависит,
# дойдёт ли до клиента текст отказа: см. _booking_public.
_OWNER_BLOCKED_BY_CLIENT = blocked_by_sql('b.client_id', 'p.owner_id')

# Поля заявки и объявления для всех запросов ниже. LEFT JOIN: объявление
# могли удалить, а заявка остаётся в истории клиента.
_BOOKING_SELECT = """
    b.id, b.guid, b.provider_id, b.client_id, b.event_date,
    b.address, b.comment, b.status, b.rejected_reason,
    b.created_at, b.updated_at, b.ordered_by,
    p.name AS provider_name, p.guid AS provider_guid, p.owner_id,
    cat.code AS category_code, cat.kind AS category_kind,
    ob.full_name AS ordered_by_name, ob.phone AS ordered_by_phone
"""
_BOOKING_FROM = """
    FROM bookings b
    LEFT JOIN providers p    ON p.id = b.provider_id
    LEFT JOIN categories cat ON cat.id = p.category_id
    LEFT JOIN users ob       ON ob.id = b.ordered_by
"""


# -------------------------------------------------------------------------
# Pydantic модели
# -------------------------------------------------------------------------

class BookingCreateBody(BaseModel):
    provider_guid: str
    event_date: str
    address: Optional[Clean] = None
    comment: Optional[Clean] = None
    # Мастер оформляет заявку для своего клиента — guid их связи.
    master_link_guid: Optional[str] = None

    @field_validator('event_date')
    @classmethod
    def event_date_ok(cls, val):
        val = (val or '').strip()
        if not DATE_RE.match(val):
            raise ValueError('Некорректный формат даты. Ожидается YYYY-MM-DD')
        return val

    @field_validator('provider_guid')
    @classmethod
    def provider_ok(cls, val):
        val = (val or '').strip()
        if not val:
            raise ValueError('Не указано объявление')
        return val

    @field_validator('address')
    @classmethod
    def address_ok(cls, val):
        if val is None:
            return None
        val = val.strip()
        if len(val) > 500:
            raise ValueError('Адрес не должен быть длиннее 500 символов')
        return val or None

    @field_validator('comment')
    @classmethod
    def comment_ok(cls, val):
        if val is None:
            return None
        val = val.strip()
        if len(val) > 2000:
            raise ValueError('Комментарий не должен быть длиннее 2000 символов')
        return val or None


class BookingRejectBody(BaseModel):
    reason: Clean

    @field_validator('reason')
    @classmethod
    def reason_ok(cls, val):
        val = (val or '').strip()
        if not val:
            raise ValueError('Причина отклонения обязательна')
        if len(val) > 1000:
            raise ValueError('Причина не должна быть длиннее 1000 символов')
        return val


# -------------------------------------------------------------------------
# Хелперы
# -------------------------------------------------------------------------

async def _get_booking_by_guid(guid: str) -> Optional[dict]:
    rows = await query_db(f"""
        SELECT {_BOOKING_SELECT},
               {_OWNER_BLOCKED_BY_CLIENT} AS owner_blocked_by_client
        {_BOOKING_FROM}
        WHERE b.guid = {fit_to_sql(guid)}
    """)
    return rows[0] if rows else None


async def _booking_public(row: dict, for_client: bool = False) -> dict:
    """
    Срез заявки для приложения.

    for_client — заявку смотрит тот, кто её подал. Если он заблокировал
    владельца (services/peer_blocks), текст отказа ему не отдаём: причину
    владелец пишет сам, и иначе отказ по заявке оставался бы способом
    написать мимо блокировки. Сам текст хранится: владелец его видит, а
    клиент увидит, когда снимет блокировку.
    """
    deleted = not bool(row.get('provider_guid'))
    provider = None if deleted else {
        'id': row['provider_id'],
        'guid': row.get('provider_guid'),
        'name': row.get('provider_name'),
        'category_code': row.get('category_code'),
        'category_kind': row.get('category_kind'),
    }
    rejected_reason = row['rejected_reason']
    if for_client and row.get('owner_blocked_by_client'):
        rejected_reason = None
    return {
        'id': row['id'],
        'guid': row['guid'],
        'event_date': row['event_date'],
        'address': row['address'],
        'comment': row['comment'],
        'status': row['status'],
        'rejected_reason': rejected_reason,
        'created_at': row['created_at'],
        'updated_at': row['updated_at'],
        'provider': provider,
        'provider_deleted': deleted,
        # Кто оформил: мастер клиента. None — клиент сам.
        'ordered_by': None if not row.get('ordered_by') else {
            'name': row.get('ordered_by_name'),
            'phone': row.get('ordered_by_phone'),
        },
    }


def _notification_date(date_str: str) -> str:
    """Красивый вид даты для push-сообщения: '15 августа 2026'."""
    # Без сторонних локализаций — минималистичный вариант.
    months_ru = ['', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
    y, m, d = date_str.split('-')
    return f"{int(d)} {months_ru[int(m)]} {y}"


def rejection_push_body(booking: dict, reason: str) -> str:
    """
    Текст пуша клиенту об отказе. Причину владелец пишет сам, поэтому
    клиенту, который его заблокировал, она не уходит — только то, что
    заявка отклонена. Правило то же, что в _booking_public.
    """
    text = f"{booking['provider_name']}: {_notification_date(booking['event_date'])}"
    if booking.get('owner_blocked_by_client'):
        return text
    return f"{text}. Причина: {reason}"


# -------------------------------------------------------------------------
# Создание заявки
# -------------------------------------------------------------------------

@router.post('/bookings')
async def create_booking(body: BookingCreateBody, user=Depends(auth_user)):
    # Дата не в прошлом
    if body.event_date < get_date_today():
        raise WarnException(400, 'Дата не может быть в прошлом')

    provider = await get_provider_by_guid(body.provider_guid)
    if provider is None:
        raise WarnException(404, 'Объявление не найдено')
    if not provider['is_active']:
        raise WarnException(400, 'Объявление сейчас не принимает заявки')

    # Мастер оформляет от имени клиента: заявка — клиентская, мастер в
    # ordered_by, и до подтверждения клиентом продавец её не видит.
    client_id = user['id']
    ordered_by = None
    if body.master_link_guid:
        link = await active_link_for_master(body.master_link_guid, user['id'])
        client_id = link['client_id']
        ordered_by = user['id']
    status = 'awaiting_client' if ordered_by else 'pending'

    owner_id = provider['owner_id']
    if owner_id == client_id:
        raise WarnException(400, 'Это объявление самого клиента' if ordered_by
                            else 'Нельзя отправить заявку на своё объявление')

    # Одна активная заявка клиента на объявление: остальное — в чате.
    mine = await query_db(f"""
        SELECT status FROM bookings
        WHERE provider_id = {fit_to_sql(provider['id'])}
          AND client_id = {fit_to_sql(client_id)}
          AND status IN ('pending', 'awaiting_client')
    """)
    if mine:
        if mine[0]['status'] == 'awaiting_client':
            raise WarnException(400, 'В этот магазин уже есть заявка, которая ждёт подтверждения клиента')
        raise WarnException(400, 'У клиента уже есть заявка на рассмотрении у этого объявления' if ordered_by
                            else 'У вас уже есть заявка на рассмотрении у этого объявления')

    now = get_timestamp_now()
    guid = new_guid()
    # Заявка — тоже способ написать: в ней комментарий, она открывает чат и
    # шлёт владельцу пуш. Поэтому блокировка между клиентом и владельцем (в
    # любую сторону) закрывает и её. Проверяет сама вставка, как у сообщений:
    # запрос перед ней оставил бы щель.
    rows = await query_db(f"""
        INSERT INTO bookings (
            guid, provider_id, client_id, event_date, address,
            comment, status, ordered_by, created_at, updated_at
        )
        SELECT
            {fit_to_sql(guid)},
            {fit_to_sql(provider['id'])},
            {fit_to_sql(client_id)},
            {fit_to_sql(body.event_date)},
            {fit_to_sql(body.address)},
            {fit_to_sql(body.comment)},
            {fit_to_sql(status)},
            {fit_to_sql(ordered_by)},
            {fit_to_sql(now)},
            {fit_to_sql(now)}
        WHERE NOT {either_blocked_sql(fit_to_sql(client_id), fit_to_sql(owner_id))}
        RETURNING id
    """)
    if not rows:
        if ordered_by:
            # Чей это чёрный список — клиента или продавца, — мастеру знать незачем.
            raise WarnException(403, 'Этот магазин не принимает заявки от вашего клиента')
        raise await refusal(user['id'], owner_id, 'booking')

    booking = await _get_booking_by_guid(guid)
    if ordered_by:
        await send_push(
            user_id=client_id,
            title='Подтвердите покупку',
            body=f"{user['full_name'] or 'Мастер'}: {provider['name']}"
                 + (f" — {body.comment[:80]}" if body.comment else ''),
            data={'type': 'booking_awaiting_client', 'booking_guid': guid},
        )
    else:
        await _deliver_to_owner(booking)
    return {'booking': await _booking_public(booking)}


async def _deliver_to_owner(booking: dict) -> None:
    """
    Заявка ушла продавцу: чат между клиентом и объявлением и пуш владельцу.
    Заявка мастера уходит в момент, когда её подтвердил клиент.
    """
    now = get_timestamp_now()
    # Один чат между клиентом и объявлением.
    # Если уже есть — прикрепляем booking_id; иначе создаём.
    existing = await query_db(f"""
        SELECT id FROM chats
        WHERE provider_id = {fit_to_sql(booking['provider_id'])}
          AND client_id = {fit_to_sql(booking['client_id'])}
    """)
    if existing:
        await query_db(f"""
            UPDATE chats
            SET booking_id = {fit_to_sql(booking['id'])}
            WHERE id = {fit_to_sql(existing[0]['id'])}
        """)
    else:
        await query_db(f"""
            INSERT INTO chats (guid, provider_id, client_id, owner_id, booking_id, created_at)
            VALUES (
                {fit_to_sql(new_guid())},
                {fit_to_sql(booking['provider_id'])},
                {fit_to_sql(booking['client_id'])},
                {fit_to_sql(booking['owner_id'])},
                {fit_to_sql(booking['id'])},
                {fit_to_sql(now)}
            )
        """)

    # Пуш владельцу: "Новая заявка..."
    await send_push(
        user_id=booking['owner_id'],
        title='Новая заявка',
        body=f"{booking['provider_name']}: к {_notification_date(booking['event_date'])}",
        data={'type': 'new_booking', 'booking_guid': booking['guid']},
    )


async def _push_master(booking: dict, title: str) -> None:
    """Мастеру, оформившему заявку, — о том, что с ней стало."""
    if booking.get('ordered_by'):
        await send_push(
            user_id=booking['ordered_by'],
            title=title,
            body=f"{booking['provider_name']}: к {_notification_date(booking['event_date'])}",
            data={'type': 'ordered_booking', 'booking_guid': booking['guid']},
        )


# -------------------------------------------------------------------------
# Списки
# -------------------------------------------------------------------------

def _status_where(status_filter: Optional[str], prefix: str = 'b') -> str:
    """Вернёт пустую строку или AND-кусок для статуса."""
    if not status_filter:
        return ''
    if status_filter not in ALLOWED_STATUS_FILTERS:
        raise WarnException(400, f'status должен быть одним из: {sorted(ALLOWED_STATUS_FILTERS)}')
    return f" AND {prefix}.status = {fit_to_sql(status_filter)}"


@router.get('/bookings/my')
async def my_bookings(
    status: Optional[str] = Query(None),
    user=Depends(auth_user),
):
    """Заявки, которые подал текущий юзер."""
    status_clause = _status_where(status)
    rows = await query_db(f"""
        SELECT {_BOOKING_SELECT},
               {_OWNER_BLOCKED_BY_CLIENT} AS owner_blocked_by_client
        {_BOOKING_FROM}
        WHERE b.client_id = {fit_to_sql(user['id'])}
          {status_clause}
        ORDER BY b.id DESC
    """)
    return {'items': [await _booking_public(r, for_client=True) for r in rows]}


@router.get('/bookings/ordered')
async def ordered_bookings(user=Depends(auth_user)):
    """Заявки, которые я оформил как мастер, — с тем, для кого."""
    rows = await query_db(f"""
        SELECT {_BOOKING_SELECT},
               {_OWNER_BLOCKED_BY_CLIENT} AS owner_blocked_by_client,
               u.full_name AS client_name, u.phone AS client_phone
        {_BOOKING_FROM}
        LEFT JOIN users u ON u.id = b.client_id
        WHERE b.ordered_by = {fit_to_sql(user['id'])}
        ORDER BY b.id DESC
        LIMIT 200
    """)
    items = []
    for r in rows:
        # Текст отказа — по тем же правилам, что у клиента: если клиент
        # заблокировал продавца, мимо блокировки он не дойдёт и через мастера.
        pub = await _booking_public(r, for_client=True)
        pub['client'] = {'name': r['client_name'], 'phone': r['client_phone']}
        items.append(pub)
    return {'items': items}


@router.get('/bookings/incoming')
async def incoming_bookings(
    status: Optional[str] = Query(None),
    user=Depends(auth_user),
):
    """Заявки на все объявления текущего юзера (для владельца)."""
    status_clause = _status_where(status)
    rows = await query_db(f"""
        SELECT {_BOOKING_SELECT},
               u.full_name AS client_name, u.phone AS client_phone
        {_BOOKING_FROM}
        LEFT JOIN users u ON u.id = b.client_id
        WHERE p.owner_id = {fit_to_sql(user['id'])}
          AND {_NOT_HIDDEN_FROM_OWNER}
          {status_clause}
        ORDER BY b.id DESC
    """)
    items = []
    for r in rows:
        pub = await _booking_public(r)
        # Для входящих показываем данные клиента — у владельца легитимная причина их видеть
        pub['client'] = {
            'name': r['client_name'],
            'phone': r['client_phone'],
        }
        items.append(pub)
    return {'items': items}


# -------------------------------------------------------------------------
# Действия над заявкой
# -------------------------------------------------------------------------

@router.post('/bookings/{guid}/confirm')
async def confirm_booking(guid: str, user=Depends(auth_user)):
    booking = await _get_booking_by_guid(guid)
    if booking is None:
        raise WarnException(404, 'Заявка не найдена')
    if booking['owner_id'] != user['id']:
        raise WarnException(403, 'Недостаточно прав')
    if booking['status'] != 'pending':
        raise WarnException(400, f"Нельзя подтвердить заявку в статусе '{booking['status']}'")

    now = get_timestamp_now()
    await query_db(f"""
        UPDATE bookings
           SET status = 'confirmed',
               updated_at = {fit_to_sql(now)}
         WHERE id = {fit_to_sql(booking['id'])}
    """)

    await send_push(
        user_id=booking['client_id'],
        title='Заявка принята',
        body=f"{booking['provider_name']}: к {_notification_date(booking['event_date'])}",
        data={'type': 'booking_confirmed', 'booking_guid': guid},
    )
    await _push_master(booking, 'Магазин принял заявку')

    fresh = await _get_booking_by_guid(guid)
    return {'booking': await _booking_public(fresh)}


@router.post('/bookings/{guid}/reject')
async def reject_booking(guid: str, body: BookingRejectBody, user=Depends(auth_user)):
    booking = await _get_booking_by_guid(guid)
    if booking is None:
        raise WarnException(404, 'Заявка не найдена')
    if booking['owner_id'] != user['id']:
        raise WarnException(403, 'Недостаточно прав')
    if booking['status'] not in ('pending', 'confirmed'):
        raise WarnException(400, f"Нельзя отклонить заявку в статусе '{booking['status']}'")

    now = get_timestamp_now()
    await query_db(f"""
        UPDATE bookings
           SET status = 'rejected',
               rejected_reason = {fit_to_sql(body.reason)},
               updated_at = {fit_to_sql(now)}
         WHERE id = {fit_to_sql(booking['id'])}
    """)

    await send_push(
        user_id=booking['client_id'],
        title='Заявка отклонена',
        body=rejection_push_body(booking, body.reason),
        data={'type': 'booking_rejected', 'booking_guid': guid},
    )
    await _push_master(booking, 'Магазин отклонил заявку')

    fresh = await _get_booking_by_guid(guid)
    return {'booking': await _booking_public(fresh)}


@router.post('/bookings/{guid}/cancel')
async def cancel_booking(guid: str, user=Depends(auth_user)):
    booking = await _get_booking_by_guid(guid)
    if booking is None:
        raise WarnException(404, 'Заявка не найдена')
    is_client = booking['client_id'] == user['id']
    # Мастер может отозвать свою заявку, пока клиент её не подтвердил. Дальше
    # она клиентская, и отменяет её клиент.
    is_master = booking['ordered_by'] == user['id'] and booking['status'] == 'awaiting_client'
    if not is_client and not is_master:
        raise WarnException(403, 'Недостаточно прав')
    if booking['status'] not in ('pending', 'confirmed', 'awaiting_client'):
        raise WarnException(400, f"Нельзя отменить заявку в статусе '{booking['status']}'")

    was_confirmed = booking['status'] == 'confirmed'
    # Заявку мастера, не дошедшую до продавца, «отменённой» у продавца не
    # показываем: клиент — значит не подтвердил, мастер — отозвал.
    if booking['status'] == 'awaiting_client':
        new_status = 'declined' if is_client else 'withdrawn'
    else:
        new_status = 'cancelled'
    now = get_timestamp_now()
    await query_db(f"""
        UPDATE bookings
           SET status = {fit_to_sql(new_status)},
               updated_at = {fit_to_sql(now)}
         WHERE id = {fit_to_sql(booking['id'])}
    """)

    # Пуш владельцу только если отменили принятую: под неё уже планировали.
    if was_confirmed:
        await send_push(
            user_id=booking['owner_id'],
            title='Клиент отменил заявку',
            body=f"{booking['provider_name']}: к {_notification_date(booking['event_date'])}",
            data={'type': 'booking_cancelled', 'booking_guid': guid},
        )
    if is_client:
        await _push_master(booking, 'Клиент не подтвердил покупку' if new_status == 'declined'
                           else 'Клиент отменил заявку')

    fresh = await _get_booking_by_guid(guid)
    return {'booking': await _booking_public(fresh, for_client=True)}


async def _awaiting_for_client(guid: str, user: dict) -> dict:
    booking = await _get_booking_by_guid(guid)
    if booking is None or booking['client_id'] != user['id']:
        raise WarnException(404, 'Заявка не найдена')
    if booking['status'] != 'awaiting_client':
        raise WarnException(400, 'Эта заявка уже не ждёт подтверждения')
    return booking


@router.post('/bookings/{guid}/approve')
async def approve_booking(guid: str, user=Depends(auth_user)):
    """Клиент подтверждает заявку мастера: она уходит продавцу."""
    booking = await _awaiting_for_client(guid, user)
    # Пока заявка ждала, объявление могли снять с публикации, а у клиента —
    # появиться своя заявка туда же.
    provider = await get_provider_by_guid(booking['provider_guid']) if booking['provider_guid'] else None
    if provider is None or not provider['is_active']:
        raise WarnException(400, 'Объявление сейчас не принимает заявки')
    mine = await query_db(f"""
        SELECT id FROM bookings
        WHERE provider_id = {fit_to_sql(booking['provider_id'])}
          AND client_id = {fit_to_sql(user['id'])} AND status = 'pending'
    """)
    if mine:
        raise WarnException(400, 'У вас уже есть заявка на рассмотрении у этого объявления')
    now = get_timestamp_now()
    # Блокировку проверяет сама запись: за время ожидания её могли поставить.
    rows = await query_db(f"""
        UPDATE bookings
           SET status = 'pending', updated_at = {fit_to_sql(now)}
         WHERE id = {fit_to_sql(booking['id'])} AND status = 'awaiting_client'
           AND NOT {either_blocked_sql(fit_to_sql(user['id']), fit_to_sql(booking['owner_id']))}
        RETURNING id
    """)
    if not rows:
        fresh = await _get_booking_by_guid(guid)
        if fresh['status'] != 'awaiting_client':
            raise WarnException(400, 'Эта заявка уже не ждёт подтверждения')
        raise await refusal(user['id'], booking['owner_id'], 'booking')
    fresh = await _get_booking_by_guid(guid)
    await _deliver_to_owner(fresh)
    await _push_master(fresh, 'Клиент подтвердил покупку')
    return {'booking': await _booking_public(fresh, for_client=True)}


@router.post('/bookings/{guid}/decline')
async def decline_booking(guid: str, user=Depends(auth_user)):
    """Клиент не подтверждает заявку мастера: продавец её так и не увидит."""
    booking = await _awaiting_for_client(guid, user)
    await query_db(f"""
        UPDATE bookings
           SET status = 'declined', updated_at = {fit_to_sql(get_timestamp_now())}
         WHERE id = {fit_to_sql(booking['id'])} AND status = 'awaiting_client'
    """)
    fresh = await _get_booking_by_guid(guid)
    await _push_master(fresh, 'Клиент не подтвердил покупку')
    return {'booking': await _booking_public(fresh, for_client=True)}


# -------------------------------------------------------------------------
# Детали одной заявки.
# Видеть её может только клиент (создатель) или владелец объявления.
# -------------------------------------------------------------------------

@router.get('/bookings/{guid}')
async def get_booking(guid: str, user=Depends(auth_user)):
    booking = await _get_booking_by_guid(guid)
    if booking is None:
        raise WarnException(404, 'Заявка не найдена')
    is_owner = booking['owner_id'] == user['id'] and booking['status'] not in HIDDEN_FROM_OWNER
    if booking['client_id'] != user['id'] and booking['ordered_by'] != user['id'] and not is_owner:
        # Заявку мастера, которую клиент ещё не подтвердил, продавец не видит
        # и по прямой ссылке: для него её пока нет.
        if booking['owner_id'] == user['id']:
            raise WarnException(404, 'Заявка не найдена')
        raise WarnException(403, 'Недостаточно прав')

    # Если просмотр от владельца — добавим данные клиента (имя + телефон).
    # Если от клиента — данных клиента не показываем (они и так его собственные).
    public = await _booking_public(booking, for_client=booking['client_id'] == user['id'])
    if is_owner or booking['ordered_by'] == user['id']:
        client_rows = await query_db(f"""
            SELECT full_name, phone FROM users
            WHERE id = {fit_to_sql(booking['client_id'])}
        """)
        if client_rows:
            public['client'] = {
                'name': client_rows[0]['full_name'],
                'phone': client_rows[0]['phone'],
            }
    return {'booking': public}
