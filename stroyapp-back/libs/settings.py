"""
Ключи и настройки интеграций, которые админ меняет в админке, а не в .env:
касса Freedom Pay, SMS (Mobizon), Telegram, 2ГИС, демо-вход для ревью,
цена Pro.

В .env остаются только то, без чего сервер не поднимется: доступ к базе,
JWT_SECRET и SETTINGS_KEY — ключ, которым шифруются секреты в базе.

Как это работает:
    - Значения лежат в app_settings. Секреты — зашифрованными (Fernet,
      ключ из SETTINGS_KEY), остальное — как есть.
    - Значение из базы кладётся прямо в config (config['freedompay']['secret']
      и т. п.), поэтому код, который читает config, ничего не знает о базе.
    - Нет значения в базе — действует переменная окружения, как раньше:
      старые выкладки с ключами в .env продолжают работать.
    - Воркеров у сервера несколько, у каждого свой config. Изменение
      применяется сразу в том воркере, что принял запрос, а остальные
      перечитывают таблицу раз в RELOAD_SECONDS.

Если SETTINGS_KEY не задан, ключ шифрования выводится из JWT_SECRET. Тогда
смена JWT_SECRET делает секреты в базе нечитаемыми: они считаются не
заданными, и админка просит ввести их заново.
"""
import asyncio
import base64
import hashlib
import os
from dataclasses import dataclass
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from config import config
from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from libs.common import fit_to_sql
from libs.date import get_timestamp_now
from libs.phone import normalize_phone


RELOAD_SECONDS = 30
VALUE_MAX = 4000


@dataclass(frozen=True)
class Setting:
    key: str            # 'freedompay.secret' — раздел и поле в config
    label: str
    group: str
    secret: bool = False
    kind: str = 'text'  # 'text' | 'int' | 'bool'
    hint: str = ''

    @property
    def env(self) -> str:
        return ENV_NAMES[self.key]


SETTINGS: list[Setting] = [
    Setting('freedompay.merchant_id', 'ID магазина (merchant_id)', 'Оплата картой: Freedom Pay',
            hint='Из личного кабинета Freedom Pay. Без него и ключа оплата в приложении «пока недоступна».'),
    Setting('freedompay.secret', 'Секретный ключ для приёма платежей', 'Оплата картой: Freedom Pay', secret=True),
    Setting('freedompay.testing_mode', 'Тестовый режим кассы', 'Оплата картой: Freedom Pay', kind='bool',
            hint='Включён — деньги не списываются. Для первой пробной оплаты.'),
    Setting('freedompay.api_url', 'Адрес API', 'Оплата картой: Freedom Pay',
            hint='Обычно https://api.freedompay.kz — менять, только если так скажет Freedom Pay.'),
    Setting('plans.pro_month_price', 'Цена Pro за месяц, ₸', 'Тариф продавца', kind='int',
            hint='За 3 и 12 месяцев — со скидкой от этой цены. Уже оплаченные сроки не меняются.'),
    Setting('sms.mobizon_api_key', 'Ключ API Mobizon', 'SMS: Mobizon', secret=True,
            hint='Без него коды входа по SMS не уходят.'),
    Setting('sms.mobizon_sender', 'Подпись отправителя', 'SMS: Mobizon',
            hint='Только если зарегистрирована в Mobizon, иначе пусто.'),
    Setting('telegram.bot_token', 'Токен бота', 'Уведомления админам: Telegram', secret=True),
    Setting('telegram.chat_id', 'ID чата', 'Уведомления админам: Telegram'),
    Setting('twogis.api_key', 'Ключ API 2ГИС', 'Карты: 2ГИС', secret=True),
    Setting('otp.review_phone', 'Номер для ревью сторов', 'Демо-вход для Google Play и App Store',
            hint='На этот номер вход без SMS, с кодом ниже. Задавать только на время ревью.'),
    Setting('otp.review_code', 'Код для ревью (4 цифры)', 'Демо-вход для Google Play и App Store', secret=True),
]

ENV_NAMES = {
    'freedompay.merchant_id': 'FREEDOMPAY_MERCHANT_ID',
    'freedompay.secret': 'FREEDOMPAY_SECRET',
    'freedompay.testing_mode': 'FREEDOMPAY_TESTING',
    'freedompay.api_url': 'FREEDOMPAY_API_URL',
    'plans.pro_month_price': 'PRO_MONTH_PRICE',
    'sms.mobizon_api_key': 'MOBIZON_API_KEY',
    'sms.mobizon_sender': 'MOBIZON_SENDER',
    'telegram.bot_token': 'TELEGRAM_BOT_TOKEN',
    'telegram.chat_id': 'TELEGRAM_CHAT_ID',
    'twogis.api_key': 'TWOGIS_API_KEY',
    'otp.review_phone': 'REVIEW_PHONE',
    'otp.review_code': 'REVIEW_CODE',
}

BY_KEY = {s.key: s for s in SETTINGS}

# Значения из окружения на момент запуска — к ним возвращаемся, когда
# значение в базе удаляют.
_ENV_DEFAULTS: dict[str, object] = {}

# Ключи, чьё значение в базе не расшифровалось (сменили SETTINGS_KEY).
_UNREADABLE: set[str] = set()

_last_seen: Optional[str] = None


# -------------------------------------------------------------------------
# Шифрование
# -------------------------------------------------------------------------

def _fernet() -> Fernet:
    secret = os.environ.get('SETTINGS_KEY', '').strip() or config['jwt']['secret']
    key = base64.urlsafe_b64encode(hashlib.sha256(('stroyapp-settings:' + secret).encode()).digest())
    return Fernet(key)


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode('utf-8')).decode('ascii')


def decrypt(token: str) -> Optional[str]:
    try:
        return _fernet().decrypt(token.encode('ascii')).decode('utf-8')
    except (InvalidToken, ValueError):
        return None


# -------------------------------------------------------------------------
# Значения
# -------------------------------------------------------------------------

def _path(key: str) -> tuple[str, str]:
    section, field = key.split('.', 1)
    return section, field


def _get_config(key: str):
    section, field = _path(key)
    return config[section][field]


def _set_config(key: str, value) -> None:
    section, field = _path(key)
    config[section][field] = value


def coerce(setting: Setting, raw: str):
    """Строку из базы или формы — в тот вид, что лежит в config."""
    if setting.kind == 'int':
        return int(raw)
    if setting.kind == 'bool':
        return '1' if raw in ('1', 'true', 'True', 'on') else '0'
    return raw.strip()


def validate(setting: Setting, raw: str) -> str:
    """Проверить ввод админа. Вернёт строку для хранения или бросит ValueError."""
    raw = (raw or '').strip()
    if not raw:
        raise ValueError('Пустое значение. Чтобы вернуть значение из .env, нажмите «Сбросить»')
    if len(raw) > VALUE_MAX:
        raise ValueError(f'Не длиннее {VALUE_MAX} символов')
    if setting.kind == 'int':
        if not raw.isdigit() or not (0 < int(raw) <= 10_000_000):
            raise ValueError('Целое число больше нуля')
    if setting.kind == 'bool' and raw not in ('0', '1'):
        raise ValueError('0 или 1')
    if setting.key == 'otp.review_code' and (len(raw) != 4 or not raw.isdigit()):
        raise ValueError('Код — ровно 4 цифры')
    if setting.key == 'otp.review_phone':
        try:
            raw = normalize_phone(raw)
        except WarnException:
            raise ValueError('Номер в формате +7 7XX XXX XX XX')
    if setting.key == 'freedompay.api_url' and not raw.startswith('https://'):
        raise ValueError('Адрес должен начинаться с https://')
    return raw


def remember_env_defaults() -> None:
    """Запомнить значения из окружения до того, как их перекроет база."""
    for s in SETTINGS:
        if s.key not in _ENV_DEFAULTS:
            _ENV_DEFAULTS[s.key] = _get_config(s.key)


async def load_settings() -> None:
    """Перечитать app_settings и разложить значения по config."""
    global _last_seen
    remember_env_defaults()
    rows = await query_db("SELECT key, value, updated_at FROM app_settings")
    stored = {r['key']: r for r in rows}
    _UNREADABLE.clear()
    for s in SETTINGS:
        row = stored.get(s.key)
        value = _ENV_DEFAULTS[s.key]
        if row is not None:
            raw = decrypt(row['value']) if s.secret else row['value']
            if raw is None:
                _UNREADABLE.add(s.key)
            else:
                try:
                    value = coerce(s, raw)
                except ValueError:
                    _UNREADABLE.add(s.key)
        _set_config(s.key, value)
    _last_seen = max((r['updated_at'] for r in rows), default='') + f'#{len(rows)}'


async def _changed_since_load() -> bool:
    rows = await query_db("SELECT COALESCE(MAX(updated_at), '') AS m, COUNT(*)::int AS n FROM app_settings")
    return f"{rows[0]['m']}#{rows[0]['n']}" != _last_seen


async def reload_forever() -> None:
    """Фоновая задача воркера: подхватить изменения, сделанные в другом воркере."""
    while True:
        await asyncio.sleep(RELOAD_SECONDS)
        try:
            if await _changed_since_load():
                await load_settings()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # база мигнула — попробуем в следующий раз
            print(f"[{get_timestamp_now()}] ⚠️ Настройки не перечитаны: {e}")


async def store_setting(key: str, raw: str, admin_id: int) -> None:
    s = BY_KEY[key]
    value = encrypt(raw) if s.secret else raw
    now = get_timestamp_now()
    await query_db(f"""
        INSERT INTO app_settings (key, value, updated_at, updated_by)
        VALUES ({fit_to_sql(key)}, {fit_to_sql(value)}, {fit_to_sql(now)}, {fit_to_sql(admin_id)})
        ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
    """)
    await load_settings()


async def clear_setting(key: str) -> None:
    await query_db(f"DELETE FROM app_settings WHERE key = {fit_to_sql(key)}")
    await load_settings()


def _mask(value: str) -> str:
    """Секрет целиком не показываем: только длину и последние два знака."""
    tail = value[-2:] if len(value) >= 12 else ''
    return f"задан, {len(value)} симв." + (f", …{tail}" if tail else '')


async def describe_settings() -> list[dict]:
    """Список для админки: откуда значение и само значение (секрет — маской)."""
    # Поменяли через другой воркер — показываем свежее, а не ждём перечитывания.
    if await _changed_since_load():
        await load_settings()
    rows = await query_db("""
        SELECT s.key, s.updated_at, u.full_name AS updated_by_name, u.phone AS updated_by_phone
        FROM app_settings s
        LEFT JOIN users u ON u.id = s.updated_by
    """)
    stored = {r['key']: r for r in rows}
    items = []
    for s in SETTINGS:
        row = stored.get(s.key)
        current = _get_config(s.key)
        env_value = _ENV_DEFAULTS.get(s.key)
        if s.key in _UNREADABLE:
            source = 'unreadable'
        elif row is not None:
            source = 'db'
        elif env_value not in (None, ''):
            source = 'env'
        else:
            source = 'none'
        shown = None
        if current not in (None, ''):
            shown = _mask(str(current)) if s.secret else str(current)
        items.append({
            'key': s.key,
            'label': s.label,
            'group': s.group,
            'hint': s.hint,
            'secret': s.secret,
            'kind': s.kind,
            'env': s.env,
            'source': source,
            'value': shown,
            'updated_at': row['updated_at'] if row else None,
            'updated_by': (row['updated_by_name'] or row['updated_by_phone']) if row else None,
        })
    return items
