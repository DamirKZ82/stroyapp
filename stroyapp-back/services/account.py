"""
Удаление пользователя вместе со всем, что с ним связано.

Нужно в двух местах: человек удаляет свой аккаунт из приложения
(DELETE /profile) и админ удаляет аккаунт из админки.

Каскадов в базе для этого не хватает: заявки и отзывы не удаляются вместе
с объявлением, а объявления и чёрные списки
собеседников — вместе с пользователем. Поэтому порядок удаления задан здесь
явно и идёт в одной транзакции: либо исчезает всё, либо ничего.
"""
import shutil

from connections.connect_postgres import query_db, transaction
from libs.common import fit_to_sql
from libs.photos import _uploads_root


def _ids(ids) -> str:
    """int-массив для = ANY(...); пустой тоже валиден (fit_to_sql дал бы ARRAY[] без типа)."""
    return f"ARRAY[{', '.join(str(int(i)) for i in ids)}]::int[]"


def _col(rows, key='id'):
    return [r[key] for r in rows or []]


async def owned_scope(user_ids: list):
    """Объявления этих пользователей."""
    return _col(await query_db(f"SELECT id FROM providers WHERE owner_id = ANY({_ids(user_ids)})"))


async def purge_users(user_ids: list, keep_login: bool = False) -> dict:
    """
    Удалить пользователей и всё их: объявления с фото, заявки, чаты, отзывы,
    избранное, чёрные списки собеседников — и то, что оставили на их
    объявлениях другие люди.

    keep_login=True оставляет саму строку пользователя (номер, имя, код):
    так чистится служебный аккаунт для ревью сторов. Проверяющий жмёт
    «Удалить аккаунт» — данные исчезают, а следующий проверяющий всё ещё
    может войти тем же номером.

    Возвращает счётчики удалённого — для ответа скрипту и для логов.
    """
    user_ids = [int(i) for i in user_ids]
    if not user_ids:
        return {}
    providers = await owned_scope(user_ids)
    u, p = _ids(user_ids), _ids(providers)

    async def delete(tx, table, where):
        rows = await tx.query(f"WITH d AS (DELETE FROM {table} WHERE {where} RETURNING 1) "
                              f"SELECT count(*) AS n FROM d")
        return rows[0]['n']

    async with transaction() as tx:
        bookings = _col(await tx.query(
            f"SELECT id FROM bookings WHERE provider_id = ANY({p}) OR client_id = ANY({u})"))
        b = _ids(bookings)
        # Порядок важен: у reviews/bookings нет ON DELETE CASCADE,
        # иначе DELETE объявлений упадёт.
        stats = {
            'reviews': await delete(tx, 'reviews',
                f"provider_id = ANY({p}) OR booking_id = ANY({b}) OR client_id = ANY({u})"),
            'chats': await delete(tx, 'chats',   # сообщения удаляются каскадом
                f"provider_id = ANY({p}) OR owner_id = ANY({u}) OR client_id = ANY({u})"),
        }
        await delete(tx, 'chat_messages', f"sender_id = ANY({u})")
        stats['bookings'] = await delete(tx, 'bookings', f"id = ANY({b})")
        stats['favorites'] = await delete(tx, 'favorites',
            f"provider_id = ANY({p}) OR user_id = ANY({u})")
        stats['providers'] = await delete(tx, 'providers', f"id = ANY({p})")   # фото, признаки, прайс — каскадом
        # Журналы ошибок и предупреждений остаются для диагностики, но уже
        # без привязки к человеку: внешних ключей у них нет, обнуляем сами.
        for table in ('errors_back', 'errors_front', 'warns'):
            await tx.query(f"UPDATE {table} SET user_id = null WHERE user_id = ANY({u})")
        # Жалобы — и поданные человеком, и поданные на него: в них его слова
        # или снимок его объявления и отзыва. Служебного аккаунта это касается
        # так же: «Удалить аккаунт» стирает всё, кроме самого входа.
        stats['complaints'] = await delete(
            tx, 'complaints', f"reporter_id = ANY({u}) OR target_user_id = ANY({u})")
        # Остались жалобы на чужие отзывы к его объявлениям: сама жалоба — о
        # другом человеке, но название объявления в её снимке — его.
        await tx.query(f"""
            UPDATE complaints SET target_label = null, target_owner_id = null
             WHERE target_owner_id = ANY({u})
        """)
        # Чёрные списки — в обе стороны: и кого заблокировал он, и кто
        # заблокировал его. У служебного аккаунта тоже, и тоже в обе: после
        # «Удалить аккаунт» от него остаётся только вход, переписок с ним уже
        # нет, и следующий проверяющий не должен унаследовать ни блокировок
        # предыдущего, ни чужих блокировок на него.
        stats['peer_blocks'] = await delete(
            tx, 'peer_blocks', f"user_id = ANY({u}) OR peer_id = ANY({u})")
        # Согласия с Условиями использования — запись о человеке. У служебного
        # аккаунта тоже: следующий проверяющий должен увидеть шаг согласия.
        stats['terms'] = await delete(tx, 'terms_acceptances', f"user_id = ANY({u})")
        # Тариф продавца — тоже данные человека. Оплаты остаются для
        # бухгалтерии, но уже ни с кем не связаны.
        await delete(tx, 'seller_plans', f"user_id = ANY({u})")
        await tx.query(f"UPDATE payments SET user_id = null WHERE user_id = ANY({u})")
        if keep_login:
            # Токен пуш-уведомлений — тоже данные человека, а не часть входа.
            await tx.query(f"UPDATE users SET fcm_token = null WHERE id = ANY({u})")
        else:
            # Журнал действий админов: что и когда сделано — остаётся, а чьё
            # это было объявление, чей отзыв и какой у человека номер — нет.
            # Текст удалённого отзыва — тоже данные его автора.
            await tx.query(f"""
                UPDATE admin_actions
                   SET target_label = null,
                       details = CASE WHEN action = 'review_delete' THEN null ELSE details END,
                       subject_user_ids = null
                 WHERE subject_user_ids && {u}
            """)
            await tx.query(f"UPDATE admin_actions SET admin_phone = null WHERE admin_id = ANY({u})")
            # Пароль админки, если человек был админом.
            await delete(tx, 'admin_credentials', f"user_id = ANY({u})")
            phones = _col(await tx.query(f"SELECT phone FROM users WHERE id = ANY({u})"), 'phone')
            for phone in phones:
                await delete(tx, 'otp_codes', f"phone = {fit_to_sql(phone)}")
            stats['users'] = await delete(tx, 'users', f"id = ANY({u})")

    # Файлы — только после коммита: при откате фото остались бы у живых строк.
    # id из SERIAL не переиспользуются, так что папки принадлежат только удалённым.
    root = _uploads_root()
    for i in providers:
        shutil.rmtree(root / 'providers' / str(i), ignore_errors=True)

    return stats
