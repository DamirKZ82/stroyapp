"""
Выборки объявлений для админки: залы и исполнители с владельцем и статусом.

Нужны в двух местах — в общих списках и в карточке пользователя («его
объявления»), поэтому лежат отдельно от роутеров.

Статус объявления одним словом:
    public        — видно в поиске
    owner_blocked — владелец заблокирован
    hidden        — скрыто модератором
    venue_hidden  — скрыто заведение целиком (для зала)
    unpublished   — снято самим владельцем

«public» проверяется первым и тем же условием, что в публичном поиске: что бы
ни стояло в остальных колонках, подпись не скажет «не видно» про объявление,
которое на самом деле видно. Тогда его можно скрыть обычной кнопкой.
"""
from connections.connect_postgres import query_db
from libs.admin_query import limit_offset, where_sql


# IS TRUE / IS NOT TRUE, а не голое сравнение: колонки допускают NULL, и
# публичный поиск (is_active = true) считает NULL «не опубликовано».
HALL_STATUS_SQL = """CASE
    WHEN h.is_active IS TRUE AND v.is_active IS TRUE THEN 'public'
    WHEN u.is_blocked IS TRUE THEN 'owner_blocked'
    WHEN h.hidden_at IS NOT NULL THEN 'hidden'
    WHEN v.hidden_at IS NOT NULL THEN 'venue_hidden'
    ELSE 'unpublished'
END"""

PROVIDER_STATUS_SQL = """CASE
    WHEN p.is_active IS TRUE THEN 'public'
    WHEN u.is_blocked IS TRUE THEN 'owner_blocked'
    WHEN p.hidden_at IS NOT NULL THEN 'hidden'
    ELSE 'unpublished'
END"""

# Условия фильтра «статус» в списках. «Скрыты модератором» — всё, что убрано
# из поиска не владельцем: скрытое отдельно, вместе с заведением и вместе с
# блокировкой владельца.
HALL_STATUS_FILTER = {
    'public': 'h.is_active IS TRUE AND v.is_active IS TRUE',
    'unpublished': """(h.is_active IS NOT TRUE OR v.is_active IS NOT TRUE)
                      AND h.hidden_at IS NULL AND v.hidden_at IS NULL""",
    'hidden': '(h.hidden_at IS NOT NULL OR v.hidden_at IS NOT NULL)',
}
PROVIDER_STATUS_FILTER = {
    'public': 'p.is_active IS TRUE',
    'unpublished': 'p.is_active IS NOT TRUE AND p.hidden_at IS NULL',
    'hidden': 'p.hidden_at IS NOT NULL',
}

_HALL_FROM = """
    FROM halls h
    JOIN venues v ON v.id = h.venue_id
    JOIN cities c ON c.id = v.city_id
    JOIN users u ON u.id = v.owner_id
"""

_PROVIDER_FROM = """
    FROM providers p
    JOIN categories cat ON cat.id = p.category_id
    JOIN cities c ON c.id = p.city_id
    JOIN users u ON u.id = p.owner_id
"""


async def fetch_halls(conditions: list, page: int = 1, page_size: int = 100) -> list:
    return await query_db(f"""
        SELECT h.id, h.guid, h.name, h.capacity_min, h.capacity_max,
               h.price_weekday, h.price_weekend,
               h.is_active, h.hidden_at, h.hidden_reason, h.created_at,
               v.id AS venue_id, v.name AS venue_name, v.address,
               v.hidden_at AS venue_hidden_at, v.hidden_reason AS venue_hidden_reason,
               c.name_ru AS city,
               u.id AS owner_id, u.phone AS owner_phone, u.full_name AS owner_name,
               ph.thumb_path AS thumb,
               (SELECT COUNT(*) FROM hall_photos x WHERE x.hall_id = h.id)::int AS photos,
               {HALL_STATUS_SQL} AS status
        {_HALL_FROM}
        LEFT JOIN LATERAL (
            SELECT thumb_path FROM hall_photos
            WHERE hall_id = h.id ORDER BY sort_order, id LIMIT 1
        ) ph ON true
        WHERE {where_sql(conditions)}
        ORDER BY h.id DESC
        {limit_offset(page, page_size)}
    """)


async def count_halls(conditions: list) -> int:
    rows = await query_db(f"SELECT COUNT(*)::int AS n {_HALL_FROM} WHERE {where_sql(conditions)}")
    return rows[0]['n']


async def fetch_providers(conditions: list, page: int = 1, page_size: int = 100) -> list:
    return await query_db(f"""
        SELECT p.id, p.guid, p.name, p.price_from, p.price_unit,
               p.is_active, p.hidden_at, p.hidden_reason, p.created_at,
               cat.name_ru AS category, c.name_ru AS city,
               u.id AS owner_id, u.phone AS owner_phone, u.full_name AS owner_name,
               ph.thumb_path AS thumb,
               (SELECT COUNT(*) FROM provider_photos x WHERE x.provider_id = p.id)::int AS photos,
               {PROVIDER_STATUS_SQL} AS status
        {_PROVIDER_FROM}
        LEFT JOIN LATERAL (
            SELECT thumb_path FROM provider_photos
            WHERE provider_id = p.id ORDER BY sort_order, id LIMIT 1
        ) ph ON true
        WHERE {where_sql(conditions)}
        ORDER BY p.id DESC
        {limit_offset(page, page_size)}
    """)


async def count_providers(conditions: list) -> int:
    rows = await query_db(f"SELECT COUNT(*)::int AS n {_PROVIDER_FROM} WHERE {where_sql(conditions)}")
    return rows[0]['n']
