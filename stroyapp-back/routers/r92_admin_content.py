"""
Админка: объявления, отзывы, заявки.

    GET    /admin/api/halls                     залы: поиск, город, статус
    GET    /admin/api/halls/{id}                зал целиком: фото, удобства, заведение
    POST   /admin/api/halls/{id}/hide           скрыть из поиска (причина обязательна)
    POST   /admin/api/halls/{id}/unhide         вернуть
    POST   /admin/api/venues/{id}/hide          скрыть заведение со всеми залами
    POST   /admin/api/venues/{id}/unhide
    DELETE /admin/api/hall-photos/{id}          удалить одно фото
    GET    /admin/api/providers                 исполнители: поиск, категория, город, статус
    GET    /admin/api/providers/{id}
    POST   /admin/api/providers/{id}/hide
    POST   /admin/api/providers/{id}/unhide
    DELETE /admin/api/provider-photos/{id}
    GET    /admin/api/reviews                   отзывы: поиск, оценка
    DELETE /admin/api/reviews/{id}
    GET    /admin/api/bookings                  заявки, только просмотр

Скрыть — не удалить: объявление пропадает из поиска и перестаёт принимать
заявки, но остаётся у владельца, и вернуть его можно одним нажатием. Насовсем
объявления удаляет владелец или админ вместе с аккаунтом (DELETE /users/{id}).
"""
from typing import Optional

from fastapi import APIRouter, Depends, Query

from connections.connect_postgres import query_db, transaction
from handlers.h01_errors import WarnException
from handlers.h03_auth import auth_admin
from libs.admin_query import MAX_PAGE, like, limit_offset, paged, phone_match, where_sql
from libs.common import fit_to_sql
from libs.date import get_timestamp_now
from libs.photos import delete_photo_files
from routers.r91_admin_users import ReasonBody
from services.admin_listings import (
    HALL_STATUS_FILTER,
    PROVIDER_STATUS_FILTER,
    count_halls,
    count_providers,
    fetch_halls,
    fetch_providers,
)
from services.moderation import hide_listing, listing_subject, log_action, unhide_listing


router = APIRouter(prefix='/admin/api')

BOOKING_STATUSES = ('pending', 'confirmed', 'rejected', 'cancelled')


def _check_status(status: str, allowed: dict) -> None:
    if status != 'all' and status not in allowed:
        raise WarnException(400, f"status должен быть одним из: {['all'] + sorted(allowed)}")


# -------------------------------------------------------------------------
# Залы и заведения
# -------------------------------------------------------------------------

@router.get('/halls')
async def list_halls(
    admin=Depends(auth_admin),
    q: Optional[str] = Query(None, max_length=100),
    city_id: Optional[int] = Query(None),
    status: str = Query('all'),
    page: int = Query(1, ge=1, le=MAX_PAGE),
    page_size: int = Query(30, ge=1, le=100),
):
    _check_status(status, HALL_STATUS_FILTER)
    conditions = []
    if status != 'all':
        conditions.append(HALL_STATUS_FILTER[status])
    if city_id is not None:
        conditions.append(f'v.city_id = {fit_to_sql(city_id)}')
    if q and q.strip():
        conditions.append(f"""(h.name ILIKE {like(q)} OR v.name ILIKE {like(q)}
                               OR v.address ILIKE {like(q)} OR {phone_match('u.phone', q)}
                               OR u.full_name ILIKE {like(q)})""")
    items = await fetch_halls(conditions, page, page_size)
    return paged(items, await count_halls(conditions), page, page_size)


@router.get('/halls/{hall_id}')
async def get_hall(hall_id: int, admin=Depends(auth_admin)):
    found = await fetch_halls([f'h.id = {fit_to_sql(hall_id)}'])
    if not found:
        raise WarnException(404, 'Зал не найден')
    hall = found[0]
    hid = fit_to_sql(hall_id)

    more = await query_db(f"""
        SELECT h.description, h.area_sqm, h.updated_at,
               v.description AS venue_description, v.phone AS venue_phone,
               v.latitude::float AS latitude, v.longitude::float AS longitude,
               (SELECT COUNT(*) FROM halls x WHERE x.venue_id = v.id)::int AS venue_halls
        FROM halls h
        JOIN venues v ON v.id = h.venue_id
        WHERE h.id = {hid}
    """)
    hall.update(more[0])
    hall['photo_list'] = await query_db(f"""
        SELECT id, file_path, thumb_path FROM hall_photos
        WHERE hall_id = {hid} ORDER BY sort_order, id
    """)
    amenities = await query_db(f"""
        SELECT a.name_ru FROM hall_amenity_links l
        JOIN hall_amenities a ON a.id = l.amenity_id
        WHERE l.hall_id = {hid} ORDER BY a.id
    """)
    hall['amenities'] = [a['name_ru'] for a in amenities]
    counts = await query_db(f"""
        SELECT
            (SELECT COUNT(*) FROM bookings WHERE hall_id = {hid})::int AS bookings,
            (SELECT COUNT(*) FROM reviews WHERE hall_id = {hid})::int AS reviews,
            (SELECT COALESCE(AVG(rating), 0)::float FROM reviews WHERE hall_id = {hid}) AS rating,
            (SELECT COUNT(*) FROM complaints WHERE target_type = 'hall' AND target_id = {hid})::int AS complaints,
            (SELECT COUNT(*) FROM complaints WHERE target_type = 'hall' AND target_id = {hid}
                AND status = 'new')::int AS complaints_new
    """)
    hall['counts'] = counts[0]
    hall['counts']['rating'] = round(hall['counts']['rating'], 2)
    return {'hall': hall}


# kind — 'hall' | 'venue' | 'provider'; действие в журнале зовётся так же:
# hall_hide, venue_unhide и т.д.

async def _hide(kind: str, listing_id: int, reason: str, admin: dict) -> dict:
    subject = await listing_subject(kind, listing_id)
    await hide_listing(kind, listing_id, reason)
    await log_action(admin, f'{kind}_hide', kind, listing_id, subject['name'], reason,
                     subjects=[subject['owner_id']])
    return {'ok': True}


async def _unhide(kind: str, listing_id: int, admin: dict) -> dict:
    subject = await listing_subject(kind, listing_id)
    await unhide_listing(kind, listing_id)
    await log_action(admin, f'{kind}_unhide', kind, listing_id, subject['name'],
                     subjects=[subject['owner_id']])
    return {'ok': True}


@router.post('/halls/{hall_id}/hide')
async def hide_hall(hall_id: int, body: ReasonBody, admin=Depends(auth_admin)):
    return await _hide('hall', hall_id, body.reason, admin)


@router.post('/halls/{hall_id}/unhide')
async def unhide_hall(hall_id: int, admin=Depends(auth_admin)):
    return await _unhide('hall', hall_id, admin)


@router.post('/venues/{venue_id}/hide')
async def hide_venue(venue_id: int, body: ReasonBody, admin=Depends(auth_admin)):
    return await _hide('venue', venue_id, body.reason, admin)


@router.post('/venues/{venue_id}/unhide')
async def unhide_venue(venue_id: int, admin=Depends(auth_admin)):
    return await _unhide('venue', venue_id, admin)


@router.delete('/hall-photos/{photo_id}')
async def delete_hall_photo(photo_id: int, admin=Depends(auth_admin)):
    rows = await query_db(f"""
        SELECT hp.file_path, hp.thumb_path, h.id AS hall_id, h.name, v.owner_id
        FROM hall_photos hp
        JOIN halls h ON h.id = hp.hall_id
        JOIN venues v ON v.id = h.venue_id
        WHERE hp.id = {fit_to_sql(photo_id)}
    """)
    if not rows:
        raise WarnException(404, 'Фото не найдено')
    photo = rows[0]
    await query_db(f"DELETE FROM hall_photos WHERE id = {fit_to_sql(photo_id)}")
    delete_photo_files(photo['file_path'], photo['thumb_path'])
    await log_action(admin, 'photo_delete', 'hall', photo['hall_id'], photo['name'], photo['file_path'],
                     subjects=[photo['owner_id']])
    return {'deleted': True}


# -------------------------------------------------------------------------
# Исполнители
# -------------------------------------------------------------------------

@router.get('/providers')
async def list_providers(
    admin=Depends(auth_admin),
    q: Optional[str] = Query(None, max_length=100),
    category_id: Optional[int] = Query(None),
    city_id: Optional[int] = Query(None),
    status: str = Query('all'),
    page: int = Query(1, ge=1, le=MAX_PAGE),
    page_size: int = Query(30, ge=1, le=100),
):
    _check_status(status, PROVIDER_STATUS_FILTER)
    conditions = []
    if status != 'all':
        conditions.append(PROVIDER_STATUS_FILTER[status])
    if category_id is not None:
        conditions.append(f'p.category_id = {fit_to_sql(category_id)}')
    if city_id is not None:
        conditions.append(f'p.city_id = {fit_to_sql(city_id)}')
    if q and q.strip():
        conditions.append(f"""(p.name ILIKE {like(q)} OR {phone_match('u.phone', q)}
                               OR u.full_name ILIKE {like(q)})""")
    items = await fetch_providers(conditions, page, page_size)
    return paged(items, await count_providers(conditions), page, page_size)


@router.get('/providers/{provider_id}')
async def get_provider(provider_id: int, admin=Depends(auth_admin)):
    found = await fetch_providers([f'p.id = {fit_to_sql(provider_id)}'])
    if not found:
        raise WarnException(404, 'Исполнитель не найден')
    provider = found[0]
    pid = fit_to_sql(provider_id)

    more = await query_db(f"""
        SELECT description, phone, latitude::float AS latitude, longitude::float AS longitude, updated_at
        FROM providers WHERE id = {pid}
    """)
    provider.update(more[0])
    provider['photo_list'] = await query_db(f"""
        SELECT id, file_path, thumb_path FROM provider_photos
        WHERE provider_id = {pid} ORDER BY sort_order, id
    """)
    attrs = await query_db(f"""
        SELECT t.name_ru FROM provider_attr_links l
        JOIN provider_attr_types t ON t.id = l.attr_id
        WHERE l.provider_id = {pid} ORDER BY t.sort_order, t.id
    """)
    provider['attrs'] = [a['name_ru'] for a in attrs]
    counts = await query_db(f"""
        SELECT
            (SELECT COUNT(*) FROM bookings WHERE provider_id = {pid})::int AS bookings,
            (SELECT COUNT(*) FROM reviews WHERE provider_id = {pid})::int AS reviews,
            (SELECT COALESCE(AVG(rating), 0)::float FROM reviews WHERE provider_id = {pid}) AS rating,
            (SELECT COUNT(*) FROM complaints WHERE target_type = 'provider' AND target_id = {pid})::int AS complaints,
            (SELECT COUNT(*) FROM complaints WHERE target_type = 'provider' AND target_id = {pid}
                AND status = 'new')::int AS complaints_new
    """)
    provider['counts'] = counts[0]
    provider['counts']['rating'] = round(provider['counts']['rating'], 2)
    return {'provider': provider}


@router.post('/providers/{provider_id}/hide')
async def hide_provider(provider_id: int, body: ReasonBody, admin=Depends(auth_admin)):
    return await _hide('provider', provider_id, body.reason, admin)


@router.post('/providers/{provider_id}/unhide')
async def unhide_provider(provider_id: int, admin=Depends(auth_admin)):
    return await _unhide('provider', provider_id, admin)


@router.delete('/provider-photos/{photo_id}')
async def delete_provider_photo(photo_id: int, admin=Depends(auth_admin)):
    rows = await query_db(f"""
        SELECT pp.file_path, pp.thumb_path, p.id AS provider_id, p.name, p.owner_id
        FROM provider_photos pp
        JOIN providers p ON p.id = pp.provider_id
        WHERE pp.id = {fit_to_sql(photo_id)}
    """)
    if not rows:
        raise WarnException(404, 'Фото не найдено')
    photo = rows[0]
    await query_db(f"DELETE FROM provider_photos WHERE id = {fit_to_sql(photo_id)}")
    delete_photo_files(photo['file_path'], photo['thumb_path'])
    await log_action(admin, 'photo_delete', 'provider', photo['provider_id'], photo['name'], photo['file_path'],
                     subjects=[photo['owner_id']])
    return {'deleted': True}


# -------------------------------------------------------------------------
# Отзывы
# -------------------------------------------------------------------------

_REVIEW_FROM = """
    FROM reviews r
    JOIN users u ON u.id = r.client_id
    LEFT JOIN halls h ON h.id = r.hall_id
    LEFT JOIN venues v ON v.id = h.venue_id
    LEFT JOIN providers p ON p.id = r.provider_id
"""


@router.get('/reviews')
async def list_reviews(
    admin=Depends(auth_admin),
    q: Optional[str] = Query(None, max_length=100),
    rating: Optional[int] = Query(None, ge=1, le=5),
    page: int = Query(1, ge=1, le=MAX_PAGE),
    page_size: int = Query(30, ge=1, le=100),
):
    conditions = []
    if rating is not None:
        conditions.append(f'r.rating = {fit_to_sql(rating)}')
    if q and q.strip():
        conditions.append(f"""(r.text ILIKE {like(q)} OR r.owner_reply ILIKE {like(q)}
                               OR h.name ILIKE {like(q)} OR p.name ILIKE {like(q)}
                               OR {phone_match('u.phone', q)} OR u.full_name ILIKE {like(q)})""")
    items = await query_db(f"""
        SELECT r.id, r.rating, r.text, r.owner_reply, r.created_at,
               u.id AS author_id, u.phone AS author_phone, u.full_name AS author_name,
               r.hall_id, r.provider_id,
               COALESCE(h.name, p.name) AS subject, v.name AS venue_name
        {_REVIEW_FROM}
        WHERE {where_sql(conditions)}
        ORDER BY r.id DESC
        {limit_offset(page, page_size)}
    """)
    total = await query_db(f"SELECT COUNT(*)::int AS n {_REVIEW_FROM} WHERE {where_sql(conditions)}")
    return paged(items, total[0]['n'], page, page_size)


@router.delete('/reviews/{review_id}')
async def delete_review(review_id: int, admin=Depends(auth_admin)):
    rows = await query_db(f"""
        SELECT r.id, r.rating, r.text, r.booking_id,
               u.id AS author_id, u.phone AS author_phone,
               COALESCE(h.name, p.name) AS subject,
               COALESCE(v.owner_id, p.owner_id) AS owner_id
        {_REVIEW_FROM}
        WHERE r.id = {fit_to_sql(review_id)}
    """)
    if not rows:
        raise WarnException(404, 'Отзыв не найден')
    review = rows[0]
    async with transaction() as tx:
        # Отметка на заявке: отзыв на заявку один, и приложение проверяет лишь,
        # есть ли он. Без отметки автор тут же написал бы удалённое заново.
        await tx.query(f"""
            UPDATE bookings SET review_removed_at = {fit_to_sql(get_timestamp_now())}
             WHERE id = {fit_to_sql(review['booking_id'])}
        """)
        await tx.query(f"DELETE FROM reviews WHERE id = {fit_to_sql(review_id)}")
    # В журнале остаётся сам текст: удалённый отзыв больше негде посмотреть.
    # Это данные и автора, и владельца объявления — запись обезличится, когда
    # любой из них удалит аккаунт.
    await log_action(
        admin, 'review_delete', 'review', review_id,
        f"{review['subject']} — {review['author_phone']}",
        f"{review['rating']}★ {review['text'] or ''}".strip(),
        subjects=[review['author_id'], review['owner_id']],
    )
    return {'deleted': True}


# -------------------------------------------------------------------------
# Заявки (только просмотр)
# -------------------------------------------------------------------------

_BOOKING_FROM = """
    FROM bookings b
    JOIN users u ON u.id = b.client_id
    LEFT JOIN halls h ON h.id = b.hall_id
    LEFT JOIN venues v ON v.id = h.venue_id
    LEFT JOIN providers p ON p.id = b.provider_id
    LEFT JOIN event_types et ON et.id = b.event_type_id
"""


@router.get('/bookings')
async def list_bookings(
    admin=Depends(auth_admin),
    q: Optional[str] = Query(None, max_length=100),
    status: str = Query('all'),
    page: int = Query(1, ge=1, le=MAX_PAGE),
    page_size: int = Query(30, ge=1, le=100),
):
    if status != 'all' and status not in BOOKING_STATUSES:
        raise WarnException(400, f"status должен быть одним из: {['all', *BOOKING_STATUSES]}")
    conditions = []
    if status != 'all':
        conditions.append(f'b.status = {fit_to_sql(status)}')
    if q and q.strip():
        conditions.append(f"""(h.name ILIKE {like(q)} OR v.name ILIKE {like(q)} OR p.name ILIKE {like(q)}
                               OR {phone_match('u.phone', q)} OR u.full_name ILIKE {like(q)})""")
    items = await query_db(f"""
        SELECT b.id, b.status, b.event_date, b.guests_count, b.price_at_booking,
               b.comment, b.rejected_reason, b.created_at,
               u.id AS client_id, u.phone AS client_phone, u.full_name AS client_name,
               b.hall_id, b.provider_id,
               COALESCE(h.name, p.name) AS subject, v.name AS venue_name,
               et.name_ru AS event_type
        {_BOOKING_FROM}
        WHERE {where_sql(conditions)}
        ORDER BY b.id DESC
        {limit_offset(page, page_size)}
    """)
    total = await query_db(f"SELECT COUNT(*)::int AS n {_BOOKING_FROM} WHERE {where_sql(conditions)}")
    return paged(items, total[0]['n'], page, page_size)
