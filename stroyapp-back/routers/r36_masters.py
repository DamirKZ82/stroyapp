"""
Мастер клиента.

Клиент, который делает ремонт, добавляет своего мастера (прораба, бригадира)
по номеру телефона. Мастер принимает приглашение и дальше оформляет заявки в
магазины от имени клиента: POST /bookings с master_link_guid. Такая заявка
сначала ждёт клиента (status 'awaiting_client') и уходит продавцу только
после его подтверждения — так клиент видит и контролирует каждую покупку.
Платит клиент продавцу напрямую, как и за любую заявку.

    GET    /masters                  — мои мастера (я клиент), мои клиенты (я мастер),
                                       приглашения мне
    POST   /masters                  — пригласить мастера: {phone, label?}
    POST   /masters/{guid}/accept    — принять приглашение (мастер)
    POST   /masters/{guid}/decline   — отказаться (мастер)
    DELETE /masters/{guid}           — убрать мастера (клиент) или выйти (мастер)

Приглашение ищется по номеру: мастер может ещё не быть в приложении — тогда
оно дождётся его первого входа.
"""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator

from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from handlers.h03_auth import auth_user
from libs.common import fit_to_sql, new_guid
from libs.date import get_timestamp_now
from libs.fcm import send_push
from libs.phone import normalize_phone
from libs.text_filter import Clean


router = APIRouter(prefix='/masters')

# Сколько мастеров у одного клиента и клиентов у одного мастера — с запасом
# на жизнь, но не на рассылку приглашений всем подряд.
MASTERS_LIMIT = 10
INVITES_PER_DAY = 20


class InviteBody(BaseModel):
    phone: str
    label: Optional[Clean] = None

    @field_validator('label')
    @classmethod
    def label_ok(cls, val):
        if val is None:
            return None
        val = ' '.join(val.split())
        if len(val) > 200:
            raise ValueError('Не длиннее 200 символов')
        return val or None


def _link_public(row: dict) -> dict:
    return {
        'guid': row['guid'],
        'status': row['status'],
        'created_at': row['created_at'],
        'accepted_at': row['accepted_at'],
    }


async def get_link(guid: str) -> Optional[dict]:
    rows = await query_db(f"SELECT * FROM client_masters WHERE guid = {fit_to_sql(guid)}")
    return rows[0] if rows else None


async def active_link_for_master(guid: str, master_id: int) -> dict:
    """Связь, от имени которой мастер оформляет заявку. Иначе — 403/404."""
    link = await get_link(guid)
    if link is None or link['master_id'] != master_id:
        raise WarnException(404, 'Клиент не найден')
    if link['status'] != 'active':
        raise WarnException(403, 'Клиент убрал вас из своих мастеров')
    return link


@router.get('')
async def list_masters(user=Depends(auth_user)):
    me = fit_to_sql(user['id'])
    phone = fit_to_sql(user['phone'])
    masters = await query_db(f"""
        SELECT m.*, u.full_name AS master_name
        FROM client_masters m
        LEFT JOIN users u ON u.id = m.master_id
        WHERE m.client_id = {me} AND m.status IN ('invited', 'active')
        ORDER BY m.id DESC
    """)
    clients = await query_db(f"""
        SELECT m.*, u.full_name AS client_name, u.phone AS client_phone
        FROM client_masters m
        JOIN users u ON u.id = m.client_id
        WHERE m.master_id = {me} AND m.status = 'active'
        ORDER BY m.id DESC
    """)
    invites = await query_db(f"""
        SELECT m.*, u.full_name AS client_name, u.phone AS client_phone
        FROM client_masters m
        JOIN users u ON u.id = m.client_id
        WHERE m.master_phone = {phone} AND m.status = 'invited'
          AND m.client_id <> {me}
        ORDER BY m.id DESC
    """)
    return {
        'masters': [{
            **_link_public(r),
            'phone': r['master_phone'],
            # Имя из профиля мастера, пока он не принял, ещё не наше дело:
            # показываем то, как его подписал сам клиент.
            'name': r['master_name'] if r['status'] == 'active' and r['master_name'] else r['master_label'],
        } for r in masters],
        'clients': [{
            **_link_public(r),
            'name': r['client_name'],
            'phone': r['client_phone'],
        } for r in clients],
        'invites': [{
            **_link_public(r),
            'name': r['client_name'],
            'phone': r['client_phone'],
        } for r in invites],
    }


@router.post('')
async def invite_master(body: InviteBody, user=Depends(auth_user)):
    phone = normalize_phone(body.phone)
    if phone == user['phone']:
        raise WarnException(400, 'Это ваш собственный номер')
    me = fit_to_sql(user['id'])
    live = await query_db(f"""
        SELECT master_phone FROM client_masters
        WHERE client_id = {me} AND status IN ('invited', 'active')
    """)
    if any(r['master_phone'] == phone for r in live):
        raise WarnException(409, 'Этот мастер уже добавлен')
    if len(live) >= MASTERS_LIMIT:
        raise WarnException(400, f'Мастеров не больше {MASTERS_LIMIT}. Уберите кого-нибудь из списка')
    now = get_timestamp_now()
    today = await query_db(f"""
        SELECT COUNT(*)::int AS n FROM client_masters
        WHERE client_id = {me} AND created_at >= {fit_to_sql(now[:10])}
    """)
    if today[0]['n'] >= INVITES_PER_DAY:
        raise WarnException(429, 'Слишком много приглашений за сегодня. Попробуйте завтра')

    guid = new_guid()
    await query_db(f"""
        INSERT INTO client_masters (guid, client_id, master_phone, master_label, status, created_at)
        VALUES ({fit_to_sql(guid)}, {me}, {fit_to_sql(phone)}, {fit_to_sql(body.label)},
                'invited', {fit_to_sql(now)})
        ON CONFLICT DO NOTHING
    """)
    master = await query_db(f"SELECT id FROM users WHERE phone = {fit_to_sql(phone)}")
    if master:
        await send_push(
            user_id=master[0]['id'],
            title='Вас добавили мастером',
            body=f"{user['full_name'] or 'Клиент'} хочет, чтобы вы заказывали материалы для его ремонта",
            data={'type': 'master_invite', 'link_guid': guid},
        )
    return await list_masters(user)


async def _invite_for_me(guid: str, user: dict) -> dict:
    link = await get_link(guid)
    if link is None or link['master_phone'] != user['phone'] or link['status'] != 'invited':
        raise WarnException(404, 'Приглашение не найдено')
    return link


@router.post('/{guid}/accept')
async def accept_invite(guid: str, user=Depends(auth_user)):
    link = await _invite_for_me(guid, user)
    now = get_timestamp_now()
    await query_db(f"""
        UPDATE client_masters
           SET status = 'active', master_id = {fit_to_sql(user['id'])}, accepted_at = {fit_to_sql(now)}
         WHERE id = {fit_to_sql(link['id'])} AND status = 'invited'
    """)
    await send_push(
        user_id=link['client_id'],
        title='Мастер принял приглашение',
        body=f"{user['full_name'] or user['phone']} теперь может заказывать материалы для вас. "
             f"Каждую покупку вы подтверждаете сами.",
        data={'type': 'master_accepted', 'link_guid': guid},
    )
    return await list_masters(user)


@router.post('/{guid}/decline')
async def decline_invite(guid: str, user=Depends(auth_user)):
    link = await _invite_for_me(guid, user)
    await query_db(f"""
        UPDATE client_masters SET status = 'declined', ended_at = {fit_to_sql(get_timestamp_now())}
         WHERE id = {fit_to_sql(link['id'])} AND status = 'invited'
    """)
    return await list_masters(user)


@router.delete('/{guid}')
async def remove_link(guid: str, user=Depends(auth_user)):
    """
    Клиент убирает мастера или мастер уходит сам. Заявки, которые мастер
    уже оформил и клиент ещё не подтвердил, остаются у клиента: решить по
    ним он может и без мастера.
    """
    link = await get_link(guid)
    if link is None or user['id'] not in (link['client_id'], link['master_id']) \
            or link['status'] not in ('invited', 'active'):
        raise WarnException(404, 'Мастер не найден')
    await query_db(f"""
        UPDATE client_masters SET status = 'removed', ended_at = {fit_to_sql(get_timestamp_now())}
         WHERE id = {fit_to_sql(link['id'])}
    """)
    return await list_masters(user)
