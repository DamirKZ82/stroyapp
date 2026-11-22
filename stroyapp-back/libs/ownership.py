"""
Загрузка объявления по guid и проверка, что юзер — владелец.
Используется в роутерах объявлений, заявок, отзывов и чатов.
"""
from typing import Optional

from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from libs.common import fit_to_sql


async def get_provider_by_guid(guid: str) -> Optional[dict]:
    rows = await query_db(f"""
        SELECT id, guid, owner_id, category_id, city_id, name, description,
               phone, address, latitude, longitude, price_from, price_unit, is_active,
               hidden_at, hidden_reason,
               created_at, updated_at
        FROM providers
        WHERE guid = {fit_to_sql(guid)}
    """)
    return rows[0] if rows else None


async def require_provider_owner(provider_guid: str, user: dict) -> dict:
    """Вернёт объявление или бросит 404/403."""
    provider = await get_provider_by_guid(provider_guid)
    if provider is None:
        raise WarnException(404, 'Объявление не найдено')
    if provider['owner_id'] != user['id']:
        raise WarnException(403, 'Недостаточно прав')
    return provider
