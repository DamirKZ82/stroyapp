"""
Модерация: скрыть объявление, заблокировать человека, журнал действий админа.

Как устроено скрытие. У объявлений (магазины и бригады) уже есть признак
is_active — «опубликовано»; на него смотрят поиск, карточка, заявки и чаты.
Модератор пользуется им же: при скрытии is_active становится false,
прежнее значение запоминается в was_active, а hidden_at / hidden_reason
отмечают, что это сделал модератор, а не владелец. Владельцу остаётся одно
ограничение: пока объявление скрыто, опубликовать его обратно он не может
(refuse_publish_if_hidden и publish_sql).

Блокировка человека закрывает ему вход (is_blocked, проверяется в auth_user) и
заодно скрывает все его объявления с пометкой hidden_by_block — по ней они
возвращаются при разблокировке. То, что модератор скрыл отдельно и раньше,
разблокировка не трогает.

Журнал (admin_actions) хранит, кто из админов что сделал. Данные человека, над
которым совершено действие, живут в записи только пока жив его аккаунт: при
удалении аккаунта services/account.py стирает их по subject_user_ids.
"""
from typing import Optional

from config import config
from connections.connect_postgres import query_db, transaction
from handlers.h01_errors import WarnException
from libs.common import fit_to_sql
from libs.date import get_timestamp_now


SUPPORT_EMAIL = config['support_email']
BLOCK_HIDE_REASON = 'Аккаунт владельца заблокирован'

_TABLES = {'provider': 'providers'}
_NOT_FOUND = {'provider': 'Объявление не найдено'}
# Объявление (t) вместе с владельцем (u).
_WITH_OWNER = {'provider': 'providers t JOIN users u ON u.id = t.owner_id'}


def _hide_set(now: str, reason: str, by_block: bool) -> str:
    # was_active читает is_active до присваивания: в UPDATE правая часть
    # вычисляется по старой строке.
    return f"""was_active = is_active,
               is_active = false,
               hidden_at = {fit_to_sql(now)},
               hidden_reason = {fit_to_sql(reason)},
               hidden_by_block = {fit_to_sql(by_block)},
               updated_at = {fit_to_sql(now)}"""


def _unhide_set(now: str) -> str:
    # COALESCE: was_active пуст только у строк, скрытых в обход этого модуля.
    return f"""is_active = COALESCE(was_active, true),
               was_active = null,
               hidden_at = null,
               hidden_reason = null,
               hidden_by_block = false,
               updated_at = {fit_to_sql(now)}"""


def _owned_by(user_id: int):
    """(таблица, условие) для всех объявлений человека."""
    uid = fit_to_sql(int(user_id))
    return (
        ('providers', f'owner_id = {uid}'),
    )


async def listing_subject(kind: str, listing_id: int) -> dict:
    """Название объявления и id владельца — для журнала. Нет такого -> 404."""
    rows = await query_db(f"""
        SELECT t.name, u.id AS owner_id
        FROM {_WITH_OWNER[kind]}
        WHERE t.id = {fit_to_sql(listing_id)}
    """)
    if not rows:
        raise WarnException(404, _NOT_FOUND[kind])
    return rows[0]


async def hide_listing(kind: str, listing_id: int, reason: str) -> None:
    table = _TABLES[kind]
    rows = await query_db(f"""
        UPDATE {table}
           SET {_hide_set(get_timestamp_now(), reason, False)}
         WHERE id = {fit_to_sql(listing_id)} AND hidden_at IS NULL
        RETURNING id
    """)
    if rows:
        return
    exists = await query_db(f"SELECT id FROM {table} WHERE id = {fit_to_sql(listing_id)}")
    if not exists:
        raise WarnException(404, _NOT_FOUND[kind])
    raise WarnException(409, 'Уже скрыто')


async def unhide_listing(kind: str, listing_id: int) -> None:
    # Проверка и возврат — одной транзакцией с занятыми строками.
    # FOR UPDATE на объявлении: два возврата одновременно не выполнятся оба
    # (второй взял бы is_active из уже очищенного was_active и опубликовал то,
    # что владелец сам снимал).
    # FOR SHARE на владельце: блокировка человека, идущая в ту же секунду,
    # подождёт и скроет уже возвращённое. Без этого у заблокированного могло
    # остаться объявление в поиске.
    async with transaction() as tx:
        rows = await tx.query(f"""
            SELECT t.hidden_at, u.is_blocked AS owner_blocked
            FROM {_WITH_OWNER[kind]}
            WHERE t.id = {fit_to_sql(listing_id)}
            FOR UPDATE OF t FOR SHARE OF u
        """)
        if not rows:
            raise WarnException(404, _NOT_FOUND[kind])
        row = rows[0]
        if row['hidden_at'] is None:
            raise WarnException(409, 'Объявление не скрыто')
        if row['owner_blocked']:
            raise WarnException(409, 'Владелец заблокирован. Сначала разблокируйте его — объявления вернутся сами.')
        await tx.query(f"""
            UPDATE {_TABLES[kind]}
               SET {_unhide_set(get_timestamp_now())}
             WHERE id = {fit_to_sql(listing_id)}
        """)


async def block_user(user_id: int, reason: str) -> None:
    now = get_timestamp_now()
    async with transaction() as tx:
        rows = await tx.query(f"""
            UPDATE users
               SET is_blocked = true,
                   blocked_at = {fit_to_sql(now)},
                   blocked_reason = {fit_to_sql(reason)},
                   updated_at = {fit_to_sql(now)}
             WHERE id = {fit_to_sql(user_id)} AND is_blocked IS NOT TRUE
            RETURNING id
        """)
        if not rows:
            raise WarnException(409, 'Пользователь уже заблокирован')
        for table, where in _owned_by(user_id):
            await tx.query(f"""
                UPDATE {table}
                   SET {_hide_set(now, BLOCK_HIDE_REASON, True)}
                 WHERE {where} AND hidden_at IS NULL
            """)


async def unblock_user(user_id: int) -> None:
    now = get_timestamp_now()
    async with transaction() as tx:
        rows = await tx.query(f"""
            UPDATE users
               SET is_blocked = false,
                   blocked_at = null,
                   blocked_reason = null,
                   updated_at = {fit_to_sql(now)}
             WHERE id = {fit_to_sql(user_id)} AND is_blocked = true
            RETURNING id
        """)
        if not rows:
            raise WarnException(409, 'Пользователь не заблокирован')
        for table, where in _owned_by(user_id):
            await tx.query(f"""
                UPDATE {table}
                   SET {_unhide_set(now)}
                 WHERE {where} AND hidden_by_block = true
            """)


def refuse_publish_if_hidden(row: dict, wants_active: Optional[bool]) -> None:
    """
    Для PATCH владельца: скрытое модератором объявление опубликовать нельзя.
    Остальные поля владелец править может — например, чтобы устранить причину.
    """
    if wants_active and row.get('hidden_at'):
        reason = row.get('hidden_reason') or 'нарушение правил сервиса'
        raise WarnException(
            403,
            f'Объявление скрыто модератором. Причина: {reason}. '
            f'Вопросы — на {SUPPORT_EMAIL}',
        )


def publish_sql(wants_active: bool) -> str:
    """
    Присваивание is_active для UPDATE владельца.

    refuse_publish_if_hidden смотрит на строку, прочитанную в начале запроса.
    Если модератор скрыл объявление (или заблокировал владельца) уже после
    этого чтения, проверка пройдена, а публиковать нельзя — поэтому условие
    стоит и в самом UPDATE: опубликуется только то, что не скрыто сейчас.
    """
    return 'is_active = (hidden_at IS NULL)' if wants_active else 'is_active = false'


async def log_action(admin: dict, action: str, target_type: Optional[str] = None,
                     target_id: Optional[int] = None, label: Optional[str] = None,
                     details: Optional[str] = None, subjects: Optional[list] = None) -> None:
    """
    Записать действие админа.

    subjects — id пользователей, чьи данные попали в label и details (тот, над
    кем действие; владелец объявления; автор отзыва). Когда такой человек
    удаляет аккаунт, запись обезличивается: остаётся, что и когда сделано.
    """
    ids = sorted({int(i) for i in (subjects or []) if i is not None})
    await query_db(f"""
        INSERT INTO admin_actions
            (admin_id, admin_phone, action, target_type, target_id, target_label,
             details, subject_user_ids, created_at)
        VALUES (
            {fit_to_sql(admin['id'])},
            {fit_to_sql(admin['phone'])},
            {fit_to_sql(action)},
            {fit_to_sql(target_type)},
            {fit_to_sql(target_id)},
            {fit_to_sql(label)},
            {fit_to_sql(details)},
            {fit_to_sql(ids) if ids else 'null'},
            {fit_to_sql(get_timestamp_now())}
        )
    """)
