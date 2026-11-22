"""
Админка: жалобы пользователей.

    GET  /admin/api/complaints              список: статус, на что, поиск
    GET  /admin/api/complaints/{id}         одна жалоба — с тем, что сейчас с объявлением
    POST /admin/api/complaints/{id}/close   закрыть: меры приняты или жалоба отклонена

Жалоба сама ничего не меняет: модератор открывает объявление, отзыв или
человека обычными разделами админки, решает, что делать, и закрывает жалобу с
пометкой. Закрыть можно сразу все неразобранные жалобы на то же самое — на
одно объявление их приходит несколько.

«То же самое» — это то же объявление, отзыв или переписка И тот же человек,
на которого жалуются: в одной переписке двое могут пожаловаться друг на
друга, и это разные жалобы с разным исходом.
"""
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, field_validator

from connections.connect_postgres import query_db, transaction
from handlers.h01_errors import WarnException
from handlers.h03_auth import auth_admin
from libs.admin_query import MAX_PAGE, like, limit_offset, paged, phone_match, where_sql
from libs.common import clean_text, fit_to_sql
from libs.date import get_timestamp_now
from services.admin_listings import PROVIDER_STATUS_SQL
from services.complaints import REASON_LABELS, REASONS, STATUSES, TARGET_LABELS
from services.moderation import log_action


router = APIRouter(prefix='/admin/api')

NOTE_MAX = 500
OUTCOMES = {'resolved': 'complaint_resolve', 'rejected': 'complaint_reject'}

# Что сейчас с тем, на что пожаловались. NULL — уже удалено. У объявлений —
# тот же статус, что в разделе «Объявления».
_TARGET_STATE = f"""CASE c.target_type
    WHEN 'provider' THEN (
        SELECT {PROVIDER_STATUS_SQL}
        FROM providers p JOIN users u ON u.id = p.owner_id
        WHERE p.id = c.target_id)
    WHEN 'review' THEN (SELECT 'exists' FROM reviews r WHERE r.id = c.target_id)
    ELSE (SELECT 'exists' FROM chats ch WHERE ch.id = c.target_id)
END"""

# Объявление, к которому относится жалоба, — чтобы открыть его из жалобы.
# У отзыва и переписки оно берётся из них самих, пока они существуют.
_LISTING_PROVIDER = """CASE c.target_type
    WHEN 'provider' THEN (SELECT p.id FROM providers p WHERE p.id = c.target_id)
    WHEN 'review' THEN (SELECT r.provider_id FROM reviews r WHERE r.id = c.target_id)
    WHEN 'chat' THEN (SELECT ch.provider_id FROM chats ch WHERE ch.id = c.target_id)
END"""

_FROM = """
    FROM complaints c
    LEFT JOIN users ru ON ru.id = c.reporter_id
    LEFT JOIN users tu ON tu.id = c.target_user_id
    LEFT JOIN users au ON au.id = c.resolved_by
"""


# Неразобранные жалобы на то же самое, что и жалоба c (см. описание файла).
_SAME_TARGET = """o.target_type = c.target_type AND o.target_id = c.target_id
                  AND o.target_user_id IS NOT DISTINCT FROM c.target_user_id
                  AND o.status = 'new'"""


class CloseBody(BaseModel):
    outcome: str
    note: Optional[str] = None
    # Закрыть заодно остальные неразобранные жалобы на то же самое — но только
    # те, что админ видел: с номером не больше этого (same_target_last из
    # карточки жалобы). Жалоба, пришедшая, пока он читал, останется новой.
    same_target_upto: Optional[int] = None

    @field_validator('outcome')
    @classmethod
    def outcome_known(cls, val):
        if val not in OUTCOMES:
            raise ValueError(f'outcome должен быть одним из: {sorted(OUTCOMES)}')
        return val

    @field_validator('note')
    @classmethod
    def note_ok(cls, val):
        if val is None:
            return None
        val = clean_text(val).strip()
        if len(val) > NOTE_MAX:
            raise ValueError(f'Пометка не должна быть длиннее {NOTE_MAX} символов')
        return val or None


async def _fetch(conditions: list, page: int = 1, page_size: int = 1) -> list:
    items = await query_db(f"""
        SELECT c.id, c.target_type, c.target_id, c.target_label, c.target_text,
               c.reason, c.comment, c.status, c.resolution, c.resolved_at, c.created_at,
               c.reporter_id, ru.phone AS reporter_phone, ru.full_name AS reporter_name,
               c.target_user_id, tu.phone AS target_user_phone, tu.full_name AS target_user_name,
               tu.is_blocked AS target_user_blocked,
               au.phone AS resolved_by_phone,
               {_TARGET_STATE} AS target_state,
               {_LISTING_PROVIDER} AS provider_id,
               (SELECT COUNT(*) FROM complaints o WHERE {_SAME_TARGET})::int AS same_target_open,
               (SELECT MAX(o.id) FROM complaints o WHERE {_SAME_TARGET}) AS same_target_last
        {_FROM}
        WHERE {where_sql(conditions)}
        ORDER BY c.id DESC
        {limit_offset(page, page_size)}
    """)
    for item in items:
        item['reason_label'] = REASON_LABELS.get(item['reason'], item['reason'])
        item['target_type_label'] = TARGET_LABELS.get(item['target_type'], item['target_type'])
    return items


@router.get('/complaints')
async def list_complaints(
    admin=Depends(auth_admin),
    status: str = Query('new'),
    target_type: str = Query('all'),
    q: Optional[str] = Query(None, max_length=100),
    page: int = Query(1, ge=1, le=MAX_PAGE),
    page_size: int = Query(30, ge=1, le=100),
):
    if status != 'all' and status not in STATUSES:
        raise WarnException(400, f"status должен быть одним из: {['all', *STATUSES]}")
    if target_type != 'all' and target_type not in REASONS:
        raise WarnException(400, f"target_type должен быть одним из: {['all', *sorted(REASONS)]}")

    conditions = []
    if status != 'all':
        conditions.append(f'c.status = {fit_to_sql(status)}')
    if target_type != 'all':
        conditions.append(f'c.target_type = {fit_to_sql(target_type)}')
    if q and q.strip():
        conditions.append(f"""(c.target_label ILIKE {like(q)} OR c.comment ILIKE {like(q)}
                               OR ru.full_name ILIKE {like(q)} OR {phone_match('ru.phone', q)}
                               OR tu.full_name ILIKE {like(q)} OR {phone_match('tu.phone', q)})""")

    items = await _fetch(conditions, page, page_size)
    total = await query_db(f"SELECT COUNT(*)::int AS n {_FROM} WHERE {where_sql(conditions)}")
    new_total = await query_db("SELECT COUNT(*)::int AS n FROM complaints WHERE status = 'new'")
    result = paged(items, total[0]['n'], page, page_size)
    # Сколько ждёт разбора — для метки на вкладке, каким бы ни был отбор.
    result['new_total'] = new_total[0]['n']
    return result


@router.get('/complaints/{complaint_id}')
async def get_complaint(complaint_id: int, admin=Depends(auth_admin)):
    found = await _fetch([f'c.id = {fit_to_sql(complaint_id)}'])
    if not found:
        raise WarnException(404, 'Жалоба не найдена')
    return {'complaint': found[0]}


@router.post('/complaints/{complaint_id}/close')
async def close_complaint(complaint_id: int, body: CloseBody, admin=Depends(auth_admin)):
    found = await query_db(f"""
        SELECT id, target_type, target_id, target_label, target_user_id, target_owner_id
        FROM complaints WHERE id = {fit_to_sql(complaint_id)}
    """)
    if not found:
        raise WarnException(404, 'Жалоба не найдена')
    complaint = found[0]

    which = f'c.id = {fit_to_sql(complaint_id)}'
    if body.same_target_upto is not None:
        which = f"""(c.id = {fit_to_sql(complaint_id)} OR (
            c.target_type = {fit_to_sql(complaint['target_type'])}
            AND c.target_id = {fit_to_sql(complaint['target_id'])}
            AND c.target_user_id IS NOT DISTINCT FROM {fit_to_sql(complaint['target_user_id'])}
            AND c.id <= {fit_to_sql(body.same_target_upto)}))"""
    async with transaction() as tx:
        # Все строки, которые закрываем, занимаем одним запросом и по порядку
        # номеров. Двое админов, закрывающих соседние жалобы «вместе с
        # остальными», тогда встают в очередь, а не ждут друг друга по кругу.
        # Второй после ожидания видит эти жалобы уже закрытыми.
        locked = await tx.query(f"""
            SELECT c.id FROM complaints c
            WHERE {which} AND c.status = 'new'
            ORDER BY c.id
            FOR UPDATE
        """)
        ids = [row['id'] for row in locked]
        # Саму жалобу закрыл кто-то другой — остальные не трогаем: решение
        # принимали по ней.
        if complaint_id not in ids:
            raise WarnException(409, 'Жалоба уже закрыта')
        closed = await tx.query(f"""
            UPDATE complaints c
               SET status = {fit_to_sql(body.outcome)},
                   resolution = {fit_to_sql(body.note)},
                   resolved_by = {fit_to_sql(admin['id'])},
                   resolved_at = {fit_to_sql(get_timestamp_now())}
             WHERE c.id = ANY(ARRAY[{', '.join(str(int(i)) for i in ids)}]::int[]) AND c.status = 'new'
            RETURNING c.id, c.reporter_id
        """)

    about = TARGET_LABELS[complaint['target_type']].lower()
    label = f"№{complaint_id}: {about} «{complaint['target_label']}»" if complaint['target_label'] \
        else f'№{complaint_id}: {about}'
    details = [body.note] if body.note else []
    if len(closed) > 1:
        details.append(f'закрыто жалоб на это же: {len(closed)}')
    await log_action(admin, OUTCOMES[body.outcome], 'complaint', complaint_id, label,
                     ' · '.join(details) or None,
                     # В названии — объявление: его владелец тоже «чьи данные».
                     subjects=[*(c['reporter_id'] for c in closed), complaint['target_user_id'],
                               complaint['target_owner_id']])
    return {'closed': len(closed)}
