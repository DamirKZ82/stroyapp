"""
Админка: объявления, отзывы, заявки.

    GET    /admin/api/providers                 объявления: поиск, вид, категория, город, статус
    GET    /admin/api/providers/{id}            объявление целиком: фото, признаки, прайс
    POST   /admin/api/providers/{id}/hide       скрыть из поиска (причина обязательна)
    POST   /admin/api/providers/{id}/unhide     вернуть
    POST   /admin/api/providers/{id}/verify     «Проверенный»: БИН/ИИН сверен с реестром
    POST   /admin/api/providers/{id}/unverify   снять отметку (причина обязательна)
    DELETE /admin/api/provider-photos/{id}      удалить одно фото
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
    PROVIDER_STATUS_FILTER,
    count_providers,
    fetch_providers,
)
from services.moderation import hide_listing, listing_subject, log_action, unhide_listing


router = APIRouter(prefix='/admin/api')

BOOKING_STATUSES = ('pending', 'confirmed', 'rejected', 'cancelled')


def _check_status(status: str, allowed: dict) -> None:
    if status != 'all' and status not in allowed:
        raise WarnException(400, f"status должен быть одним из: {['all'] + sorted(allowed)}")


# kind — 'provider'; действие в журнале зовётся так же: provider_hide и т.д.

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


# -------------------------------------------------------------------------
# Объявления
# -------------------------------------------------------------------------

@router.get('/providers')
async def list_providers(
    admin=Depends(auth_admin),
    q: Optional[str] = Query(None, max_length=100),
    kind: Optional[str] = Query(None, description="'material' | 'service'"),
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
    if kind in ('material', 'service'):
        conditions.append(f'cat.kind = {fit_to_sql(kind)}')
    if category_id is not None:
        conditions.append(f'p.category_id = {fit_to_sql(category_id)}')
    if city_id is not None:
        conditions.append(f'p.city_id = {fit_to_sql(city_id)}')
    if q and q.strip():
        conditions.append(f"""(p.name ILIKE {like(q)} OR p.address ILIKE {like(q)}
                               OR {phone_match('u.phone', q)}
                               OR u.full_name ILIKE {like(q)})""")
    items = await fetch_providers(conditions, page, page_size)
    return paged(items, await count_providers(conditions), page, page_size)


@router.get('/providers/{provider_id}')
async def get_provider(provider_id: int, admin=Depends(auth_admin)):
    found = await fetch_providers([f'p.id = {fit_to_sql(provider_id)}'])
    if not found:
        raise WarnException(404, 'Объявление не найдено')
    provider = found[0]
    pid = fit_to_sql(provider_id)

    more = await query_db(f"""
        SELECT description, phone, address, latitude::float AS latitude, longitude::float AS longitude, updated_at
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
    provider['item_list'] = await query_db(f"""
        SELECT name, unit, price FROM provider_items
        WHERE provider_id = {pid} ORDER BY sort_order, id
    """)
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


async def _provider_for_verify(provider_id: int) -> dict:
    rows = await query_db(f"""
        SELECT id, name, owner_id, bin, verified_at FROM providers
        WHERE id = {fit_to_sql(provider_id)}
    """)
    if not rows:
        raise WarnException(404, 'Объявление не найдено')
    return rows[0]


@router.post('/providers/{provider_id}/verify')
async def verify_provider(provider_id: int, admin=Depends(auth_admin)):
    """
    Админ сверил БИН/ИИН объявления с реестром (stat.gov.kz, kgd.gov.kz).
    Значок «Проверенный» клиенты увидят, пока у владельца оплачен Pro.
    """
    p = await _provider_for_verify(provider_id)
    if not p['bin']:
        raise WarnException(400, 'Продавец ещё не прислал БИН или ИИН')
    now = get_timestamp_now()
    await query_db(f"""
        UPDATE providers SET verified_at = {fit_to_sql(now)}
        WHERE id = {fit_to_sql(provider_id)}
    """)
    await log_action(admin, 'provider_verify', 'provider', provider_id, p['name'], f"БИН/ИИН {p['bin']}",
                     subjects=[p['owner_id']])
    return {'ok': True}


@router.post('/providers/{provider_id}/unverify')
async def unverify_provider(provider_id: int, body: ReasonBody, admin=Depends(auth_admin)):
    p = await _provider_for_verify(provider_id)
    await query_db(f"""
        UPDATE providers SET verified_at = null
        WHERE id = {fit_to_sql(provider_id)}
    """)
    await log_action(admin, 'provider_unverify', 'provider', provider_id, p['name'], body.reason,
                     subjects=[p['owner_id']])
    return {'ok': True}


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
                               OR p.name ILIKE {like(q)}
                               OR {phone_match('u.phone', q)} OR u.full_name ILIKE {like(q)})""")
    items = await query_db(f"""
        SELECT r.id, r.rating, r.text, r.owner_reply, r.created_at,
               u.id AS author_id, u.phone AS author_phone, u.full_name AS author_name,
               r.provider_id, p.name AS subject
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
               p.name AS subject, p.owner_id
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
    LEFT JOIN providers p ON p.id = b.provider_id
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
        conditions.append(f"""(p.name ILIKE {like(q)} OR b.address ILIKE {like(q)}
                               OR {phone_match('u.phone', q)} OR u.full_name ILIKE {like(q)})""")
    items = await query_db(f"""
        SELECT b.id, b.status, b.event_date, b.address,
               b.comment, b.rejected_reason, b.created_at,
               u.id AS client_id, u.phone AS client_phone, u.full_name AS client_name,
               b.provider_id, p.name AS subject
        {_BOOKING_FROM}
        WHERE {where_sql(conditions)}
        ORDER BY b.id DESC
        {limit_offset(page, page_size)}
    """)
    total = await query_db(f"SELECT COUNT(*)::int AS n {_BOOKING_FROM} WHERE {where_sql(conditions)}")
    return paged(items, total[0]['n'], page, page_size)
