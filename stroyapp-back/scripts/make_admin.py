"""
Выдать или снять права администратора веб-админки /admin с сервера.

Запуск на сервере:
    docker compose exec backend python -m scripts.make_admin +77011234567
    docker compose exec backend python -m scripts.make_admin +77011234567 --revoke

Обычно админов назначают и снимают в самой админке (раздел «Пользователи»).
Скрипт нужен для самого первого админа и на случай, когда войти в админку
некому.

Если пользователя с таким номером ещё нет — он создаётся. Доступ включает
сам человек: открывает /admin, подтверждает номер кодом из SMS и задаёт
пароль. Поэтому номер должен быть настоящим.

Снятие прав стирает и пароль: при повторном назначении человек задаёт его
заново.
"""
import asyncio
import sys

from connections.connect_postgres import init_db, close_db, query_db
from handlers.h01_errors import WarnException
from libs.common import fit_to_sql, new_guid
from libs.date import get_timestamp_now
from libs.phone import normalize_phone
from services.seed import apply_migrations


ACTIVATE_HINT = ('   Доступ включает сам человек: открыть /admin → «Подтвердить номер по SMS» '
                 '→ задать пароль.')


async def main(raw_phone: str, revoke: bool) -> int:
    try:
        phone = normalize_phone(raw_phone)
    except WarnException:
        print(f'❌ Номер {raw_phone!r} не в формате +77XXXXXXXXX')
        return 1

    await init_db()
    try:
        # Та же идемпотентная миграция, что при старте бэка: скрипт
        # работает, даже если его запустили раньше, чем поднялся бэк.
        await apply_migrations()

        if not revoke:
            # Служебный аккаунт входит по постоянному коду из четырёх цифр.
            # С правами админа это вход в админку по коду, который видят и
            # могут сменить другие админы.
            service = await query_db(f"""
                SELECT id FROM users WHERE phone = {fit_to_sql(phone)} AND is_service = true
            """)
            if service:
                print(f'❌ {phone} — служебный аккаунт (вход по постоянному коду). '
                      'Права админа ему не выдаются: укажите обычный номер.')
                return 1

        before = await query_db(f"SELECT id, is_admin FROM users WHERE phone = {fit_to_sql(phone)}")
        if before and not before[0]['is_admin']:
            # Не был админом — значит, и пароля у него быть не должно. Если
            # строка всё же осталась от прошлого назначения, с ней права
            # вернули бы и старый пароль: доступ каждый раз включает сам человек.
            await query_db(f"DELETE FROM admin_credentials WHERE user_id = {fit_to_sql(before[0]['id'])}")

        now = get_timestamp_now()
        rows = await query_db(f"""
            UPDATE users
               SET is_admin = {fit_to_sql(not revoke)},
                   updated_at = {fit_to_sql(now)}
             WHERE phone = {fit_to_sql(phone)}
            RETURNING id, full_name
        """)

        if not rows and revoke:
            print(f'ℹ️  Пользователя {phone} нет — снимать нечего')
            return 0

        if revoke:
            await query_db(f"""
                DELETE FROM admin_credentials WHERE user_id = {fit_to_sql(rows[0]['id'])}
            """)

        if not rows:
            rows = await query_db(f"""
                INSERT INTO users (guid, phone, language, is_admin, created_at, updated_at)
                VALUES ({fit_to_sql(new_guid())}, {fit_to_sql(phone)}, 'ru', true,
                        {fit_to_sql(now)}, {fit_to_sql(now)})
                RETURNING id, full_name
            """)
            print(f'✅ Создан пользователь {phone} (id={rows[0]["id"]}) с правами админа')
            print(ACTIVATE_HINT)
            return 0

        verb = 'сняты' if revoke else 'выданы'
        print(f'✅ Права админа {verb}: {phone} (id={rows[0]["id"]})')
        if not revoke:
            print(ACTIVATE_HINT)
        return 0
    finally:
        await close_db()


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if a != '--revoke']
    if len(args) != 1:
        print(__doc__)
        sys.exit(2)
    sys.exit(asyncio.run(main(args[0], revoke='--revoke' in sys.argv)))
