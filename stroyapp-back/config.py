"""
Несекретные параметры проекта.
Секреты — в .env (DB_PASSWORD, JWT_SECRET, MOBIZON_API_KEY, ...).
"""
import os
from dotenv import load_dotenv


# Загружаем .env из корня проекта (stroyapp-back/.env).
# Если файл отсутствует — не падаем: переменные могут быть заданы средой
# (например, на проде через systemd/docker).
load_dotenv()


def _require(value, name):
    """Если обязательный параметр пуст — сервер падает с понятным сообщением."""
    if not value:
        raise RuntimeError(f'Config error: missing required parameter [{name}]')
    return value


env = os.environ.get('STROYAPP_ENV', 'dev')   # 'dev' | 'stage' | 'prod'
is_dev = env == 'dev'
is_stage = env == 'stage'
is_prod = env == 'prod'


config = {
    'env': env,
    # Режим задан переменной явно, а не взят по умолчанию. Постоянным кодам
    # одного «по умолчанию» мало: сервер, на котором забыли STROYAPP_ENV,
    # тоже считает себя dev.
    'env_explicit': 'STROYAPP_ENV' in os.environ,
    'port': 1500 if is_prod else 1600 if is_stage else 4000,

    # Куда писать человеку, которого заблокировали или чьё объявление скрыли.
    'support_email': 'supportstroyapp@gmail.com',

    # Адрес сервера снаружи — для ссылок в уведомлениях админам. Отсюда, а не
    # из заголовка Host запроса: его присылает клиент, и с чужим адресом
    # уведомление стало бы приманкой на поддельную страницу входа.
    # Пусто — уведомления уходят без ссылки.
    'public_url': 'https://api.stroyapp.kz' if is_prod else '' if is_stage else 'http://localhost:4000',

    'db': {
        'host': os.environ.get('DB_HOST', 'localhost'),
        'port': int(os.environ.get('DB_PORT', '5432')),
        'name': os.environ.get('DB_NAME', 'stroyapp'),
        'user': os.environ.get('DB_USER', 'stroyapp_user'),
        'password': _require(os.environ.get('DB_PASSWORD'), 'DB_PASSWORD'),
        'min_size': 2,
        'max_size': 10,
    },

    'jwt': {
        'secret': _require(os.environ.get('JWT_SECRET'), 'JWT_SECRET'),
        'algorithm': 'HS256',
        'ttl_days': 30,
    },

    'uploads': {
        'root': os.environ.get('UPLOADS_ROOT', './uploads'),
        'photo_max_long_side': 1920,
        'photo_thumb_side': 400,
        'photo_jpeg_quality': 85,
    },

    # Вход в админку по паролю (services/admin_access.py).
    'admin': {
        # Сколько живёт вход в админку. Страница хранит его до закрытия
        # вкладки; этот срок — на случай, если вкладку не закрывают неделями.
        'session_hours': 12,

        # Код из SMS, которым подтверждают номер перед тем, как задать пароль.
        # Свой, не тот, что у входа в приложение: шесть цифр и мало кодов в
        # сутки — десятки попыток в день из миллиона вариантов.
        'sms_code_ttl_minutes': 5,
        'sms_code_attempts': 5,
        # Кодов в сутки: на один номер с одного адреса, на один номер со всех
        # адресов (это и потолок расхода на SMS) и с одного адреса на все номера.
        'sms_codes_per_day': 5,
        'sms_codes_per_day_phone': 15,
        'sms_codes_per_day_ip': 10,
        # В разработке (STROYAPP_ENV=dev задан явно) SMS не уходят, код постоянный.
        'sms_mock_code': '000000',
        # Сколько минут после кода есть на то, чтобы задать пароль.
        'setup_minutes': 15,

        # Лимит на подбор пароля — неудачных попыток за login_window_minutes:
        #   login_max_failures       — на один номер с одного адреса
        #   login_max_failures_phone — на один номер со всех адресов
        #   login_max_failures_ip    — с одного адреса по всем номерам
        'login_max_failures': 5,
        'login_max_failures_phone': 30,
        'login_max_failures_ip': 20,
        'login_window_minutes': 15,
    },

    'telegram': {
        # Если токен не задан — уведомления просто не отправляются (без падения).
        'bot_token': os.environ.get('TELEGRAM_BOT_TOKEN', ''),
        'chat_id': os.environ.get('TELEGRAM_CHAT_ID', ''),
    },

    'twogis': {
        # Ключ нужен мобильному приложению, бэку он не обязателен; лежит в .env для удобства.
        'api_key': os.environ.get('TWOGIS_API_KEY', ''),
    },

    'cors': {
        # На dev открыто всё; на prod сузим по списку доменов при деплое.
        'allow_origins': ['*'] if is_dev else [],
    },

    'otp': {
        # На MVP — мок. Код всегда равен mock_code, TTL указан для будущей замены на реальный шлюз.
        'mock_code': '0000',
        'ttl_minutes': 5,

        # Защита от перебора. Код — 4 цифры, 10 000 вариантов: без лимитов
        # он перебирается за время жизни кода.
        #   max_attempts      — проверок на один код, потом код гасится
        #   max_requests_hour — запросов кода на номер в час
        # Итого не больше 25 попыток угадать в час на номер.
        'max_attempts': 5,
        'max_requests_hour': 5,

        # Демо-номер для ревью Google Play и App Store.
        # У ревьюера нет казахстанского номера, а без входа он отклонит
        # релиз. Поэтому для одного заранее заданного номера код фиксирован
        # и SMS не отправляется. Всё остальное (JWT, права, блокировки)
        # работает как у обычного пользователя.
        #
        # Обе переменные должны быть заданы, иначе функция выключена целиком.
        # На проде задавать только на время ревью и убирать после релиза.
        'review_phone': os.environ.get('REVIEW_PHONE', '').strip(),
        'review_code': os.environ.get('REVIEW_CODE', '').strip(),
    },
}
