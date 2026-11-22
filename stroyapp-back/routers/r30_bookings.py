"""
Заявки магазину или бригаде.

Клиент пишет, что нужно (comment), куда (address) и к какому сроку
(event_date — желаемая дата доставки или начала работ). Календаря
занятости нет: принятая заявка не закрывает дату для других.

    POST   /bookings                 — создать заявку (клиент)
    GET    /bookings/my              — мои заявки (клиентские)
    GET    /bookings/incoming        — входящие заявки (по всем моим объявлениям)
    POST   /bookings/{guid}/confirm  — принять (владелец)
    POST   /bookings/{guid}/reject   — отклонить (владелец), нужен reason
    POST   /bookings/{guid}/cancel   — отменить свою заявку (клиент)
    GET    /bookings/{guid}          — детали
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
from services.peer_blocks import blocked_by_sql, either_blocked_sql, refusal


router = APIRouter()


DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
ALLOWED_STATUS_FILTERS = {'pending', 'confirmed', 'rejected', 'cancelled'}

# «Клиент заблокировал владельца объявления» — колонка для запросов заявок,
# где есть bookings b и присоединены providers p. От неё зависит,
# дойдёт ли до клиента текст отказа: см. _booking_public.
_OWNER_BLOCKED_BY_CLIENT = blocked_by_sql('b.client_id', 'p.owner_id')

# Поля заявки и объявления для всех запросов ниже. LEFT JOIN: объявление
# могли удалить, а заявка остаётся в истории клиента.
_BOOKING_SELECT = """
    b.id, b.guid, b.provider_id, b.client_id, b.event_date,
    b.address, b.comment, b.status, b.rejected_reason,
    b.created_at, b.updated_at,
    p.name AS provider_name, p.guid AS provider_guid, p.owner_id,
    cat.code AS category_code, cat.kind AS category_kind
"""
_BOOKING_FROM = """
    FROM bookings b
    LEFT JOIN providers p    ON p.id = b.provider_id
    LEFT JOIN categories cat ON cat.id = p.category_id
"""


# -------------------------------------------------------------------------
# Pydantic модели
# -------------------------------------------------------------------------

class BookingCreateBody(BaseModel):
    provider_guid: str
    event_date: str
    address: Optional[Clean] = None
    comment: Optional[Clean] = None

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

    owner_id = provider['owner_id']
    if owner_id == user['id']:
        raise WarnException(400, 'Нельзя отправить заявку на своё объявление')

    # Одна активная заявка клиента на объявление: остальное — в чате.
    mine = await query_db(f"""
        SELECT id FROM bookings
        WHERE provider_id = {fit_to_sql(provider['id'])}
          AND client_id = {fit_to_sql(user['id'])}
          AND status = 'pending'
    """)
    if mine:
        raise WarnException(400, 'У вас уже есть заявка на рассмотрении у этого объявления')

    now = get_timestamp_now()
    guid = new_guid()
    # Заявка — тоже способ написать: в ней комментарий, она открывает чат и
    # шлёт владельцу пуш. Поэтому блокировка между клиентом и владельцем (в
    # любую сторону) закрывает и её. Проверяет сама вставка, как у сообщений:
    # запрос перед ней оставил бы щель.
    rows = await query_db(f"""
        INSERT INTO bookings (
            guid, provider_id, client_id, event_date, address,
            comment, status, created_at, updated_at
        )
        SELECT
            {fit_to_sql(guid)},
            {fit_to_sql(provider['id'])},
            {fit_to_sql(user['id'])},
            {fit_to_sql(body.event_date)},
            {fit_to_sql(body.address)},
            {fit_to_sql(body.comment)},
            'pending',
            {fit_to_sql(now)},
            {fit_to_sql(now)}
        WHERE NOT {either_blocked_sql(fit_to_sql(user['id']), fit_to_sql(owner_id))}
        RETURNING id
    """)
    if not rows:
        raise await refusal(user['id'], owner_id, 'booking')

    booking = await _get_booking_by_guid(guid)

    # Один чат между клиентом и объявлением.
    # Если уже есть — прикрепляем booking_id; иначе создаём.
    existing = await query_db(f"""
        SELECT id FROM chats
        WHERE provider_id = {fit_to_sql(provider['id'])}
          AND client_id = {fit_to_sql(user['id'])}
    """)
    if existing:
        await query_db(f"""
            UPDATE chats
            SET booking_id = {fit_to_sql(booking['id'])}
            WHERE id = {fit_to_sql(existing[0]['id'])}
        """)
    else:
        chat_guid = new_guid()
        await query_db(f"""
            INSERT INTO chats (guid, provider_id, client_id, owner_id, booking_id, created_at)
            VALUES (
                {fit_to_sql(chat_guid)},
                {fit_to_sql(provider['id'])},
                {fit_to_sql(user['id'])},
                {fit_to_sql(owner_id)},
                {fit_to_sql(booking['id'])},
                {fit_to_sql(now)}
            )
        """)

    # Пуш владельцу: "Новая заявка..."
    await send_push(
        user_id=owner_id,
        title='Новая заявка',
        body=f"{provider['name']}: к {_notification_date(body.event_date)}",
        data={'type': 'new_booking', 'booking_guid': guid},
    )

    return {'booking': await _booking_public(booking)}


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

    fresh = await _get_booking_by_guid(guid)
    return {'booking': await _booking_public(fresh)}


@router.post('/bookings/{guid}/cancel')
async def cancel_booking(guid: str, user=Depends(auth_user)):
    booking = await _get_booking_by_guid(guid)
    if booking is None:
        raise WarnException(404, 'Заявка не найдена')
    if booking['client_id'] != user['id']:
        raise WarnException(403, 'Недостаточно прав')
    if booking['status'] not in ('pending', 'confirmed'):
        raise WarnException(400, f"Нельзя отменить заявку в статусе '{booking['status']}'")

    was_confirmed = booking['status'] == 'confirmed'
    now = get_timestamp_now()
    await query_db(f"""
        UPDATE bookings
           SET status = 'cancelled',
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

    fresh = await _get_booking_by_guid(guid)
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
    if booking['client_id'] != user['id'] and booking['owner_id'] != user['id']:
        raise WarnException(403, 'Недостаточно прав')

    # Если просмотр от владельца — добавим данные клиента (имя + телефон).
    # Если от клиента — данных клиента не показываем (они и так его собственные).
    public = await _booking_public(booking, for_client=booking['client_id'] == user['id'])
    if booking['owner_id'] == user['id']:
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
