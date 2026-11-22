"""
Доступ в админку: пароль, подтверждение по SMS, лимиты, назначение админов.

Как человек становится админом.

1. Действующий админ назначает его в админке по номеру телефона. Первого
   админа назначает скрипт scripts/make_admin.py с сервера. В users ставится
   is_admin.
2. Назначенный сам открывает /admin, подтверждает номер кодом из SMS и
   задаёт пароль. Доступ появляется только с этого момента: пока пароля нет,
   нет и строки в admin_credentials, а без неё auth_admin не пускает.
3. Дальше он входит по номеру и паролю. Забыл пароль — снова SMS и новый
   пароль; все прежние входы при этом перестают работать (session_version).

Код из SMS здесь свой, не тот, что у входа в приложение: шесть цифр и считаные
коды в сутки. Код приложения — четыре цифры и до 25 попыток в час; если бы
пароль админки сбрасывался им, пароль ничего бы не стоил.

Пароль хранится только хэшем (libs/passwords.py) и в отдельной таблице:
строку users читают десятки запросов, и хэш не должен попасть ни в один.

Назначить и снять админа может только тот, кто заново ввёл свой пароль:
открытая на чужом компьютере вкладка сама по себе новых админов не заведёт.

Все лимиты здесь считаются прежде всего на пару «кто + откуда». Тот, кто знает
номер админа, не должен суметь запереть его: ни неудачными входами, ни
запросами кодов. Свой счёт он исчерпывает сам, чужой — нет.

В таблицах этого файла вместо номеров, адресов, кодов и талонов лежат их
отпечатки (_key): по ним можно считать попытки и сверять код, но не прочитать,
кто, откуда и с каким кодом входил.
"""
import hashlib
import hmac
import ipaddress
import secrets
import time
from typing import Optional

from fastapi import Request

from config import config
from connections.connect_postgres import query_db, transaction
from handlers.h01_errors import WarnException
from handlers.h03_auth import BLOCKED_MESSAGE
from libs import passwords
from libs.common import fit_to_sql, new_guid
from libs.date import add_minutes, get_timestamp_now


BUSY_MESSAGE = 'Сервер занят: слишком много попыток входа сразу. Попробуйте через минуту.'
ADMINS_ONLY = 'Доступ только для администраторов'

# Первые числа пар для pg_advisory_xact_lock: очередь запросов кода на один
# номер и с одного адреса. Берутся всегда в этом порядке — номер, потом адрес.
_LOCK_SMS_PHONE = 20261008
_LOCK_SMS_ADDRESS = 20261009

# Сколько помнить адрес, с которого админ входил: дольше — уже не «его обычный».
_KNOWN_ADDRESS_DAYS = 90

# Кто может войти в админку и задать пароль: условие для запросов к users u.
_ACTIVE_ADMIN = 'u.is_admin IS TRUE AND u.is_service IS NOT TRUE AND u.is_blocked IS NOT TRUE'


def _key(kind: str, value: str) -> str:
    digest = hmac.new(config['jwt']['secret'].encode(), f'{kind}:{value}'.encode(), hashlib.sha256)
    return digest.hexdigest()[:40]


def _address_key(address: Optional[str]) -> str:
    """Отпечаток адреса для SQL. Без надёжного адреса — null: пара считается по одному номеру."""
    return fit_to_sql(_key('address', address) if address else None)


# -------------------------------------------------------------------------
# Лимит на подбор пароля
# -------------------------------------------------------------------------

def client_address(request: Request) -> Optional[str]:
    """
    Адрес клиента для лимитов. None — если надёжно его не узнать.

    Берём X-Real-IP: его ставит наш nginx по самому соединению, клиент на
    него не влияет. request.client здесь не годится: uvicorn в проде доверяет
    всем прокси и берёт первый адрес из X-Forwarded-For, а первый — тот, что
    прислал сам клиент. Без nginx (разработка) заголовка нет, и остаётся
    адрес соединения.

    Частный или локальный адрес значит, что перед нами не клиент, а прокси
    или шлюз. По общему на всех адресу считать нельзя: чужие неудачи закрыли
    бы вход каждому. Тогда счёт идёт только по номеру.
    """
    host = request.headers.get('x-real-ip') or (request.client.host if request.client else '')
    try:
        address = ipaddress.ip_address(host.strip())
    except ValueError:
        return None
    if address.version == 6 and address.ipv4_mapped:
        address = address.ipv4_mapped
    if not address.is_global:
        return None
    if address.version == 6:
        # Одному абоненту IPv6 выдают целую подсеть /64: считать каждый её
        # адрес отдельно — значит не ограничить ничего.
        return str(ipaddress.ip_network(f'{address}/64', strict=False).network_address)
    return str(address)


def login_subject(phone: str) -> str:
    """Чей пароль подбирают при входе: номер телефона."""
    return _key('login', phone)


def confirm_subject(user_id: int) -> str:
    """
    Чей пароль проверяют при подтверждении действия. Счёт отдельный от входа
    и привязан к вошедшему админу: неудачными входами с улицы его не занять —
    иначе посторонний, зная номер, не давал бы админу снять права с другого.
    """
    return _key('confirm', str(user_id))


async def _take_attempt(subject: str, address: Optional[str]) -> None:
    """
    Занять попытку ввода пароля. Лимит исчерпан — 429.

    Попытка записывается до проверки пароля, а не после неудачи: сто
    одновременных запросов иначе все прошли бы проверку «ещё не было пяти
    неудач» и дали сто попыток вместо пяти.

    Главный лимит — на пару «чей пароль + откуда»: тот, кто подбирает пароль
    со своего адреса, запирает только себя. Два потолка сверху — на случай
    многих адресов и многих номеров. Потолок на номер не касается адреса, с
    которого этот пароль уже вводили верно (admin_known_addresses): иначе
    подбор с десятка адресов закрыл бы вход и самому хозяину пароля.
    """
    limits = config['admin']
    now = get_timestamp_now()
    since = fit_to_sql(add_minutes(now, -limits['login_window_minutes']))
    subject_key = fit_to_sql(subject)
    address_key = _address_key(address)

    # Записи старше окна уже не влияют ни на один лимит.
    await query_db(f"DELETE FROM admin_login_attempts WHERE created_at < {since}")
    attempt = await query_db(f"""
        INSERT INTO admin_login_attempts (subject_key, address_key, created_at)
        VALUES ({subject_key}, {address_key}, {fit_to_sql(now)})
        RETURNING id
    """)
    counts = await query_db(f"""
        SELECT COUNT(*) FILTER (WHERE subject_key = {subject_key}
                                  AND address_key IS NOT DISTINCT FROM {address_key})::int AS pair,
               COUNT(*) FILTER (WHERE subject_key = {subject_key})::int AS by_subject,
               COUNT(*) FILTER (WHERE address_key = {address_key})::int AS by_address,
               EXISTS (SELECT 1 FROM admin_known_addresses k
                        WHERE k.subject_key = {subject_key} AND k.address_key = {address_key}) AS known
        FROM admin_login_attempts
        WHERE created_at >= {since}
          AND (subject_key = {subject_key} OR address_key = {address_key})
    """)
    found = counts[0]
    if found['pair'] > limits['login_max_failures'] \
            or (found['by_subject'] > limits['login_max_failures_phone'] and not found['known']) \
            or found['by_address'] > limits['login_max_failures_ip']:
        # Отказ попыткой не считаем: иначе тот, кто продолжает нажимать
        # «Войти», сам отодвигал бы себе конец ожидания.
        await query_db(f"DELETE FROM admin_login_attempts WHERE id = {fit_to_sql(attempt[0]['id'])}")
        raise WarnException(429, f"Слишком много неудачных попыток. Подождите "
                                 f"{limits['login_window_minutes']} минут или подтвердите номер по SMS.")


async def check_password(subject: str, address: Optional[str], password: str,
                         stored_hash: Optional[str]) -> bool:
    """
    Проверить пароль с учётом лимита попыток. stored_hash=None — пароля у
    номера нет: попытка всё равно тратится, а ответ занимает столько же времени.
    """
    try:
        # Место в очереди на хэш занимаем до записи попытки: при переполнении
        # отказ уходит сразу, не оставляя в таблице ни строки.
        async with passwords.place_in_line():
            await _take_attempt(subject, address)
            matched = await passwords.verify_password(password, stored_hash)
    except passwords.TooBusy:
        raise WarnException(429, BUSY_MESSAGE)
    if not matched:
        return False
    # Верный пароль — не подбор: счёт этой пары начинается заново. Чужие
    # неудачи с других адресов остаются за теми, кто их сделал.
    subject_key, address_key = fit_to_sql(subject), _address_key(address)
    await query_db(f"""
        DELETE FROM admin_login_attempts
         WHERE subject_key = {subject_key} AND address_key IS NOT DISTINCT FROM {address_key}
    """)
    if address:
        # Запоминаем адрес как «свой» для этого пароля — см. _take_attempt.
        now = get_timestamp_now()
        await query_db(f"""
            INSERT INTO admin_known_addresses (subject_key, address_key, last_seen_at)
            VALUES ({subject_key}, {address_key}, {fit_to_sql(now)})
            ON CONFLICT (subject_key, address_key) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
        """)
        await query_db(f"""
            DELETE FROM admin_known_addresses
             WHERE last_seen_at < {fit_to_sql(add_minutes(now, -_KNOWN_ADDRESS_DAYS * 24 * 60))}
        """)
    return True


async def _forget_login_history(tx_or_none, phone: str) -> None:
    """
    Пароль сменили или права сняли: неудачные попытки относились к прежнему
    паролю, а «свои» адреса — к прежнему доступу (среди них мог быть и адрес
    того, из-за кого пароль меняют).
    """
    run = tx_or_none.query if tx_or_none else query_db
    subject_key = fit_to_sql(login_subject(phone))
    await run(f"DELETE FROM admin_login_attempts WHERE subject_key = {subject_key}")
    await run(f"DELETE FROM admin_known_addresses WHERE subject_key = {subject_key}")


# -------------------------------------------------------------------------
# Код из SMS для задания пароля
# -------------------------------------------------------------------------

async def request_sms_code(phone: str, address: Optional[str]) -> tuple:
    """
    Запросить код для задания пароля. Вернёт (талон, выданное): выданное —
    (админ, код), если код надо отправить, иначе None.

    Талон — случайная строка, которую получает только тот, кто запросил код.
    Проверить код можно лишь вместе с ним. Поэтому посторонний, зная номер
    админа, не может ни потратить попытки чужого кода, ни погасить его своим
    запросом: его запрос создаёт отдельный код со своим талоном.

    Снаружи запрос выглядит одинаково для любого номера: он записывается и
    считается в лимитах, даже когда номер не админ и кода нет. Иначе по
    ответам можно было бы узнать, чей номер имеет доступ в админку. SMS не
    админу не уходит.
    """
    limits = config['admin']
    now = get_timestamp_now()
    phone_key = fit_to_sql(_key('sms', phone))
    address_key = _address_key(address)
    same_pair = f'phone_key = {phone_key} AND address_key IS NOT DISTINCT FROM {address_key}'
    ticket = secrets.token_urlsafe(24)

    async with transaction() as tx:
        # Запросы на один номер и с одного адреса идут по очереди:
        # одновременные иначе все прошли бы проверку лимита.
        await tx.query(f"SELECT pg_advisory_xact_lock({_LOCK_SMS_PHONE}, hashtext({fit_to_sql(phone)}))")
        if address:
            await tx.query(f"SELECT pg_advisory_xact_lock({_LOCK_SMS_ADDRESS}, hashtext({fit_to_sql(address)}))")
        await tx.query(f"""
            DELETE FROM admin_sms_codes WHERE created_at < {fit_to_sql(add_minutes(now, -24 * 60))}
        """)
        recent = await tx.query(f"""
            SELECT COUNT(*) FILTER (WHERE {same_pair}
                                      AND created_at > {fit_to_sql(add_minutes(now, -1))})::int AS pair_minute,
                   COUNT(*) FILTER (WHERE {same_pair})::int AS pair_day,
                   COUNT(*) FILTER (WHERE phone_key = {phone_key})::int AS phone_day,
                   COUNT(*) FILTER (WHERE address_key = {address_key})::int AS address_day
            FROM admin_sms_codes
            WHERE phone_key = {phone_key} OR address_key = {address_key}
        """)
        found = recent[0]
        if found['pair_minute']:
            raise WarnException(429, 'Код уже запрошен. Повторить можно через минуту.')
        if found['pair_day'] >= limits['sms_codes_per_day'] \
                or found['phone_day'] >= limits['sms_codes_per_day_phone'] \
                or found['address_day'] >= limits['sms_codes_per_day_ip']:
            raise WarnException(429, 'Слишком много запросов кода за сутки. Попробуйте завтра.')

        admins = await tx.query(f"""
            SELECT u.id, u.phone, u.full_name FROM users u
            WHERE u.phone = {fit_to_sql(phone)} AND {_ACTIVE_ADMIN}
        """)
        code = None
        if admins:
            # Постоянный код — только там, где режим разработки задан явно:
            # сервер, на котором забыли TOYHANA_ENV, тоже считает себя dev.
            mock = config['env'] == 'dev' and config['env_explicit']
            code = limits['sms_mock_code'] if mock else f'{secrets.randbelow(10 ** 6):06d}'

        # Новый запрос гасит прежний код того же человека — с того же адреса.
        # Коды, запрошенные с других адресов, остаются при своих талонах.
        await tx.query(f"UPDATE admin_sms_codes SET used = true WHERE {same_pair} AND used = false")
        await tx.query(f"""
            INSERT INTO admin_sms_codes (phone_key, address_key, ticket_key, code_key, created_at, expires_at)
            VALUES (
                {phone_key},
                {address_key},
                {fit_to_sql(_key('ticket', ticket))},
                {fit_to_sql(_key('code', f'{phone}:{code}') if code else None)},
                {fit_to_sql(now)},
                {fit_to_sql(add_minutes(now, limits['sms_code_ttl_minutes']))}
            )
        """)
    return ticket, ((admins[0], code) if admins else None)


async def verify_sms_code(phone: str, ticket: str, code: str) -> dict:
    """Проверить код из SMS по талону запроса. Вернёт админа. Неверный, чужой, просроченный — 400."""
    max_attempts = config['admin']['sms_code_attempts']
    rows = await query_db(f"""
        SELECT id, expires_at FROM admin_sms_codes
        WHERE phone_key = {fit_to_sql(_key('sms', phone))}
          AND ticket_key = {fit_to_sql(_key('ticket', ticket))}
          AND used = false
        ORDER BY id DESC
        LIMIT 1
    """)
    if not rows:
        raise WarnException(400, 'Код не запрошен или уже использован. Получите код ещё раз.')
    row_id = fit_to_sql(rows[0]['id'])

    if rows[0]['expires_at'] < get_timestamp_now():
        await query_db(f"UPDATE admin_sms_codes SET used = true WHERE id = {row_id}")
        raise WarnException(400, 'Срок действия кода истёк. Запросите новый.')

    # Сначала списываем попытку, потом сравниваем: условие attempts < лимита
    # стоит в самом UPDATE, и параллельные запросы не получат лишних сравнений.
    slot = await query_db(f"""
        UPDATE admin_sms_codes
           SET attempts = attempts + 1
         WHERE id = {row_id} AND used = false AND attempts < {fit_to_sql(max_attempts)}
        RETURNING attempts, code_key
    """)
    if not slot:
        raise WarnException(400, 'Слишком много неверных попыток. Запросите новый код.')

    # code_key пуст, когда номер не админ: код не выдавался, и не подойдёт никакой.
    expected = slot[0]['code_key']
    if not expected or not hmac.compare_digest(expected, _key('code', f'{phone}:{code}')):
        if slot[0]['attempts'] >= max_attempts:
            await query_db(f"UPDATE admin_sms_codes SET used = true WHERE id = {row_id}")
            raise WarnException(400, 'Слишком много неверных попыток. Запросите новый код.')
        raise WarnException(400, 'Неверный код')

    # Одним кодом — одно подтверждение, даже если запросы пришли одновременно.
    consumed = await query_db(f"""
        UPDATE admin_sms_codes SET used = true WHERE id = {row_id} AND used = false RETURNING id
    """)
    if not consumed:
        raise WarnException(400, 'Код не запрошен или уже использован. Получите код ещё раз.')

    # Права могли снять, а человека заблокировать, пока шла SMS.
    users = await query_db(f"""
        SELECT id, phone, full_name, is_admin, is_service, is_blocked
        FROM users WHERE phone = {fit_to_sql(phone)}
    """)
    if not users or not users[0]['is_admin'] or users[0]['is_service']:
        raise WarnException(403, ADMINS_ONLY)
    if users[0]['is_blocked']:
        raise WarnException(403, BLOCKED_MESSAGE)
    return users[0]


# -------------------------------------------------------------------------
# Пароль
# -------------------------------------------------------------------------

async def credentials_of(user_id: int) -> Optional[dict]:
    rows = await query_db(f"""
        SELECT password_hash, session_version, password_set_at, last_login_at
        FROM admin_credentials
        WHERE user_id = {fit_to_sql(user_id)}
    """)
    return rows[0] if rows else None


async def set_password(user: dict, password: str, sms_confirmed_at: int) -> int:
    """
    Задать или сменить пароль админа. Вернёт новый session_version.

    session_version берётся из счётчика в базе и не повторяется никогда. С
    единицы начинать нельзя: строка стирается при снятии прав, и после
    повторного назначения ожил бы вход, выданный до снятия.

    sms_confirmed_at — когда человек подтвердил номер (секунды Unix). Одно
    подтверждение — один пароль: если пароль уже меняли после этого
    подтверждения, оно больше не годится.

    Пароль пишется, только если человек всё ещё админ, — проверка стоит в
    самом запросе и занимает его строку в users. Снятие прав занимает ту же
    строку, поэтому не может проскочить между проверкой и записью и оставить
    пароль у того, кто уже не админ.
    """
    try:
        async with passwords.place_in_line():
            digest = await passwords.hash_password(password)
    except passwords.TooBusy:
        raise WarnException(429, BUSY_MESSAGE)
    user_id = fit_to_sql(user['id'])
    async with transaction() as tx:
        rows = await tx.query(f"""
            INSERT INTO admin_credentials
                (user_id, password_hash, session_version, password_set_at, password_set_epoch)
            SELECT u.id, {fit_to_sql(digest)}, nextval('admin_session_seq'),
                   {fit_to_sql(get_timestamp_now())}, {fit_to_sql(int(time.time()))}
            FROM users u
            WHERE u.id = {user_id} AND {_ACTIVE_ADMIN}
            FOR UPDATE OF u
            ON CONFLICT (user_id) DO UPDATE
               SET password_hash = EXCLUDED.password_hash,
                   session_version = EXCLUDED.session_version,
                   password_set_at = EXCLUDED.password_set_at,
                   password_set_epoch = EXCLUDED.password_set_epoch
             WHERE admin_credentials.password_set_epoch <= {fit_to_sql(int(sms_confirmed_at))}
            RETURNING session_version
        """)
        if not rows:
            still_admin = await tx.query(f"SELECT 1 AS ok FROM users u WHERE u.id = {user_id} AND {_ACTIVE_ADMIN}")
            if not still_admin:
                raise WarnException(403, ADMINS_ONLY)
            raise WarnException(401, 'Это подтверждение по SMS уже использовано. Получите код ещё раз.')
        await _forget_login_history(tx, user['phone'])
    return rows[0]['session_version']


async def note_login(user_id: int) -> None:
    await query_db(f"""
        UPDATE admin_credentials SET last_login_at = {fit_to_sql(get_timestamp_now())}
         WHERE user_id = {fit_to_sql(user_id)}
    """)


# -------------------------------------------------------------------------
# Назначение и снятие
# -------------------------------------------------------------------------

async def grant_admin(phone: str, full_name: Optional[str]) -> tuple:
    """
    Назначить админом номер телефона. Вернёт (пользователь, создан ли он сейчас).

    Доступа это ещё не даёт: его включает сам человек, когда подтвердит номер
    по SMS и задаст пароль.
    """
    now = fit_to_sql(get_timestamp_now())
    async with transaction() as tx:
        found = await tx.query(f"""
            SELECT id, phone, full_name, is_admin, is_service, is_blocked
            FROM users
            WHERE phone = {fit_to_sql(phone)}
            FOR UPDATE
        """)
        if found:
            target = found[0]
            if target['is_service']:
                # Служебный аккаунт входит по постоянному коду из четырёх
                # цифр, который видят и могут сменить другие админы.
                raise WarnException(409, 'Это служебный аккаунт — права админа ему не выдаются. '
                                         'Укажите обычный номер.')
            if target['is_blocked']:
                raise WarnException(409, 'Этот пользователь заблокирован. Сначала разблокируйте его.')
            if target['is_admin']:
                raise WarnException(409, 'Этот номер уже администратор')
            # Имя, которое человек указал себе сам, не трогаем.
            target['full_name'] = target['full_name'] or full_name
            await tx.query(f"""
                UPDATE users
                   SET is_admin = true,
                       full_name = {fit_to_sql(target['full_name'])},
                       updated_at = {now}
                 WHERE id = {fit_to_sql(target['id'])}
            """)
        else:
            created = await tx.query(f"""
                INSERT INTO users (guid, phone, full_name, language, is_admin, created_at, updated_at)
                VALUES ({fit_to_sql(new_guid())}, {fit_to_sql(phone)}, {fit_to_sql(full_name)},
                        'ru', true, {now}, {now})
                ON CONFLICT (phone) DO NOTHING
                RETURNING id, phone, full_name
            """)
            if not created:
                # Между проверкой и вставкой этот номер успел войти в приложение.
                raise WarnException(409, 'Этот номер только что зарегистрировался. Повторите назначение.')
            target = created[0]
        # Пароль от прошлого назначения, если остался, не возвращается:
        # доступ каждый раз включает сам человек.
        await tx.query(f"DELETE FROM admin_credentials WHERE user_id = {fit_to_sql(target['id'])}")
        await _forget_login_history(tx, phone)
    return target, not found


async def revoke_admin(actor_id: int, target_id: int) -> dict:
    """Снять права админа и стереть пароль. Вернёт того, с кого сняли."""
    async with transaction() as tx:
        # Обе строки занимаем сразу и в одном порядке. Два админа, снимающие
        # права друг с друга одновременно, выполнятся по очереди, и второй
        # увидит, что он уже не админ, — иначе админка осталась бы без админов.
        rows = await tx.query(f"""
            SELECT id, phone, full_name, is_admin
            FROM users
            WHERE id IN ({fit_to_sql(actor_id)}, {fit_to_sql(target_id)})
            ORDER BY id
            FOR UPDATE
        """)
        by_id = {row['id']: row for row in rows}
        if target_id not in by_id:
            raise WarnException(404, 'Пользователь не найден')
        if actor_id not in by_id or not by_id[actor_id]['is_admin']:
            raise WarnException(403, ADMINS_ONLY)
        target = by_id[target_id]
        if not target['is_admin']:
            raise WarnException(409, 'Этот пользователь не администратор')
        await tx.query(f"""
            UPDATE users
               SET is_admin = false, updated_at = {fit_to_sql(get_timestamp_now())}
             WHERE id = {fit_to_sql(target_id)}
        """)
        await tx.query(f"DELETE FROM admin_credentials WHERE user_id = {fit_to_sql(target_id)}")
        await _forget_login_history(tx, target['phone'])
    return target
