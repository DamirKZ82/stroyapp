-- StroyApp — полный DDL.
-- Применяется при каждом старте (idempotent: IF NOT EXISTS).
-- Даты/таймштампы — CHAR(10)/CHAR(19) согласно гайдлайнам.
--
-- Схема выросла из ToiApp. Главная сущность — объявление (таблица providers):
-- магазин стройматериалов или бригада / мастер. Какое из двух — решает
-- категория (categories.kind: 'material' | 'service'). У объявления есть
-- прайс (provider_items): позиции с единицей измерения и ценой, по ним
-- работает поиск конкретных товаров и работ.

-- Очередь на применение. Файл выполняется одной транзакцией, а воркеров
-- uvicorn в проде два, и каждый при старте применяет его целиком. Без очереди
-- два одновременных прогона берут блокировки таблиц вперемешку и упираются
-- друг в друга: Postgres снимает один из них с ошибкой deadlock, и этот воркер
-- падает на старте. Блокировка держится до конца транзакции и снимается сама.
SELECT pg_advisory_xact_lock(20261122);

-- =========================================================================
-- Справочники
-- =========================================================================

CREATE TABLE IF NOT EXISTS cities (
    id           SERIAL PRIMARY KEY,
    name_ru      VARCHAR(100) NOT NULL,
    name_kz      VARCHAR(100) NOT NULL,
    is_active    BOOLEAN DEFAULT TRUE
);

-- Категории двух видов: kind = 'material' (магазины стройматериалов)
-- и 'service' (бригады, мастера, доставка и спецтехника).
CREATE TABLE IF NOT EXISTS categories (
    id           SERIAL PRIMARY KEY,
    code         VARCHAR(50) UNIQUE NOT NULL,
    kind         VARCHAR(20) NOT NULL,
    name_ru      VARCHAR(100) NOT NULL,
    name_kz      VARCHAR(100) NOT NULL,
    icon         VARCHAR(50),
    sort_order   INT DEFAULT 0,
    CONSTRAINT categories_kind_chk CHECK (kind IN ('material', 'service'))
);

-- =========================================================================
-- Пользователи
-- =========================================================================

CREATE TABLE IF NOT EXISTS users (
    id             SERIAL PRIMARY KEY,
    guid           CHAR(36) UNIQUE NOT NULL,
    phone          VARCHAR(20) UNIQUE NOT NULL,
    full_name      VARCHAR(200),
    language       CHAR(2) DEFAULT 'ru',
    fcm_token      VARCHAR(500),
    is_blocked     BOOLEAN DEFAULT FALSE,
    blocked_at     CHAR(19),
    blocked_reason TEXT,
    -- is_admin   — назначен админом веб-админки /admin: в самой админке
    --              другим админом или скриптом scripts/make_admin.py с сервера.
    --              Войти он сможет, когда сам задаст пароль (admin_credentials).
    -- is_service — служебный аккаунт (ревьюеры сторов, тестовые входы).
    --              Создаётся из админки, входит по фиксированному коду
    --              service_code без SMS.
    is_admin       BOOLEAN DEFAULT FALSE,
    is_service     BOOLEAN DEFAULT FALSE,
    service_code   CHAR(4),
    created_at     CHAR(19) NOT NULL,
    updated_at     CHAR(19) NOT NULL
);

-- attempts — неверные попытки ввода кода. После лимита код гасится,
-- иначе 4 цифры перебираются за время жизни кода.
CREATE TABLE IF NOT EXISTS otp_codes (
    id           SERIAL PRIMARY KEY,
    phone        VARCHAR(20) NOT NULL,
    code         CHAR(4) NOT NULL,
    created_at   CHAR(19) NOT NULL,
    expires_at   CHAR(19) NOT NULL,
    used         BOOLEAN DEFAULT FALSE,
    attempts     INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone);

-- =========================================================================
-- Объявления: магазины и бригады
--
-- hidden_at / hidden_reason — объявление скрыл модератор. При скрытии
--     is_active ставится в false: поиск, карточка, заявки и чаты прячут
--     объявление по уже существующему признаку. Избранное на is_active не
--     смотрит, поэтому проверяет hidden_at само. Прежнее значение is_active
--     запоминается в was_active и возвращается, когда модератор объявление
--     вернёт. Пока hidden_at задан, владелец включить is_active не может.
-- hidden_by_block — объявление скрыто не само по себе, а вместе с
--     блокировкой владельца; при разблокировке такие возвращаются сами.
-- price_from / price_unit — «цена от» для карточки в списке. Если прайс
--     заполнен, приложение показывает минимальную цену из него.
-- =========================================================================

CREATE TABLE IF NOT EXISTS providers (
    id              SERIAL PRIMARY KEY,
    guid            CHAR(36) UNIQUE NOT NULL,
    owner_id        INT NOT NULL REFERENCES users(id),
    category_id     INT NOT NULL REFERENCES categories(id),
    city_id         INT NOT NULL REFERENCES cities(id),
    name            VARCHAR(200) NOT NULL,
    description     TEXT,
    phone           VARCHAR(20),
    address         VARCHAR(500),
    latitude        DECIMAL(10, 7),
    longitude       DECIMAL(10, 7),
    price_from      INT,
    price_unit      VARCHAR(20),
    is_active       BOOLEAN DEFAULT TRUE,
    hidden_at       CHAR(19),
    hidden_reason   TEXT,
    was_active      BOOLEAN,
    hidden_by_block BOOLEAN DEFAULT FALSE,
    created_at      CHAR(19) NOT NULL,
    updated_at      CHAR(19) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_providers_owner    ON providers(owner_id);
CREATE INDEX IF NOT EXISTS idx_providers_category ON providers(category_id);
CREATE INDEX IF NOT EXISTS idx_providers_city     ON providers(city_id);

CREATE TABLE IF NOT EXISTS provider_photos (
    id           SERIAL PRIMARY KEY,
    provider_id  INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    file_path    VARCHAR(500) NOT NULL,
    thumb_path   VARCHAR(500) NOT NULL,
    sort_order   INT DEFAULT 0,
    created_at   CHAR(19) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_photos_provider ON provider_photos(provider_id);

-- Признаки объявления по категориям (доставка, рассрочка, договор, гарантия…).
-- Фильтруются в поиске. category_id — категория, для которой признак
-- показывается.
CREATE TABLE IF NOT EXISTS provider_attr_types (
    id           SERIAL PRIMARY KEY,
    category_id  INT NOT NULL REFERENCES categories(id),
    code         VARCHAR(50) NOT NULL,
    name_ru      VARCHAR(100) NOT NULL,
    name_kz      VARCHAR(100) NOT NULL,
    icon         VARCHAR(50),
    sort_order   INT DEFAULT 0,
    UNIQUE (category_id, code)
);

CREATE TABLE IF NOT EXISTS provider_attr_links (
    provider_id  INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    attr_id      INT NOT NULL REFERENCES provider_attr_types(id),
    PRIMARY KEY (provider_id, attr_id)
);

-- Прайс объявления: товары магазина или работы бригады.
-- unit — единица измерения (см. PRICE_UNITS в routers/r23_providers.py).
-- price — цена за единицу в тенге; NULL — «договорная».
CREATE TABLE IF NOT EXISTS provider_items (
    id           SERIAL PRIMARY KEY,
    guid         CHAR(36) UNIQUE NOT NULL,
    provider_id  INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name         VARCHAR(200) NOT NULL,
    unit         VARCHAR(20) NOT NULL,
    price        INT,
    sort_order   INT DEFAULT 0,
    created_at   CHAR(19) NOT NULL,
    updated_at   CHAR(19) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_items_provider ON provider_items(provider_id, sort_order);
-- Поиск по названию позиции: ILIKE '%...%' по lower(name).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_provider_items_name_trgm
    ON provider_items USING gin (lower(name) gin_trgm_ops);

-- =========================================================================
-- Заявки
--
-- Клиент пишет магазину или бригаде: что нужно (comment), куда (address)
-- и к какому сроку (event_date — желаемая дата доставки или начала работ).
-- Календаря занятости нет: одна дата не исключает другие заявки.
-- review_removed_at — отзыв по этой заявке удалил модератор; оставить новый
--     автор уже не может.
-- =========================================================================

CREATE TABLE IF NOT EXISTS bookings (
    id                 SERIAL PRIMARY KEY,
    guid               CHAR(36) UNIQUE NOT NULL,
    provider_id        INT NOT NULL REFERENCES providers(id),
    client_id          INT NOT NULL REFERENCES users(id),
    event_date         CHAR(10) NOT NULL,
    address            VARCHAR(500),
    comment            TEXT,
    status             VARCHAR(20) NOT NULL,    -- 'pending' | 'confirmed' | 'rejected' | 'cancelled'
    rejected_reason    TEXT,
    review_removed_at  CHAR(19),
    created_at         CHAR(19) NOT NULL,
    updated_at         CHAR(19) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_provider_date ON bookings(provider_id, event_date);
CREATE INDEX IF NOT EXISTS idx_bookings_client        ON bookings(client_id);

-- =========================================================================
-- Отзывы
-- =========================================================================

CREATE TABLE IF NOT EXISTS reviews (
    id              SERIAL PRIMARY KEY,
    guid            CHAR(36) UNIQUE NOT NULL,
    booking_id      INT NOT NULL UNIQUE REFERENCES bookings(id),
    provider_id     INT NOT NULL REFERENCES providers(id),
    client_id       INT NOT NULL REFERENCES users(id),
    rating          INT NOT NULL,
    text            TEXT,
    owner_reply     TEXT,
    owner_reply_at  CHAR(19),
    created_at      CHAR(19) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_provider ON reviews(provider_id);

-- =========================================================================
-- Избранное
-- =========================================================================

CREATE TABLE IF NOT EXISTS favorites (
    user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id  INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    created_at   CHAR(19) NOT NULL,
    PRIMARY KEY (user_id, provider_id)
);

-- =========================================================================
-- Чаты: один чат между клиентом и объявлением.
-- booking_id — последняя заявка клиента по этому объявлению.
-- =========================================================================

CREATE TABLE IF NOT EXISTS chats (
    id                   SERIAL PRIMARY KEY,
    guid                 CHAR(36) UNIQUE NOT NULL,
    provider_id          INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    client_id            INT NOT NULL REFERENCES users(id),
    owner_id             INT NOT NULL REFERENCES users(id),
    booking_id           INT REFERENCES bookings(id) ON DELETE SET NULL,
    last_message_at      CHAR(19),
    last_message_preview TEXT,
    created_at           CHAR(19) NOT NULL,
    UNIQUE (provider_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_chats_client   ON chats(client_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_owner    ON chats(owner_id,  last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_provider ON chats(provider_id);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          SERIAL PRIMARY KEY,
    guid        CHAR(36) UNIQUE NOT NULL,
    chat_id     INT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id   INT NOT NULL REFERENCES users(id),
    text        TEXT NOT NULL,
    created_at  CHAR(19) NOT NULL,
    read_at     CHAR(19)    -- заполняется когда получатель прочитал
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_unread ON chat_messages(chat_id, sender_id) WHERE read_at IS NULL;

-- =========================================================================
-- Служебные (ошибки и варны)
-- =========================================================================

CREATE TABLE IF NOT EXISTS errors_back (
    id           SERIAL PRIMARY KEY,
    message      TEXT,
    traceback    TEXT,
    sql          TEXT,
    method       VARCHAR(10),
    path         VARCHAR(500),
    user_id      INT,
    created_at   CHAR(19) NOT NULL
);

CREATE TABLE IF NOT EXISTS errors_front (
    id           SERIAL PRIMARY KEY,
    message      TEXT,
    stack        TEXT,
    screen       VARCHAR(200),
    user_id      INT,
    created_at   CHAR(19) NOT NULL
);

CREATE TABLE IF NOT EXISTS warns (
    id           SERIAL PRIMARY KEY,
    code         INT,
    message      TEXT,
    method       VARCHAR(10),
    path         VARCHAR(500),
    user_id      INT,
    created_at   CHAR(19) NOT NULL
);

-- =========================================================================
-- Админка
--
-- admin_actions — журнал: кто из админов что сделал. Без внешних ключей:
--     сама запись переживает удаление и админа, и того, над кем действие.
--     subject_user_ids — чьи данные попали в target_label и details; когда
--     такой человек удаляет аккаунт, запись обезличивается
--     (services/account.py).
-- =========================================================================

CREATE TABLE IF NOT EXISTS admin_actions (
    id                SERIAL PRIMARY KEY,
    admin_id          INT,
    admin_phone       VARCHAR(20),
    action            VARCHAR(50) NOT NULL,
    target_type       VARCHAR(30),
    target_id         INT,
    target_label      TEXT,       -- как объект назывался в момент действия
    details           TEXT,       -- причина или что именно удалено
    subject_user_ids  INT[],      -- чьи данные в target_label и details
    created_at        CHAR(19) NOT NULL
);




-- =========================================================================
-- Жалобы пользователей
--
-- На что жалоба — target_type + target_id: объявление, отзыв или
--     переписка. Без внешних ключей и без четырёх отдельных колонок: жалоба
--     должна пережить удаление объявления или отзыва (модератору ещё
--     разбирать её), а связи тут только читаются.
-- target_user_id — на кого жалоба по сути: владелец объявления, автор отзыва,
--     собеседник. По нему и по reporter_id жалобы удаляются вместе с
--     аккаунтом (services/account.py).
-- target_owner_id — чьё объявление названо в снимке. У жалобы на отзыв это
--     не тот, на кого жалоба: когда владелец удаляет аккаунт, жалоба на
--     чужой отзыв остаётся, а название его объявления из неё стирается.
-- target_label / target_text — снимок на момент жалобы: название объявления,
--     текст отзыва.
-- status — 'new' | 'resolved' (меры приняты) | 'rejected' (отклонена).
-- Уникальный индекс: одна неразобранная жалоба от человека на одно и то же.
-- =========================================================================
CREATE TABLE IF NOT EXISTS complaints (
    id              SERIAL PRIMARY KEY,
    reporter_id     INT NOT NULL,
    target_type     VARCHAR(20) NOT NULL,
    target_id       INT NOT NULL,
    target_user_id  INT,
    target_owner_id INT,
    target_label    TEXT,
    target_text     TEXT,
    reason          VARCHAR(30) NOT NULL,
    comment         TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'new',
    resolution      TEXT,           -- пометка модератора при закрытии
    resolved_by     INT,
    resolved_at     CHAR(19),
    created_at      CHAR(19) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_complaints_open
    ON complaints(reporter_id, target_type, target_id) WHERE status = 'new';
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status, id);
CREATE INDEX IF NOT EXISTS idx_complaints_target ON complaints(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_complaints_target_user ON complaints(target_user_id);
CREATE INDEX IF NOT EXISTS idx_complaints_target_owner ON complaints(target_owner_id);
-- Суточный лимит считается при каждой жалобе: частичный индекс выше для этого не годится.
CREATE INDEX IF NOT EXISTS idx_complaints_reporter ON complaints(reporter_id, created_at);


-- =========================================================================
-- Вход админов по паролю
--
-- admin_credentials — пароль админки (хэш). Отдельной таблицей, а не колонкой
--     в users: строку пользователя читают десятки запросов, и хэш не должен
--     попасть ни в один. Строка появляется, когда админ сам задал пароль
--     после подтверждения номера по SMS; до этого он назначен, но войти не
--     может. Без внешнего ключа, как и остальное вокруг админки: строку
--     убирают снятие прав и удаление аккаунта (services/account.py).
-- session_version — номер «поколения» входов. Вшит в токен админки и
--     меняется при каждой смене пароля: выданные раньше входы перестают
--     работать. Берётся из счётчика admin_session_seq и не повторяется: строка
--     стирается при снятии прав, и начни она снова с единицы, после повторного
--     назначения ожил бы вход, выданный до снятия.
-- password_set_epoch — когда задан пароль, в секундах Unix: сравнивается со
--     временем подтверждения по SMS, чтобы одним подтверждением пароль
--     задавали один раз.
-- admin_sms_codes — коды из SMS, которыми админ подтверждает номер перед тем,
--     как задать пароль. Свои, шестизначные, отдельно от otp_codes: вход в
--     приложение и пароль админки не должны открываться одним кодом. Строка
--     пишется на каждый запрос, даже когда номер не админ и кода нет
--     (code_key пуст): лимит и ответ тогда одинаковы для всех номеров.
--     ticket_key — талон запроса: проверить код может только тот, кто его
--     запросил. address_key — откуда запрос: лимит считается на пару «номер +
--     адрес», и чужие запросы не тратят счёт самого админа.
-- admin_login_attempts — попытки ввода пароля за последние минуты, по ним
--     считается лимит. subject_key — чей пароль проверяют (номер при входе,
--     админ при подтверждении действия), address_key — откуда; он пуст,
--     когда адрес клиента надёжно не узнать.
-- admin_known_addresses — с каких адресов пароль уже вводили верно. Потолок
--     попыток «на номер со всех адресов» таких адресов не касается: подбор с
--     чужих адресов не закрывает вход самому хозяину пароля. Стирается при
--     смене пароля и снятии прав, сама — через три месяца.
-- В этих таблицах вместо номеров, адресов, кодов и талонов — их отпечатки:
--     кто, откуда и с каким кодом входил, по ним не прочитать. Устаревшие
--     строки убирает следующий же запрос к той же таблице.
-- =========================================================================
CREATE SEQUENCE IF NOT EXISTS admin_session_seq;

CREATE TABLE IF NOT EXISTS admin_credentials (
    user_id             INT PRIMARY KEY,
    password_hash       TEXT NOT NULL,
    session_version     BIGINT NOT NULL,
    password_set_at     CHAR(19) NOT NULL,
    password_set_epoch  BIGINT NOT NULL,
    last_login_at       CHAR(19)
);

CREATE TABLE IF NOT EXISTS admin_sms_codes (
    id          BIGSERIAL PRIMARY KEY,
    phone_key   CHAR(40) NOT NULL,
    code_key    CHAR(40),
    attempts    INT NOT NULL DEFAULT 0,
    used        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  CHAR(19) NOT NULL,
    expires_at  CHAR(19) NOT NULL
);
-- Таблицу могла создать версия без талона и адреса. Она крошечная и нужна
-- только при входе в админку, поэтому колонки добавляются прямо так.
ALTER TABLE admin_sms_codes ADD COLUMN IF NOT EXISTS address_key CHAR(40);
ALTER TABLE admin_sms_codes ADD COLUMN IF NOT EXISTS ticket_key CHAR(40);
CREATE INDEX IF NOT EXISTS idx_admin_sms_codes_phone ON admin_sms_codes(phone_key, id);
CREATE INDEX IF NOT EXISTS idx_admin_sms_codes_address ON admin_sms_codes(address_key);
CREATE INDEX IF NOT EXISTS idx_admin_sms_codes_created ON admin_sms_codes(created_at);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
    id           BIGSERIAL PRIMARY KEY,
    subject_key  CHAR(40) NOT NULL,
    address_key  CHAR(40),
    created_at   CHAR(19) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_subject ON admin_login_attempts(subject_key);
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_address ON admin_login_attempts(address_key);
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_created ON admin_login_attempts(created_at);

CREATE TABLE IF NOT EXISTS admin_known_addresses (
    subject_key   CHAR(40) NOT NULL,
    address_key   CHAR(40) NOT NULL,
    last_seen_at  CHAR(19) NOT NULL,
    PRIMARY KEY (subject_key, address_key)
);


-- =========================================================================
-- Чёрный список собеседников (блокировка собеседника в приложении)
--
-- Это НЕ блокировка аккаунта админом (users.is_blocked,
--     services/moderation.py): там человеку закрыт вход, здесь один
--     пользователь закрыл для себя переписку с другим. Чтобы их не путать ни
--     в коде, ни в поиске по проекту, здесь везде слово peer («собеседник»).
-- Строка — «user_id заблокировал peer_id». Блокировка между двумя людьми, а
--     не внутри чата: у пары бывает несколько чатов (по одному на
--     объявление), а чат объявления удаляется вместе с объявлением — блокировка должна
--     это пережить.
-- Разблокировка удаляет строку: историю блокировок не храним.
-- guid — по нему приложение снимает блокировку из списка «Заблокированные»;
--     идентификаторы самих пользователей наружу не отдаём.
-- Без внешних ключей, как у жалоб: строки в обе стороны удаляет
--     services/account.py вместе с аккаунтом — и у служебного аккаунта, где
--     сама строка users остаётся.
-- Уникальный индекс (user_id, peer_id) — и защита от повторной блокировки
--     (ON CONFLICT), и поиск «заблокирована ли пара» в обе стороны: на нём
--     стоят проверки при отправке сообщения, новой заявке и в списке чатов.
-- idx_peer_blocks_peer — «кто заблокировал этого человека»: счётчик в
--     админке и удаление аккаунта.
-- =========================================================================
CREATE TABLE IF NOT EXISTS peer_blocks (
    id          SERIAL PRIMARY KEY,
    guid        CHAR(36) UNIQUE NOT NULL,
    user_id     INT NOT NULL,       -- кто заблокировал
    peer_id     INT NOT NULL,       -- кого
    created_at  CHAR(19) NOT NULL,
    CONSTRAINT peer_blocks_not_self_chk CHECK (user_id <> peer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_peer_blocks_pair ON peer_blocks(user_id, peer_id);
CREATE INDEX IF NOT EXISTS idx_peer_blocks_peer ON peer_blocks(peer_id);


-- =========================================================================
-- Согласие с Условиями использования (страница /terms)
--
-- Строка — «этот человек принял эту версию условий тогда-то». Версия текста
--     задаётся в services/terms.py; когда она меняется, прежние строки
--     остаются, а приложение спрашивает согласие с новой.
-- Отдельная таблица, а не колонки в users: ALTER на users брал бы строгую
--     блокировку таблицы, которую читает каждый запрос с токеном, — и здесь
--     остаётся история, какую версию и когда человек принимал.
-- Без внешнего ключа: строки удаляет services/account.py вместе с
--     аккаунтом — и у служебного, где сама строка users остаётся.
-- =========================================================================
CREATE TABLE IF NOT EXISTS terms_acceptances (
    user_id      INT NOT NULL,
    version      VARCHAR(20) NOT NULL,
    accepted_at  CHAR(19) NOT NULL,
    PRIMARY KEY (user_id, version)
);
