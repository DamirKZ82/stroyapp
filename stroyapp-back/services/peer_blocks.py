"""
Чёрный список собеседников: человек закрывает для себя переписку с другим
(«Заблокировать собеседника» в чате приложения).

Это НЕ блокировка аккаунта админом (users.is_blocked, services/moderation.py).
Там человеку закрыт вход; здесь оба аккаунта работают, но эти двое больше не
пишут друг другу и не отправляют друг другу заявок. Чтобы одно не приняли за
другое ни в коде, ни в поиске по проекту, здесь везде слово peer
(«собеседник»).

Блокировка — между двумя людьми, а не внутри чата: у пары бывает несколько
чатов (по одному на объявление), и роли в них бывают обратными. Действует она
на пару целиком и в обе стороны: кто бы из двоих ни заблокировал, написать не
может ни один. У того, кто заблокировал, чаты с этим человеком ещё и пропадают
из списка; у второго всё остаётся на месте.

Строка peer_blocks — «user_id заблокировал peer_id». В проверках это записано
только здесь: чаты (r33_chats) и заявки (r30_bookings) берут готовые условия
из either_blocked_sql и blocked_by_sql — перепутать, кто кого, там негде.
Сами строки создаёт и удаляет r35_peer_blocks.

Разблокировка удаляет строку: истории блокировок нет. Вместе с аккаунтом
строки удаляются в обе стороны (services/account.py).
"""
from config import config
from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from libs.common import fit_to_sql
from libs.date import get_date_today


# О скольких разных собеседниках одного человека сообщать админам за день.
# Дальше это уже не новость для модератора, а шум в общем чате.
NOTICE_DAILY_MAX = 3

# Тому, кого заблокировали, причину не называем: только то, что сейчас нельзя.
# Отказы пишутся в журнал (warns), поэтому имён в текстах нет.
_REFUSED = {
    'message': 'Написать этому пользователю сейчас нельзя',
    'booking': 'Отправить заявку этому пользователю сейчас нельзя',
}
_REFUSED_BY_ME = 'Вы заблокировали этого пользователя. Снять блокировку можно в профиле, в разделе «Заблокированные».'


def either_blocked_sql(a: str, b: str) -> str:
    """
    SQL-условие «кто-то из двоих заблокировал другого». a и b — готовые
    SQL-выражения: fit_to_sql(число) или имя колонки. Не строки от
    пользователя — сюда они вставляются как есть.
    """
    return (f"EXISTS (SELECT 1 FROM peer_blocks pb"
            f" WHERE (pb.user_id = {a} AND pb.peer_id = {b})"
            f" OR (pb.user_id = {b} AND pb.peer_id = {a}))")


def blocked_by_sql(who: str, whom: str) -> str:
    """SQL-условие «who заблокировал whom». Аргументы — как у either_blocked_sql."""
    return (f"EXISTS (SELECT 1 FROM peer_blocks pb"
            f" WHERE pb.user_id = {who} AND pb.peer_id = {whom})")


async def find_peer(chat_guid: str, user_id: int) -> int:
    """
    Собеседник человека в этом чате: его блокируют и с него снимают
    блокировку. Приложение присылает чат, а не человека — идентификаторов
    пользователей оно не знает. Нет такого чата или человек в нём не
    участвует — 404, чат с самим собой — 400.
    """
    me = fit_to_sql(user_id)
    rows = await query_db(f"""
        SELECT CASE WHEN c.client_id = {me} THEN c.owner_id ELSE c.client_id END AS peer_id,
               (c.client_id = {me} OR c.owner_id = {me}) AS visible
        FROM chats c
        WHERE c.guid = {fit_to_sql(chat_guid)}
    """)
    # Переписку видят только двое: чужой guid — «не найдено», а не «нельзя».
    if not rows or not rows[0]['visible']:
        raise WarnException(404, 'Чат не найден')
    peer_id = rows[0]['peer_id']
    # Без этой проверки вставка упёрлась бы в CHECK таблицы, и человек получил
    # бы сбой сервера вместо объяснения.
    if peer_id == user_id:
        raise WarnException(400, 'Это переписка с самим собой — блокировать некого')
    return peer_id


async def refusal(user_id: int, peer_id: int, what: str) -> WarnException:
    """
    Отказ для того, чьё сообщение или заявку (what: 'message' | 'booking') не
    пропустила проверка пары. Исключение возвращается — бросает его вызывающий.

    Вызывать только когда вставка не вернула строк и только вне открытой
    транзакции. Запрос здесь берёт своё соединение, а в пуле их 10 на воркер:
    десять одновременных отказов, каждый с открытой транзакцией и в ожидании
    второго соединения, заперли бы пул.
    """
    rows = await query_db(f"""
        SELECT 1 AS x FROM peer_blocks
        WHERE user_id = {fit_to_sql(user_id)} AND peer_id = {fit_to_sql(peer_id)}
    """)
    # Заблокировавшему говорим как есть и где блокировку снять — иначе он не
    # поймёт, почему у него самого ничего не отправляется.
    if rows:
        return WarnException(403, _REFUSED_BY_ME)
    return WarnException(403, _REFUSED[what])


def notice_text(user_id: int, peer_id: int) -> str:
    """
    Короткое сообщение админам о новой блокировке. В нём только номера
    пользователей и ссылка в админку — ни имён, ни телефонов, ни названий
    объявлений: имя человек задаёт себе сам, и строка с чужим адресом внутри
    него выглядела бы в сообщении как наша (то же, что в complaints.notice_text).
    """
    # Ссылка открывает того, кого заблокировали: модератору смотреть на него.
    where = (f"{config['public_url']}/admin#users/{peer_id}"
             if config['public_url'] else 'админка → Пользователи')
    return ('ToiApp: блокировка собеседника\n'
            f'Пользователь №{user_id} закрыл для себя переписку с пользователем №{peer_id}\n'
            f'Кого заблокировали: {where}')


# О чьих блокировках админам сегодня уже сообщили: {user_id: {peer_id, ...}}.
# В памяти процесса, а не в базе: разблокировка удаляет строку, и по базе не
# узнать, что об этой паре уже сообщали, — «заблокировал, снял, заблокировал»
# слало бы уведомление каждый раз. Плата за это: воркеров два, счёт у каждого
# свой, так что потолок на деле вдвое выше, а после перезапуска счёт начинается
# заново.
_noticed = {'day': '', 'peers': {}}


def should_notify(user_id: int, peer_id: int) -> bool:
    """
    Сообщать ли админам об этой блокировке: об одной паре — раз в день, и не
    больше чем о NOTICE_DAILY_MAX собеседниках одного человека за день.
    """
    today = get_date_today()
    if _noticed['day'] != today:
        _noticed['day'] = today
        _noticed['peers'] = {}
    peers = _noticed['peers'].setdefault(user_id, set())
    if peer_id in peers or len(peers) >= NOTICE_DAILY_MAX:
        return False
    peers.add(peer_id)
    return True
