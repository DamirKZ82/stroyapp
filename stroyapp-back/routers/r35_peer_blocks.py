"""
Чёрный список собеседников — «Заблокировать собеседника» в приложении.

    POST   /chats/{guid}/peer-block   — заблокировать собеседника из этого чата
    DELETE /chats/{guid}/peer-block   — снять блокировку, не выходя из чата
    GET    /peer-blocks               — кого я заблокировал (экран «Заблокированные»)
    DELETE /peer-blocks/{guid}        — снять блокировку из этого списка

Блокируют человека, а присылают чат: идентификаторов пользователей приложение
не знает, и чёрный список их тоже не отдаёт — блокировку из него снимают по
guid самой записи. Что она закрывает и где стоят проверки — services/peer_blocks.

Отказов «уже заблокирован» и лимитов здесь нет: блокировка — защита человека,
не сработать она не должна. Повтор — обычный успех.

Список лежит под /peer-blocks, а не под /chats: GET /chats/{guid} из r33_chats
подключается раньше и забрал бы себе любой GET /chats/<слово>.
"""
import re

from fastapi import APIRouter, BackgroundTasks, Depends

from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from handlers.h03_auth import auth_user
from libs.common import fit_to_sql, new_guid
from libs.date import get_timestamp_now
from libs.telegram import send_to_admins
from services.peer_blocks import find_peer, notice_text, should_notify


router = APIRouter()

_GUID = re.compile(r'[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')


def _chat_guid(guid: str) -> str:
    # Не guid — значит, и чата такого нет; а строка с мусором до базы не дойдёт.
    if not _GUID.fullmatch(guid):
        raise WarnException(404, 'Чат не найден')
    return guid.lower()


@router.post('/chats/{guid}/peer-block')
async def block_peer(guid: str, background: BackgroundTasks, user=Depends(auth_user)):
    peer_id = await find_peer(_chat_guid(guid), user['id'])

    # ON CONFLICT, а не проверка перед вставкой: двойное нажатие и два
    # одновременных запроса дают одну строку и ни одной ошибки.
    rows = await query_db(f"""
        INSERT INTO peer_blocks (guid, user_id, peer_id, created_at)
        VALUES (
            {fit_to_sql(new_guid())},
            {fit_to_sql(user['id'])},
            {fit_to_sql(peer_id)},
            {fit_to_sql(get_timestamp_now())}
        )
        ON CONFLICT (user_id, peer_id) DO NOTHING
        RETURNING id
    """)
    if not rows:
        return {'ok': True, 'already': True}

    # Админам — только о новой блокировке, не о повторе. После ответа, а не
    # до: Telegram может отвечать секундами.
    if should_notify(user['id'], peer_id):
        background.add_task(send_to_admins, notice_text(user['id'], peer_id))
    return {'ok': True, 'already': False}


@router.delete('/chats/{guid}/peer-block')
async def unblock_peer(guid: str, user=Depends(auth_user)):
    peer_id = await find_peer(_chat_guid(guid), user['id'])
    await query_db(f"""
        DELETE FROM peer_blocks
        WHERE user_id = {fit_to_sql(user['id'])}
          AND peer_id = {fit_to_sql(peer_id)}
    """)
    # Можно ли теперь писать, ответ не говорит: собеседник мог заблокировать в
    # ответ. Приложение перечитывает чат и берёт это из его шапки.
    return {'ok': True}


@router.get('/peer-blocks')
async def list_peer_blocks(user=Depends(auth_user)):
    # chat_guid и subject_name — переписка с этим человеком и объявление, о
    # котором она. По объявлению владельца узнают скорее, чем по личному
    # имени, а по guid приложение открывает саму переписку: из списка чатов
    # она убрана, и другой дороги к истории, к «Пожаловаться» и к
    # «Разблокировать» в чате нет. У владельца — совсем: переписку по своему
    # объявлению через само объявление не открыть.
    # Если переписок несколько, берём ту, где писали последней, а не ту, что
    # создана позже: пустой чат, который заблокированный откроет кнопкой
    # «Написать» на другом объявлении, не должен подменять разговор.
    # Переписки может не быть вовсе: чат зала удаляется вместе с залом, а
    # блокировка остаётся.
    # Ни телефона, ни id заблокированного в ответе нет — приложению они не нужны.
    rows = await query_db(f"""
        SELECT pb.guid, u.full_name AS name, pb.created_at,
               lc.chat_guid, lc.subject_name
        FROM peer_blocks pb
        LEFT JOIN users u ON u.id = pb.peer_id
        LEFT JOIN LATERAL (
            SELECT c.guid AS chat_guid, COALESCE(h.name, p.name) AS subject_name
            FROM chats c
            LEFT JOIN halls h ON h.id = c.hall_id
            LEFT JOIN providers p ON p.id = c.provider_id
            WHERE (c.client_id = pb.user_id AND c.owner_id = pb.peer_id)
               OR (c.client_id = pb.peer_id AND c.owner_id = pb.user_id)
            ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
            LIMIT 1
        ) lc ON true
        WHERE pb.user_id = {fit_to_sql(user['id'])}
        ORDER BY pb.id DESC
    """)
    return {'items': rows}


@router.delete('/peer-blocks/{guid}')
async def remove_peer_block(guid: str, user=Depends(auth_user)):
    # Ответ один и тот же, была ли такая запись, чья она и guid ли это вообще:
    # иначе по ответам можно было бы нащупывать чужие записи.
    if _GUID.fullmatch(guid):
        await query_db(f"""
            DELETE FROM peer_blocks
            WHERE guid = {fit_to_sql(guid.lower())}
              AND user_id = {fit_to_sql(user['id'])}
        """)
    return {'ok': True}
