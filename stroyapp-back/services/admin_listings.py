"""
Выборки объявлений для админки: магазины и бригады с владельцем и статусом.

Нужны в двух местах — в общих списках и в карточке пользователя («его
объявления»), поэтому лежат отдельно от роутеров.

Статус объявления одним словом:
    public        — видно в поиске
    owner_blocked — владелец заблокирован
    hidden        — скрыто модератором
    unpublished   — снято самим владельцем

«public» проверяется первым и тем же условием, что в публичном поиске: что бы
ни стояло в остальных колонках, подпись не скажет «не видно» про объявление,
которое на самом деле видно. Тогда его можно скрыть обычной кнопкой.
"""
from connections.connect_postgres import query_db
from libs.admin_query import limit_offset, where_sql


# IS TRUE / IS NOT TRUE, а не голое сравнение: колонки допускают NULL, и
# публичный поиск (is_active = true) считает NULL «не опубликовано».
PROVIDER_STATUS_SQL = """CASE
    WHEN p.is_active IS TRUE THEN 'public'
    WHEN u.is_blocked IS TRUE THEN 'owner_blocked'
    WHEN p.hidden_at IS NOT NULL THEN 'hidden'
    ELSE 'unpublished'
END"""

# Условия фильтра «статус» в списках. «Скрыты модератором» — всё, что убрано
# из поиска не владельцем: скрытое отдельно и вместе с блокировкой владельца.
PROVIDER_STATUS_FILTER = {
    'public': 'p.is_active IS TRUE',
    'unpublished': 'p.is_active IS NOT TRUE AND p.hidden_at IS NULL',
    'hidden': 'p.hidden_at IS NOT NULL',
}

_PROVIDER_FROM = """
    FROM providers p
    JOIN categories cat ON cat.id = p.category_id
    JOIN cities c ON c.id = p.city_id
    JOIN users u ON u.id = p.owner_id
"""


async def fetch_providers(conditions: list, page: int = 1, page_size: int = 100) -> list:
    return await query_db(f"""
        SELECT p.id, p.guid, p.name, p.price_from, p.price_unit,
               p.is_active, p.hidden_at, p.hidden_reason, p.created_at,
               cat.name_ru AS category, cat.kind AS kind, c.name_ru AS city,
               (SELECT COUNT(*) FROM provider_items x WHERE x.provider_id = p.id)::int AS items,
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
