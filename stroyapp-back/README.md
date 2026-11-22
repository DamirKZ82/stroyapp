# StroyApp — Backend

Этап 1 из 10: скелет бэка.

Что включено: FastAPI-приложение, подключение к PostgreSQL, автосборка роутеров, обработка ошибок
(WarnException/ErrorException), логирование в `errors_back`/`errors_front`/`warns`,
Telegram-уведомления (опционально), миграции и сиды справочников, приём ошибок с фронта, health-эндпоинт.

Сверху — вход по SMS, объявления магазинов и бригад с прайсом, поиск (в том числе по позициям прайсов), заявки, чаты, отзывы, избранное, жалобы и админка.

---

## Требования

- Python 3.11+
- PostgreSQL 14+

## Установка

```bash
# 1. Создай БД и пользователя (от имени суперюзера postgres)
psql -U postgres -c "CREATE USER stroyapp_user WITH PASSWORD 'change_me';"
psql -U postgres -c "CREATE DATABASE stroyapp OWNER stroyapp_user;"

# 2. Скопируй .env
cp .env.example .env
# и отредактируй: DB_PASSWORD, JWT_SECRET (openssl rand -hex 32)

# 3. Виртуальное окружение и зависимости
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 4. Запуск
python main.py
```

При первом запуске автоматически:
- применяется `db/migrations.sql` (все таблицы);
- наполняются справочники (`cities`, `categories` с видом material/service, `provider_attr_types`).

## Проверка

```bash
curl http://localhost:4000/health
# {"status":"ok","ts":"2026-03-28T18:55:55"}
```

Swagger UI: http://localhost:4000/docs

## Структура

```
stroyapp-back/
├── main.py                      # точка входа
├── config.py                    # несекретные параметры + _require
├── temp_settings.py             # временные флаги
├── .env.example                 # шаблон секретов
├── requirements.txt
├── connections/
│   └── connect_postgres.py      # пул asyncpg, query_db
├── libs/
│   ├── date.py                  # get_timestamp_now, get_date_today
│   └── common.py                # fit_to_sql, new_guid
├── handlers/
│   ├── h01_errors.py            # исключения и глобальные хендлеры
│   ├── h02_cors.py              # CORS
│   ├── h03_auth.py              # (этап 2) JWT-декодирование
│   └── h04_routes.py            # автосборка роутеров
├── routers/
│   └── r00_errors.py            # POST /front-error, GET /health
├── services/
│   └── seed.py                  # миграции + сиды справочников
├── db/
│   └── migrations.sql           # DDL всех таблиц
└── uploads/providers/           # фото объявлений
```

## Логирование ошибок

- SQL упал → `ErrorException` с текстом SQL → глобальный хендлер → запись в `errors_back`
  (message, traceback, sql, method, path, user_id) + уведомление в Telegram (если токен задан).
- Ошибка пользователя (не найдено, плохой запрос) → `WarnException(code, message)` → запись в `warns`.
- Ошибка на мобильном клиенте → `POST /front-error` → запись в `errors_front`.

## Telegram-уведомления (опционально)

Заполни в `.env`:
```
TELEGRAM_BOT_TOKEN=12345:ABCDE...
TELEGRAM_CHAT_ID=288385608
```
Если токен пустой — уведомления просто не отправляются, без падений.
