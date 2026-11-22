-- ToiApp — полный DDL.
-- Применяется один раз при первом запуске (idempotent: IF NOT EXISTS).
-- Даты/таймштампы — CHAR(10)/CHAR(19) согласно гайдлайнам.

-- Очередь на применение. Файл выполняется одной транзакцией, а воркеров
-- uvicorn в проде два, и каждый при старте применяет его целиком. Без очереди
-- два одновременных прогона берут блокировки таблиц вперемешку и упираются
-- друг в друга: Postgres снимает один из них с ошибкой deadlock, и этот воркер
-- падает на старте. Блокировка держится до конца транзакции и снимается сама.
SELECT pg_advisory_xact_lock(20261006);

-- =========================================================================
-- Справочники
-- =========================================================================

CREATE TABLE IF NOT EXISTS cities (
    id           SERIAL PRIMARY KEY,
    name_ru      VARCHAR(100) NOT NULL,
    name_kz      VARCHAR(100) NOT NULL,
    is_active    BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS holidays (
    id           SERIAL PRIMARY KEY,
    date         CHAR(10) NOT NULL UNIQUE,
    name_ru      VARCHAR(200) NOT NULL,
    name_kz      VARCHAR(200) NOT NULL
);

CREATE TABLE IF NOT EXISTS event_types (
    id           SERIAL PRIMARY KEY,
    code         VARCHAR(50) UNIQUE NOT NULL,
    name_ru      VARCHAR(100) NOT NULL,
    name_kz      VARCHAR(100) NOT NULL
);

CREATE TABLE IF NOT EXISTS hall_amenities (
    id           SERIAL PRIMARY KEY,
    code         VARCHAR(50) UNIQUE NOT NULL,
    name_ru      VARCHAR(100) NOT NULL,
    name_kz      VARCHAR(100) NOT NULL,
    icon         VARCHAR(50)
);

-- =========================================================================
-- Пользователи
-- =========================================================================

CREATE TABLE IF NOT EXISTS users (
    id           SERIAL PRIMARY KEY,
    guid         CHAR(36) UNIQUE NOT NULL,
    phone        VARCHAR(20) UNIQUE NOT NULL,
    full_name    VARCHAR(200),
    language     CHAR(2) DEFAULT 'ru',
    fcm_token    VARCHAR(500),
    is_blocked   BOOLEAN DEFAULT FALSE,
    created_at   CHAR(19) NOT NULL,
    updated_at   CHAR(19) NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
    id           SERIAL PRIMARY KEY,
    phone        VARCHAR(20) NOT NULL,
    code         CHAR(4) NOT NULL,
    created_at   CHAR(19) NOT NULL,
    expires_at   CHAR(19) NOT NULL,
    used         BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone);

-- =========================================================================
-- Заведения и залы
-- =========================================================================

CREATE TABLE IF NOT EXISTS venues (
    id           SERIAL PRIMARY KEY,
    guid         CHAR(36) UNIQUE NOT NULL,
    owner_id     INT NOT NULL REFERENCES users(id),
    city_id      INT NOT NULL REFERENCES cities(id),
    name         VARCHAR(200) NOT NULL,
    address      VARCHAR(500) NOT NULL,
    latitude     DECIMAL(10, 7),
    longitude    DECIMAL(10, 7),
    description  TEXT,
    phone        VARCHAR(20),
    is_active    BOOLEAN DEFAULT TRUE,
    created_at   CHAR(19) NOT NULL,
    updated_at   CHAR(19) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venues_owner ON venues(owner_id);
CREATE INDEX IF NOT EXISTS idx_venues_city  ON venues(city_id);

CREATE TABLE IF NOT EXISTS halls (
    id                SERIAL PRIMARY KEY,
    guid              CHAR(36) UNIQUE NOT NULL,
    venue_id          INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    name              VARCHAR(200) NOT NULL,
    description       TEXT,
    area_sqm          INT,
    capacity_min      INT,
    capacity_max      INT,
    price_weekday     INT NOT NULL,
    price_weekend     INT NOT NULL,
    is_active         BOOLEAN DEFAULT TRUE,
    created_at        CHAR(19) NOT NULL,
    updated_at        CHAR(19) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_halls_venue ON halls(venue_id);

CREATE TABLE IF NOT EXISTS hall_amenity_links (
    hall_id      INT NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
    amenity_id   INT NOT NULL REFERENCES hall_amenities(id),
    PRIMARY KEY (hall_id, amenity_id)
);

CREATE TABLE IF NOT EXISTS hall_photos (
    id           SERIAL PRIMARY KEY,
    hall_id      INT NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
    file_path    VARCHAR(500) NOT NULL,
    thumb_path   VARCHAR(500) NOT NULL,
    sort_order   INT DEFAULT 0,
    created_at   CHAR(19) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hall_photos_hall ON hall_photos(hall_id);

-- =========================================================================
-- Бронирование
-- =========================================================================

CREATE TABLE IF NOT EXISTS bookings (
    id               SERIAL PRIMARY KEY,
    guid             CHAR(36) UNIQUE NOT NULL,
    hall_id          INT NOT NULL REFERENCES halls(id),
    client_id        INT NOT NULL REFERENCES users(id),
    event_date       CHAR(10) NOT NULL,
    guests_count     INT NOT NULL,
    event_type_id    INT REFERENCES event_types(id),
    comment          TEXT,
    status           VARCHAR(20) NOT NULL,    -- 'pending' | 'confirmed' | 'rejected' | 'cancelled'
    rejected_reason  TEXT,
    created_at       CHAR(19) NOT NULL,
    updated_at       CHAR(19) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_hall_date ON bookings(hall_id, event_date);
CREATE INDEX IF NOT EXISTS idx_bookings_client    ON bookings(client_id);

-- =========================================================================
-- Отзывы
-- =========================================================================

CREATE TABLE IF NOT EXISTS reviews (
    id              SERIAL PRIMARY KEY,
    guid            CHAR(36) UNIQUE NOT NULL,
    booking_id      INT NOT NULL UNIQUE REFERENCES bookings(id),
    hall_id         INT NOT NULL REFERENCES halls(id),
    client_id       INT NOT NULL REFERENCES users(id),
    rating          INT NOT NULL,
    text            TEXT,
    owner_reply     TEXT,
    owner_reply_at  CHAR(19),
    created_at      CHAR(19) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_hall ON reviews(hall_id);

-- =========================================================================
-- Избранное
-- =========================================================================

CREATE TABLE IF NOT EXISTS favorites (
    user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hall_id      INT NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
    created_at   CHAR(19) NOT NULL,
    PRIMARY KEY (user_id, hall_id)
);

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
-- Миграции (ALTER-ы). Добавляются в конец, все идемпотентные.
-- =========================================================================

-- Этап 3: цена фиксируется в момент бронирования.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_at_booking INT;

-- =========================================================================
-- Этап 11: Чаты (переписка между клиентом и владельцем по залу)
--
-- Чат привязан к ЗАЛУ, а не к заявке. Один чат между клиентом и залом.
-- booking_id опционально — прикрепляется когда клиент оформляет заявку.
-- =========================================================================

-- Сносим старые таблицы, если они были созданы до этапа 11 (схема с booking_id UNIQUE)
DO $mig$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'chats')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'chats' AND column_name = 'hall_id'
       )
    THEN
        DROP TABLE IF EXISTS chat_messages CASCADE;
        DROP TABLE IF EXISTS chats CASCADE;
    END IF;
END
$mig$;

CREATE TABLE IF NOT EXISTS chats (
    id                  SERIAL PRIMARY KEY,
    guid                CHAR(36) UNIQUE NOT NULL,
    hall_id             INT NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
    client_id           INT NOT NULL REFERENCES users(id),
    owner_id            INT NOT NULL REFERENCES users(id),
    booking_id          INT REFERENCES bookings(id) ON DELETE SET NULL,
    last_message_at     CHAR(19),
    last_message_preview TEXT,
    created_at          CHAR(19) NOT NULL,
    UNIQUE (hall_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_chats_client ON chats(client_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_owner  ON chats(owner_id,  last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_hall   ON chats(hall_id);

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
-- Этап 12: Категории и исполнители (providers)
--
-- Рестораны (venues/halls) НЕ трогаем. Новые категории (тамада, артисты,
-- декораторы, кейтеринг, фото-видео) — плоская сущность providers.
-- bookings / reviews / chats / favorites становятся полиморфными:
-- ссылаются ЛИБО на hall_id, ЛИБО на provider_id (ровно одно из двух).
-- =========================================================================

CREATE TABLE IF NOT EXISTS categories (
    id           SERIAL PRIMARY KEY,
    code         VARCHAR(50) UNIQUE NOT NULL,
    name_ru      VARCHAR(100) NOT NULL,
    name_kz      VARCHAR(100) NOT NULL,
    icon         VARCHAR(50),
    sort_order   INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS providers (
    id           SERIAL PRIMARY KEY,
    guid         CHAR(36) UNIQUE NOT NULL,
    owner_id     INT NOT NULL REFERENCES users(id),
    category_id  INT NOT NULL REFERENCES categories(id),
    city_id      INT NOT NULL REFERENCES cities(id),
    name         VARCHAR(200) NOT NULL,
    description  TEXT,
    phone        VARCHAR(20),
    latitude     DECIMAL(10, 7),
    longitude    DECIMAL(10, 7),
    price_from   INT,
    price_unit   VARCHAR(20),   -- 'event' | 'hour' | 'person' | 'day'
    is_active    BOOLEAN DEFAULT TRUE,
    created_at   CHAR(19) NOT NULL,
    updated_at   CHAR(19) NOT NULL
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

-- Атрибуты по категориям (паттерн hall_amenities / hall_amenity_links).
-- Это «своя модель у категории»: для каждой категории — свой набор атрибутов
-- (артист → певец/танцор/фокусник; кейтеринг → кухня; и т.д.). Фильтруемые в поиске.
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

-- ---- Полиморфизм: bookings ----
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS provider_id INT REFERENCES providers(id);
ALTER TABLE bookings ALTER COLUMN hall_id DROP NOT NULL;
DO $mig$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_subject_chk') THEN
        ALTER TABLE bookings ADD CONSTRAINT bookings_subject_chk
            CHECK ((hall_id IS NOT NULL) <> (provider_id IS NOT NULL));
    END IF;
END
$mig$;
CREATE INDEX IF NOT EXISTS idx_bookings_provider_date ON bookings(provider_id, event_date);

-- ---- Полиморфизм: reviews ----
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS provider_id INT REFERENCES providers(id);
ALTER TABLE reviews ALTER COLUMN hall_id DROP NOT NULL;
DO $mig$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviews_subject_chk') THEN
        ALTER TABLE reviews ADD CONSTRAINT reviews_subject_chk
            CHECK ((hall_id IS NOT NULL) <> (provider_id IS NOT NULL));
    END IF;
END
$mig$;
CREATE INDEX IF NOT EXISTS idx_reviews_provider ON reviews(provider_id);

-- ---- Полиморфизм: chats ----
ALTER TABLE chats ADD COLUMN IF NOT EXISTS provider_id INT REFERENCES providers(id);
ALTER TABLE chats ALTER COLUMN hall_id DROP NOT NULL;
ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_hall_id_client_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_chats_hall_client
    ON chats(hall_id, client_id) WHERE hall_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_chats_provider_client
    ON chats(provider_id, client_id) WHERE provider_id IS NOT NULL;
DO $mig$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chats_subject_chk') THEN
        ALTER TABLE chats ADD CONSTRAINT chats_subject_chk
            CHECK ((hall_id IS NOT NULL) <> (provider_id IS NOT NULL));
    END IF;
END
$mig$;
CREATE INDEX IF NOT EXISTS idx_chats_provider ON chats(provider_id);

-- ---- Полиморфизм: favorites ----
-- Старый PK (user_id, hall_id) больше не годится — заменяем на два
-- обычных UNIQUE-индекса (NULL'ы трактуются как различные, поэтому
-- избранные-исполнители с hall_id=NULL не конфликтуют между собой).
ALTER TABLE favorites ADD COLUMN IF NOT EXISTS provider_id INT REFERENCES providers(id);
-- PK (user_id, hall_id) надо снять ДО DROP NOT NULL: колонку из первичного
-- ключа Postgres не даёт сделать nullable (ошибка 42P16).
ALTER TABLE favorites DROP CONSTRAINT IF EXISTS favorites_pkey;
ALTER TABLE favorites ALTER COLUMN hall_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_favorites_user_hall
    ON favorites(user_id, hall_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_favorites_user_provider
    ON favorites(user_id, provider_id);
DO $mig$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'favorites_subject_chk') THEN
        ALTER TABLE favorites ADD CONSTRAINT favorites_subject_chk
            CHECK ((hall_id IS NOT NULL) <> (provider_id IS NOT NULL));
    END IF;
END
$mig$;


-- =========================================================================
-- Админка и служебные аккаунты
--
-- is_admin     — назначен админом веб-админки /admin: в самой админке
--                другим админом или скриптом scripts/make_admin.py с сервера.
--                Войти он сможет, когда сам задаст пароль (admin_credentials).
-- is_service   — служебный аккаунт (ревьюеры сторов, тестовые входы).
--                Создаётся из админки, входит по фиксированному коду
--                service_code без SMS.
-- attempts     — неверные попытки ввода кода. После лимита код гасится,
--                иначе 4 цифры перебираются за время жизни кода.
-- =========================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_service BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS service_code CHAR(4);
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;


-- =========================================================================
-- Модерация из админки
--
-- hidden_at / hidden_reason — объявление скрыл модератор. При скрытии
--     is_active ставится в false: поиск, карточка, заявки и чаты прячут
--     объявление по уже существующему признаку. Избранное на is_active не
--     смотрит, поэтому проверяет hidden_at само. Прежнее значение is_active
--     запоминается в was_active и возвращается, когда модератор объявление
--     вернёт. Пока hidden_at задан, владелец включить is_active не может.
-- hidden_by_block — объявление скрыто не само по себе, а вместе с
--     блокировкой владельца; при разблокировке такие возвращаются сами.
-- users.blocked_at / blocked_reason — когда и за что заблокирован человек
--     (сам запрет входа — старый is_blocked).
-- bookings.review_removed_at — отзыв по этой заявке удалил модератор;
--     оставить новый автор уже не может.
-- admin_actions — журнал: кто из админов что сделал. Без внешних ключей:
--     сама запись переживает удаление и админа, и того, над кем действие.
--     subject_user_ids — чьи данные попали в target_label и details; когда
--     такой человек удаляет аккаунт, запись обезличивается
--     (services/account.py).
--
-- Колонки добавляются внутри DO с проверкой, а не голым ALTER … IF NOT EXISTS:
-- ALTER TABLE берёт на таблицу самую строгую блокировку, даже когда колонка
-- уже есть. Файл применяется при каждом старте — в том числе вторым воркером,
-- когда первый уже отвечает на запросы, — и такая блокировка на venues, halls
-- и providers встала бы поперёк живого поиска. С проверкой сюда заходит только
-- самый первый запуск.
-- =========================================================================
DO $mig$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'providers' AND column_name = 'hidden_by_block'
    ) THEN
        ALTER TABLE users     ADD COLUMN IF NOT EXISTS blocked_at CHAR(19);
        ALTER TABLE users     ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

        ALTER TABLE venues    ADD COLUMN IF NOT EXISTS hidden_at CHAR(19);
        ALTER TABLE venues    ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
        ALTER TABLE venues    ADD COLUMN IF NOT EXISTS was_active BOOLEAN;
        ALTER TABLE venues    ADD COLUMN IF NOT EXISTS hidden_by_block BOOLEAN DEFAULT FALSE;

        ALTER TABLE halls     ADD COLUMN IF NOT EXISTS hidden_at CHAR(19);
        ALTER TABLE halls     ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
        ALTER TABLE halls     ADD COLUMN IF NOT EXISTS was_active BOOLEAN;
        ALTER TABLE halls     ADD COLUMN IF NOT EXISTS hidden_by_block BOOLEAN DEFAULT FALSE;

        ALTER TABLE providers ADD COLUMN IF NOT EXISTS hidden_at CHAR(19);
        ALTER TABLE providers ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
        ALTER TABLE providers ADD COLUMN IF NOT EXISTS was_active BOOLEAN;
        ALTER TABLE providers ADD COLUMN IF NOT EXISTS hidden_by_block BOOLEAN DEFAULT FALSE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'bookings' AND column_name = 'review_removed_at'
    ) THEN
        ALTER TABLE bookings ADD COLUMN review_removed_at CHAR(19);
    END IF;
END
$mig$;

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

-- Журнал, созданный первой версией админки, ещё без subject_user_ids. У его
-- записей уже не узнать, чьи в них данные, — а значит, и не стереть их вместе
-- с аккаунтом. Поэтому такие записи обезличиваются сразу: что и когда сделано
-- и почему — остаётся, названия, номера и тексты отзывов — нет.
DO $mig$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'admin_actions' AND column_name = 'subject_user_ids'
    ) THEN
        ALTER TABLE admin_actions ADD COLUMN subject_user_ids INT[];
        UPDATE admin_actions
           SET target_label = NULL,
               details = CASE WHEN action = 'review_delete' THEN NULL ELSE details END;
    END IF;
END
$mig$;

-- Блокировка теперь всегда прячет объявления человека (services/moderation.py).
-- Раньше «Отключить» у служебного аккаунта закрывало только вход — приводим
-- такие аккаунты к общему правилу. После первого запуска подходящих строк не
-- остаётся: дальше объявления скрываются в момент блокировки.
-- Время — казахстанское (UTC+5), как пишет его сам бэк.
UPDATE venues
   SET was_active = is_active, is_active = FALSE, hidden_by_block = TRUE,
       hidden_reason = 'Аккаунт владельца заблокирован',
       hidden_at = to_char(now() AT TIME ZONE 'UTC' + interval '5 hours', 'YYYY-MM-DD"T"HH24:MI:SS')
 WHERE hidden_at IS NULL
   AND owner_id IN (SELECT id FROM users WHERE is_blocked);
UPDATE halls
   SET was_active = is_active, is_active = FALSE, hidden_by_block = TRUE,
       hidden_reason = 'Аккаунт владельца заблокирован',
       hidden_at = to_char(now() AT TIME ZONE 'UTC' + interval '5 hours', 'YYYY-MM-DD"T"HH24:MI:SS')
 WHERE hidden_at IS NULL
   AND venue_id IN (SELECT v.id FROM venues v JOIN users u ON u.id = v.owner_id WHERE u.is_blocked);
UPDATE providers
   SET was_active = is_active, is_active = FALSE, hidden_by_block = TRUE,
       hidden_reason = 'Аккаунт владельца заблокирован',
       hidden_at = to_char(now() AT TIME ZONE 'UTC' + interval '5 hours', 'YYYY-MM-DD"T"HH24:MI:SS')
 WHERE hidden_at IS NULL
   AND owner_id IN (SELECT id FROM users WHERE is_blocked);


-- =========================================================================
-- Жалобы пользователей
--
-- На что жалоба — target_type + target_id: зал, исполнитель, отзыв или
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
--     объявление), а чат зала удаляется вместе с залом — блокировка должна
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
