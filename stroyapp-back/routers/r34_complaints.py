"""
Жалобы из приложения.

    POST /complaints   — пожаловаться на зал, исполнителя, отзыв или собеседника

Только для вошедших: у жалобы должен быть автор, иначе её не с кем уточнить
и нечем ограничить поток. Разбирают жалобы в админке (r93_admin_complaints).
"""
import re
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel, field_validator, model_validator

from connections.connect_postgres import transaction
from handlers.h01_errors import WarnException
from handlers.h03_auth import auth_user
from libs.common import clean_text, fit_to_sql
from libs.date import add_minutes, get_timestamp_now
from libs.telegram import send_to_admins
from services.complaints import (
    COMMENT_MAX,
    DAILY_LIMIT,
    OTHER_COMMENT_MIN,
    REASONS,
    find_target,
    notice_text,
)


router = APIRouter()

_GUID = re.compile(r'[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
# Первое число пары для pg_advisory_xact_lock: очередь жалоб одного человека.
_LOCK_COMPLAINTS = 20261007


class ComplaintBody(BaseModel):
    target_type: str
    target_guid: str
    reason: str
    comment: Optional[str] = None

    @field_validator('target_type')
    @classmethod
    def type_known(cls, val):
        if val not in REASONS:
            raise ValueError(f'target_type должен быть одним из: {sorted(REASONS)}')
        return val

    @field_validator('target_guid')
    @classmethod
    def guid_shaped(cls, val):
        # Не guid — значит, и искать нечего; а строка с мусором до базы не дойдёт.
        if not _GUID.fullmatch(val):
            raise ValueError('Некорректный идентификатор')
        return val.lower()

    @field_validator('comment')
    @classmethod
    def comment_ok(cls, val):
        if val is None:
            return None
        val = clean_text(val).strip()
        if len(val) > COMMENT_MAX:
            raise ValueError(f'Комментарий не должен быть длиннее {COMMENT_MAX} символов')
        return val or None

    @model_validator(mode='after')
    def reason_fits(self):
        if self.reason not in REASONS[self.target_type]:
            raise ValueError('Выберите причину жалобы')
        if self.reason == 'other' and len(self.comment or '') < OTHER_COMMENT_MIN:
            raise ValueError('Опишите, что не так: без пояснения жалобу не разобрать')
        return self


@router.post('/complaints')
async def create_complaint(body: ComplaintBody, background: BackgroundTasks,
                           user=Depends(auth_user)):
    target = await find_target(body.target_type, body.target_guid, user['id'])
    now = get_timestamp_now()
    me = fit_to_sql(user['id'])

    async with transaction() as tx:
        # Жалобы одного человека идут по очереди: иначе сто одновременных
        # запросов все увидели бы «за сутки ещё меньше лимита» и прошли.
        await tx.query(f"SELECT pg_advisory_xact_lock({_LOCK_COMPLAINTS}, {me})")

        # Одна неразобранная жалоба от человека на одно и то же: повторная
        # ничего не добавит. Проверяем раньше лимита — повтор не жалоба.
        same = await tx.query(f"""
            SELECT id FROM complaints
            WHERE reporter_id = {me}
              AND target_type = {fit_to_sql(body.target_type)}
              AND target_id = {fit_to_sql(target['id'])}
              AND status = 'new'
        """)
        if same:
            return {'ok': True, 'already': True}

        recent = await tx.query(f"""
            SELECT COUNT(*)::int AS n FROM complaints
            WHERE reporter_id = {me} AND created_at > {fit_to_sql(add_minutes(now, -24 * 60))}
        """)
        if recent[0]['n'] >= DAILY_LIMIT:
            raise WarnException(429, 'Слишком много жалоб за сутки. Попробуйте завтра.')

        # ON CONFLICT — страховка к проверке выше: то же условие стоит в
        # уникальном индексе.
        rows = await tx.query(f"""
            INSERT INTO complaints
                (reporter_id, target_type, target_id, target_user_id, target_owner_id,
                 target_label, target_text, reason, comment, status, created_at)
            VALUES (
                {me},
                {fit_to_sql(body.target_type)},
                {fit_to_sql(target['id'])},
                {fit_to_sql(target['user_id'])},
                {fit_to_sql(target['owner_id'])},
                {fit_to_sql(target['label'])},
                {fit_to_sql(target['text'])},
                {fit_to_sql(body.reason)},
                {fit_to_sql(body.comment)},
                'new',
                {fit_to_sql(now)}
            )
            ON CONFLICT (reporter_id, target_type, target_id) WHERE status = 'new' DO NOTHING
            RETURNING id
        """)
        if not rows:
            return {'ok': True, 'already': True}

    # После ответа, а не до: Telegram может отвечать секундами.
    background.add_task(send_to_admins, notice_text(rows[0]['id'], body.target_type, body.reason))
    return {'ok': True, 'already': False}
