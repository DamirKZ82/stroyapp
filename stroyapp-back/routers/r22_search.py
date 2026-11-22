"""
Поиск (публичный, без JWT): объявления и позиции прайса.

    GET /search/providers   — магазины и бригады
        ?kind=material|service   вид (обязателен, если не задана категория)
        &category_id=3           категория
        &q=газоблок              текст: название, описание и позиции прайса
        &city_id=1
        &price_max=50000         «цена от» не выше
        &attr_ids=1,2            нужны ВСЕ признаки
        &sort=rating_desc|price_asc|price_desc
        &page=1&page_size=20

    GET /search/items       — позиции прайса (сравнить цены на товар или работу)
        ?q=газоблок (обязателен, от 2 символов)
        &kind=…&category_id=…&city_id=…&price_max=…
        &sort=price_asc|price_desc|rating_desc

    GET /search/providers/{guid} — карточка объявления с фото, признаками и прайсом

Тариф продавца (libs/plans.py) влияет на выдачу так:
    - видны только позиции прайса в пределах лимита тарифа;
    - при сортировке «по рейтингу» объявления с оплаченным Pro идут первыми
      (продвижение). Сортировки по цене и сравнение цен — честные, без него;
    - verified — значок «Проверенный».
"""
from typing import Optional

from fastapi import APIRouter, Query

from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from libs.common import fit_to_sql
from libs.date import get_timestamp_now
from libs.plans import paid_sql, verified_sql, visible_item_sql


router = APIRouter(prefix='/search')


ALLOWED_SORT = {'rating_desc', 'price_asc', 'price_desc'}
ALLOWED_KINDS = {'material', 'service'}

# Сколько совпавших позиций прайса показать под карточкой в списке.
MATCHED_ITEMS_MAX = 3


def _parse_id_csv(raw: Optional[str], field: str) -> list[int]:
    if not raw:
        return []
    try:
        return [int(x.strip()) for x in raw.split(',') if x.strip()]
    except ValueError:
        raise WarnException(400, f'{field} должны быть целыми числами через запятую')


def _like_pattern(q: str) -> str:
    """Подстрока для ILIKE: служебные символы шаблона экранируются."""
    q = q.strip().lower()
    q = q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    return f'%{q}%'


def _clean_q(q: Optional[str]) -> Optional[str]:
    if q is None:
        return None
    q = ' '.join(q.split())
    if not q:
        return None
    if len(q) > 100:
        raise WarnException(400, 'Слишком длинный запрос')
    return q


def _coord(val) -> Optional[float]:
    return float(val) if val is not None else None


async def _common_where(
    kind: Optional[str],
    category_id: Optional[int],
    city_id: Optional[int],
) -> list[str]:
    """Условия, общие для обоих поисков: активность, вид, категория, город."""
    if kind is not None and kind not in ALLOWED_KINDS:
        raise WarnException(400, f'kind должен быть одним из: {sorted(ALLOWED_KINDS)}')

    if category_id is not None:
        cat = await query_db(f"SELECT 1 AS x FROM categories WHERE id = {fit_to_sql(category_id)}")
        if not cat:
            raise WarnException(400, 'Категория не найдена в справочнике')

    if city_id is not None:
        rows = await query_db(f"SELECT 1 AS x FROM cities WHERE id = {fit_to_sql(city_id)}")
        if not rows:
            raise WarnException(400, 'Город не найден в справочнике')

    where = ["p.is_active = true"]
    if kind is not None:
        where.append(f"cat.kind = {fit_to_sql(kind)}")
    if category_id is not None:
        where.append(f"p.category_id = {fit_to_sql(category_id)}")
    if city_id is not None:
        where.append(f"p.city_id = {fit_to_sql(city_id)}")
    return where


def _now_sql() -> str:
    return fit_to_sql(get_timestamp_now())


def _min_price_join(now: str) -> str:
    """
    Минимальная цена из видимой части прайса, иначе «цена от» из самого
    объявления. Единица — та, что у самой дешёвой позиции.
    """
    return f"""
    LEFT JOIN LATERAL (
        SELECT pi.price, pi.unit
        FROM provider_items pi
        WHERE pi.provider_id = p.id AND pi.price IS NOT NULL
          AND {visible_item_sql('pi', 'p.owner_id', now)}
        ORDER BY pi.price, pi.id
        LIMIT 1
    ) mp ON true
"""
_PRICE_EXPR = 'COALESCE(mp.price, p.price_from)'
_UNIT_EXPR = 'CASE WHEN mp.price IS NOT NULL THEN mp.unit ELSE p.price_unit END'

_RATING_JOIN = """
    LEFT JOIN (
        SELECT provider_id,
               AVG(rating)::float AS avg_rating,
               COUNT(*)::int AS reviews_count
        FROM reviews
        GROUP BY provider_id
    ) r ON r.provider_id = p.id
"""


# -------------------------------------------------------------------------
# Поиск объявлений
# -------------------------------------------------------------------------

@router.get('/providers')
async def search_providers(
    kind: Optional[str] = Query(None, description="'material' | 'service'"),
    category_id: Optional[int] = Query(None),
    q: Optional[str] = Query(None, description='Текст: название, описание, позиции прайса'),
    city_id: Optional[int] = Query(None),
    price_max: Optional[int] = Query(None, ge=0),
    attr_ids: Optional[str] = Query(None, description='CSV: "1,2,3" — нужны ВСЕ'),
    sort: str = Query('rating_desc'),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=50),
):
    if sort not in ALLOWED_SORT:
        raise WarnException(400, f'sort должен быть одним из: {sorted(ALLOWED_SORT)}')
    if kind is None and category_id is None:
        raise WarnException(400, 'Укажите kind или category_id')

    where = await _common_where(kind, category_id, city_id)
    now = _now_sql()
    q = _clean_q(q)
    attr_list = _parse_id_csv(attr_ids, 'attr_ids')

    pattern = None
    if q is not None:
        pattern = fit_to_sql(_like_pattern(q))
        where.append(f"""(
            lower(p.name) LIKE {pattern}
            OR lower(COALESCE(p.description, '')) LIKE {pattern}
            OR EXISTS (
                SELECT 1 FROM provider_items pi
                WHERE pi.provider_id = p.id AND lower(pi.name) LIKE {pattern}
                  AND {visible_item_sql('pi', 'p.owner_id', now)}
            )
        )""")
    if price_max is not None:
        where.append(f"({_PRICE_EXPR} IS NOT NULL AND {_PRICE_EXPR} <= {fit_to_sql(price_max)})")
    if attr_list:
        ids_sql = ', '.join(str(int(i)) for i in attr_list)
        where.append(f"""p.id IN (
            SELECT provider_id FROM provider_attr_links
            WHERE attr_id IN ({ids_sql})
            GROUP BY provider_id
            HAVING COUNT(DISTINCT attr_id) = {len(attr_list)}
        )""")
    where_sql = ' AND '.join(where)

    if sort == 'price_asc':
        order_by = f'{_PRICE_EXPR} ASC NULLS LAST, p.id DESC'
    elif sort == 'price_desc':
        order_by = f'{_PRICE_EXPR} DESC NULLS LAST, p.id DESC'
    else:
        # Продвижение: оплаченный Pro — выше, внутри групп — по рейтингу.
        order_by = 'promoted DESC, avg_rating DESC NULLS LAST, reviews_count DESC, p.id DESC'

    offset = (page - 1) * page_size

    rows = await query_db(f"""
        SELECT
            p.id AS provider_id,
            p.guid AS provider_guid,
            p.name AS provider_name,
            p.description AS provider_description,
            p.address,
            {_PRICE_EXPR} AS price_from,
            {_UNIT_EXPR} AS price_unit,
            p.latitude,
            p.longitude,
            cat.id AS category_id,
            cat.code AS category_code,
            cat.kind AS category_kind,
            cat.name_ru AS category_name_ru,
            cat.name_kz AS category_name_kz,
            c.id AS city_id,
            c.name_ru AS city_name_ru,
            c.name_kz AS city_name_kz,
            ph.thumb_path AS main_thumb,
            ph.file_path AS main_photo,
            COALESCE(r.avg_rating, 0)::float AS avg_rating,
            COALESCE(r.reviews_count, 0)::int AS reviews_count,
            {paid_sql('p.owner_id', now)} AS promoted,
            {verified_sql('p', now)} AS verified
        FROM providers p
        JOIN categories cat ON cat.id = p.category_id
        JOIN cities c ON c.id = p.city_id
        LEFT JOIN LATERAL (
            SELECT thumb_path, file_path
            FROM provider_photos
            WHERE provider_id = p.id
            ORDER BY sort_order, id
            LIMIT 1
        ) ph ON true
        {_min_price_join(now)}
        {_RATING_JOIN}
        WHERE {where_sql}
        ORDER BY {order_by}
        LIMIT {fit_to_sql(page_size)} OFFSET {fit_to_sql(offset)}
    """)

    cnt = await query_db(f"""
        SELECT COUNT(*)::int AS n
        FROM providers p
        JOIN categories cat ON cat.id = p.category_id
        {_min_price_join(now)}
        WHERE {where_sql}
    """)
    total = cnt[0]['n']

    # Совпавшие позиции прайса — одним запросом на всю страницу.
    matched: dict[int, list[dict]] = {}
    if pattern is not None and rows:
        ids_sql = ', '.join(str(int(r['provider_id'])) for r in rows)
        item_rows = await query_db(f"""
            SELECT provider_id, guid, name, unit, price
            FROM (
                SELECT pi.provider_id, pi.guid, pi.name, pi.unit, pi.price,
                       ROW_NUMBER() OVER (
                           PARTITION BY pi.provider_id
                           ORDER BY pi.price ASC NULLS LAST, pi.sort_order, pi.id
                       ) AS rn
                FROM provider_items pi
                JOIN providers p ON p.id = pi.provider_id
                WHERE pi.provider_id IN ({ids_sql})
                  AND lower(pi.name) LIKE {pattern}
                  AND {visible_item_sql('pi', 'p.owner_id', now)}
            ) t
            WHERE rn <= {MATCHED_ITEMS_MAX}
            ORDER BY provider_id, rn
        """)
        for it in item_rows:
            pid = it.pop('provider_id')
            matched.setdefault(pid, []).append(it)

    items = []
    for r in rows:
        items.append({
            'provider': {
                'id': r['provider_id'],
                'guid': r['provider_guid'],
                'name': r['provider_name'],
                'description': r['provider_description'],
                'address': r['address'],
                'price_from': r['price_from'],
                'price_unit': r['price_unit'],
                'latitude': _coord(r['latitude']),
                'longitude': _coord(r['longitude']),
                'verified': r['verified'],
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
            'rating': {
                'avg': round(r['avg_rating'], 2),
                'count': r['reviews_count'],
            },
            'matched_items': matched.get(r['provider_id'], []),
        })

    return {
        'items': items,
        'total': total,
        'page': page,
        'page_size': page_size,
    }


# -------------------------------------------------------------------------
# Поиск позиций прайса: «где дешевле газоблок» / «сколько стоит штукатурка».
# -------------------------------------------------------------------------

@router.get('/items')
async def search_items(
    q: str = Query(..., description='Что ищем, от 2 символов'),
    kind: Optional[str] = Query(None, description="'material' | 'service'"),
    category_id: Optional[int] = Query(None),
    city_id: Optional[int] = Query(None),
    price_max: Optional[int] = Query(None, ge=0),
    sort: str = Query('price_asc'),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=50),
):
    if sort not in ALLOWED_SORT:
        raise WarnException(400, f'sort должен быть одним из: {sorted(ALLOWED_SORT)}')
    q = _clean_q(q)
    if q is None or len(q) < 2:
        raise WarnException(400, 'Введите хотя бы 2 символа')

    where = await _common_where(kind, category_id, city_id)
    now = _now_sql()
    where.append(f"lower(pi.name) LIKE {fit_to_sql(_like_pattern(q))}")
    where.append(visible_item_sql('pi', 'p.owner_id', now))
    if price_max is not None:
        where.append(f"(pi.price IS NOT NULL AND pi.price <= {fit_to_sql(price_max)})")
    where_sql = ' AND '.join(where)

    if sort == 'price_desc':
        order_by = 'pi.price DESC NULLS LAST, pi.id DESC'
    elif sort == 'rating_desc':
        order_by = 'avg_rating DESC NULLS LAST, pi.price ASC NULLS LAST, pi.id DESC'
    else:
        order_by = 'pi.price ASC NULLS LAST, pi.id DESC'

    offset = (page - 1) * page_size
    rows = await query_db(f"""
        SELECT
            pi.guid AS item_guid, pi.name AS item_name, pi.unit, pi.price,
            p.guid AS provider_guid, p.name AS provider_name, p.address,
            cat.id AS category_id, cat.code AS category_code, cat.kind AS category_kind,
            cat.name_ru AS category_name_ru, cat.name_kz AS category_name_kz,
            c.id AS city_id, c.name_ru AS city_name_ru, c.name_kz AS city_name_kz,
            ph.thumb_path AS main_thumb,
            COALESCE(r.avg_rating, 0)::float AS avg_rating,
            COALESCE(r.reviews_count, 0)::int AS reviews_count,
            {verified_sql('p', now)} AS verified
        FROM provider_items pi
        JOIN providers p ON p.id = pi.provider_id
        JOIN categories cat ON cat.id = p.category_id
        JOIN cities c ON c.id = p.city_id
        LEFT JOIN LATERAL (
            SELECT thumb_path FROM provider_photos
            WHERE provider_id = p.id
            ORDER BY sort_order, id
            LIMIT 1
        ) ph ON true
        {_RATING_JOIN}
        WHERE {where_sql}
        ORDER BY {order_by}
        LIMIT {fit_to_sql(page_size)} OFFSET {fit_to_sql(offset)}
    """)
    cnt = await query_db(f"""
        SELECT COUNT(*)::int AS n
        FROM provider_items pi
        JOIN providers p ON p.id = pi.provider_id
        JOIN categories cat ON cat.id = p.category_id
        WHERE {where_sql}
    """)

    items = [{
        'item': {
            'guid': r['item_guid'],
            'name': r['item_name'],
            'unit': r['unit'],
            'price': r['price'],
        },
        'provider': {
            'guid': r['provider_guid'],
            'name': r['provider_name'],
            'address': r['address'],
            'verified': r['verified'],
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
        'main_thumb': r['main_thumb'],
        'rating': {
            'avg': round(r['avg_rating'], 2),
            'count': r['reviews_count'],
        },
    } for r in rows]

    return {
        'items': items,
        'total': cnt[0]['n'],
        'page': page,
        'page_size': page_size,
    }


# -------------------------------------------------------------------------
# Карточка объявления
# -------------------------------------------------------------------------

@router.get('/providers/{guid}')
async def public_provider_details(guid: str):
    now = _now_sql()
    rows = await query_db(f"""
        SELECT p.id, p.guid, p.name, p.description, p.phone, p.address,
               p.latitude, p.longitude, p.price_from, p.price_unit,
               p.is_active, p.created_at, p.updated_at,
               {verified_sql('p', now)} AS verified,
               cat.id AS category_id, cat.code AS category_code, cat.kind AS category_kind,
               cat.name_ru AS category_name_ru, cat.name_kz AS category_name_kz,
               c.id AS city_id, c.name_ru AS city_name_ru, c.name_kz AS city_name_kz
        FROM providers p
        JOIN categories cat ON cat.id = p.category_id
        JOIN cities c ON c.id = p.city_id
        WHERE p.guid = {fit_to_sql(guid)}
    """)
    if not rows:
        raise WarnException(404, 'Объявление не найдено')
    r = rows[0]
    if not r['is_active']:
        raise WarnException(404, 'Объявление не найдено')

    photos = await query_db(f"""
        SELECT id, file_path, thumb_path, sort_order
        FROM provider_photos
        WHERE provider_id = {fit_to_sql(r['id'])}
        ORDER BY sort_order, id
    """)
    attrs = await query_db(f"""
        SELECT a.id, a.code, a.name_ru, a.name_kz, a.icon
        FROM provider_attr_links pal
        JOIN provider_attr_types a ON a.id = pal.attr_id
        WHERE pal.provider_id = {fit_to_sql(r['id'])}
        ORDER BY a.sort_order, a.id
    """)
    price_items = await query_db(f"""
        SELECT pi.guid, pi.name, pi.unit, pi.price, pi.sort_order
        FROM provider_items pi
        JOIN providers p ON p.id = pi.provider_id
        WHERE pi.provider_id = {fit_to_sql(r['id'])}
          AND {visible_item_sql('pi', 'p.owner_id', now)}
        ORDER BY pi.sort_order, pi.id
    """)

    return {
        'provider': {
            'id': r['id'],
            'guid': r['guid'],
            'name': r['name'],
            'description': r['description'],
            'phone': r['phone'],
            'address': r['address'],
            'latitude': _coord(r['latitude']),
            'longitude': _coord(r['longitude']),
            'price_from': r['price_from'],
            'price_unit': r['price_unit'],
            'is_active': r['is_active'],
            'verified': r['verified'],
            'created_at': r['created_at'],
            'updated_at': r['updated_at'],
            'photos': photos,
            'attrs': attrs,
            'items': price_items,
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
        },
    }
