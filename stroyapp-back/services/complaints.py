"""
Жалобы пользователей на объявления, отзывы и собеседников в переписке.

Жалоба — рабочая запись для модератора. В ней лежит снимок того, на что
пожаловались (название объявления, текст отзыва): к моменту разбора владелец
мог объявление удалить или переписать, а разбирать нужно то, что видел
заявитель.

Саму переписку к жалобе не прикладываем: личные сообщения модератор не читает
(см. r91_admin_users). По жалобе на собеседника он видит, кто на кого
пожаловался, о каком объявлении шёл разговор и что написал заявитель.

Жалобы удаляются вместе с аккаунтом заявителя и вместе с аккаунтом того, на
кого они поданы (services/account.py): и текст жалобы, и снимок — чьи-то
данные, а после удаления аккаунта мы их не храним.
"""
from config import config
from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from libs.common import fit_to_sql


# На что можно пожаловаться и с какой причиной. Причины — коды: подписи к ним
# у приложения свои, на языке интерфейса.
REASONS = {
    'provider': ('false_info', 'photos', 'fraud', 'offensive', 'spam', 'other'),
    'review': ('offensive', 'spam', 'false_info', 'other'),
    'chat': ('offensive', 'fraud', 'spam', 'other'),
}

# Подписи для админки, журнала и уведомления админам.
REASON_LABELS = {
    'false_info': 'Недостоверная информация',
    'photos': 'Чужие или неуместные фото',
    'fraud': 'Мошенничество',
    'offensive': 'Оскорбления или непристойное',
    'spam': 'Спам или реклама',
    'other': 'Другое',
}
TARGET_LABELS = {'provider': 'Объявление', 'review': 'Отзыв', 'chat': 'Переписка'}

STATUSES = ('new', 'resolved', 'rejected')

COMMENT_MAX = 1000
# «Другое» без пояснения разобрать нельзя — модератор не узнает, в чём дело.
OTHER_COMMENT_MIN = 5
# Больше — уже не жалобы, а способ завалить модератора.
DAILY_LIMIT = 20

_OWN = {
    'provider': 'Это ваше объявление — пожаловаться на него нельзя',
    'review': 'Это ваш отзыв — пожаловаться на него нельзя',
    # Бывает, когда владелец написал сам себе из карточки своего объявления.
    'chat': 'Это переписка с самим собой — жаловаться не на кого',
}


async def find_target(target_type: str, guid: str, user_id: int) -> dict:
    """
    Найти то, на что жалуются. Вернёт id, user_id (на кого по сути жалоба),
    owner_id (чьё объявление в снимке), название и текст для снимка. Нет
    такого или человеку его не видно — 404, своё — 400.
    """
    g = fit_to_sql(guid)
    if target_type == 'provider':
        rows = await query_db(f"""
            SELECT p.id, p.name AS label, p.owner_id AS user_id, p.owner_id, null AS text,
                   (p.is_active IS TRUE) AS visible
            FROM providers p
            WHERE p.guid = {g}
        """)
        missing = 'Объявление не найдено'
    elif target_type == 'review':
        rows = await query_db(f"""
            SELECT r.id, p.name AS label, r.client_id AS user_id,
                   p.owner_id, r.text,
                   true AS visible
            FROM reviews r
            LEFT JOIN providers p ON p.id = r.provider_id
            WHERE r.guid = {g}
        """)
        missing = 'Отзыв не найден'
    else:
        # Переписку видят только двое: чужой guid — «не найдено», а не «нельзя».
        rows = await query_db(f"""
            SELECT c.id, p.name AS label, c.owner_id, null AS text,
                   CASE WHEN c.client_id = {fit_to_sql(user_id)} THEN c.owner_id ELSE c.client_id END AS user_id,
                   (c.client_id = {fit_to_sql(user_id)} OR c.owner_id = {fit_to_sql(user_id)}) AS visible
            FROM chats c
            LEFT JOIN providers p ON p.id = c.provider_id
            WHERE c.guid = {g}
        """)
        missing = 'Переписка не найдена'

    if not rows or not rows[0]['visible']:
        raise WarnException(404, missing)
    target = rows[0]
    if target['user_id'] == user_id:
        raise WarnException(400, _OWN[target_type])
    return target


def notice_text(complaint_id: int, target_type: str, reason: str) -> str:
    """
    Короткое сообщение админам. В нём нет ничего, что написал пользователь:
    ни названия объявления, ни текста жалобы. Название задаёт владелец, и
    строка «Разобрать: <чужой адрес>» внутри него выглядела бы в сообщении
    как наша — а по ссылке из него админы входят в админку.
    """
    # Ссылка открывает админку сразу на этой жалобе.
    where = (f"{config['public_url']}/admin#complaints/{complaint_id}"
             if config['public_url'] else 'админка → Жалобы')
    return (f'🚩 StroyApp: новая жалоба №{complaint_id}\n'
            f'На что: {TARGET_LABELS[target_type].lower()}\n'
            f'Причина: {REASON_LABELS[reason]}\n'
            f'Разобрать: {where}')
