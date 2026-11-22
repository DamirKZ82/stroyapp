"""
Избранное: магазины и бригады.

    GET    /favorites                   — мои избранные
    POST   /favorites/provider/{guid}   — добавить объявление
    DELETE /favorites/provider/{guid}   — убрать объявление

Идемпотентно: повторный POST / DELETE на то же самое — не ошибка, просто no-op.
"""
from fastapi import APIRouter, Depends

from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from handlers.h03_auth import auth_user
from libs.common import fit_to_sql
from libs.plans import visible_item_sql
from libs.date import get_timestamp_now
from libs.ownership import get_provider_by_guid


router = APIRouter(prefix='/favorites')


async def _provider_favorites(user_id: int) -> list[dict]:
    rows = await query_db(f"""
        SELECT
            p.id AS provider_id, p.guid AS provider_guid, p.name AS provider_name,
            p.description AS provider_description, p.address,
            COALESCE(mp.price, p.price_from) AS price_from,
            CASE WHEN mp.price IS NOT NULL THEN mp.unit ELSE p.price_unit END AS price_unit,
            p.latitude, p.longitude, p.is_active AS provider_is_active,
            cat.id AS category_id, cat.code AS category_code, cat.kind AS category_kind,
            cat.name_ru AS category_name_ru, cat.name_kz AS category_name_kz,
            c.id AS city_id, c.name_ru AS city_name_ru, c.name_kz AS city_name_kz,
            ph.thumb_path AS main_thumb, ph.file_path AS main_photo,
            COALESCE(r.avg_rating, 0)::float AS avg_rating,
            COALESCE(r.reviews_count, 0)::int AS reviews_count,
            f.created_at AS favorited_at
        FROM favorites f
        JOIN providers p ON p.id = f.provider_id
        JOIN categories cat ON cat.id = p.category_id
        JOIN cities c ON c.id = p.city_id
        LEFT JOIN LATERAL (
            SELECT thumb_path, file_path
            FROM provider_photos
            WHERE provider_id = p.id
            ORDER BY sort_order, id
            LIMIT 1
        ) ph ON true
        LEFT JOIN LATERAL (
            SELECT pi.price, pi.unit
            FROM provider_items pi
            WHERE pi.provider_id = p.id AND pi.price IS NOT NULL
              AND {visible_item_sql('pi', 'p.owner_id', fit_to_sql(get_timestamp_now()))}
            ORDER BY pi.price, pi.id
            LIMIT 1
        ) mp ON true
        LEFT JOIN (
            SELECT provider_id,
                   AVG(rating)::float AS avg_rating,
                   COUNT(*)::int AS reviews_count
            FROM reviews
            GROUP BY provider_id
        ) r ON r.provider_id = p.id
        WHERE f.user_id = {fit_to_sql(user_id)}
          -- скрытое модератором не показываем и здесь; после возврата оно
          -- появится в избранном снова
          AND p.hidden_at IS NULL
        ORDER BY f.created_at DESC, p.id DESC
    """)
    items = []
    for r in rows:
        items.append({
            'type': 'provider',
            'provider': {
                'id': r['provider_id'],
                'guid': r['provider_guid'],
                'name': r['provider_name'],
                'description': r['provider_description'],
                'address': r['address'],
                'price_from': r['price_from'],
                'price_unit': r['price_unit'],
                'latitude': float(r['latitude']) if r['latitude'] is not None else None,
                'longitude': float(r['longitude']) if r['longitude'] is not None else None,
                'is_active': r['provider_is_active'],
            },
            'category': {
                'id': r['category_id'],
                'code': r['category_code'],
                'kind': r['category_kind'],
                'name_ru': r['category_name_ru'],
                'name_kz': r['category_name_kz'],
            },
            'city': {
                'id': r['city_id'],
                'name_ru': r['city_name_ru'],
                'name_kz': r['city_name_kz'],
            },
            'main_photo': r['main_photo'],
            'main_thumb': r['main_thumb'],
            'rating': {'avg': round(r['avg_rating'], 2), 'count': r['reviews_count']},
            'favorited_at': r['favorited_at'],
        })
    return items


@router.get('')
async def list_favorites(user=Depends(auth_user)):
    """Избранные объявления, новые сверху."""
    return {'items': await _provider_favorites(user['id'])}


@router.post('/provider/{guid}')
async def add_provider_favorite(guid: str, user=Depends(auth_user)):
    provider = await get_provider_by_guid(guid)
    # Добавить можно только то, что открывается в поиске: иначе по guid в
    # избранном читалась бы карточка, которую сама карточка уже не отдаёт.
    if provider is None or not provider['is_active']:
        raise WarnException(404, 'Объявление не найдено')

    now = get_timestamp_now()
    await query_db(f"""
        INSERT INTO favorites (user_id, provider_id, created_at)
        VALUES ({fit_to_sql(user['id'])}, {fit_to_sql(provider['id'])}, {fit_to_sql(now)})
        ON CONFLICT (user_id, provider_id) DO NOTHING
    """)
    return {'ok': True}


@router.delete('/provider/{guid}')
async def remove_provider_favorite(guid: str, user=Depends(auth_user)):
    provider = await get_provider_by_guid(guid)
    if provider is None:
        raise WarnException(404, 'Объявление не найдено')

    await query_db(f"""
        DELETE FROM favorites
        WHERE user_id = {fit_to_sql(user['id'])}
          AND provider_id = {fit_to_sql(provider['id'])}
    """)
    return {'ok': True}
