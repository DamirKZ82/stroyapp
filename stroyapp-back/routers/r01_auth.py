"""
Авторизация по номеру телефона:

    POST /auth/request-otp         { phone }
    POST /auth/verify-otp          { phone, code }
    POST /auth/complete-profile    { full_name, language }   (требует токен)
    POST /auth/fcm-token           { token }                 (требует токен)

Поток:
    1. request-otp  -> создаём запись в otp_codes, шлём SMS (мок).
    2. verify-otp   -> валидируем, создаём юзера если новый, выдаём JWT.
                       В ответе user.terms_accepted — принял ли человек
                       Условия использования; принимает он их отдельным
                       запросом POST /profile/terms (services/terms.py).
    3. complete-profile -> заполняем ФИО и язык (для новых юзеров).
    4. fcm-token    -> сохраняем токен устройства для пушей.
"""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator

from config import config
from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from handlers.h03_auth import BLOCKED_MESSAGE, auth_user
from libs.auth import issue_token
from libs.common import fit_to_sql, new_guid
from libs.date import get_timestamp_now, add_minutes
from libs.phone import normalize_phone
from libs.sms import send_otp
from libs.text_filter import Clean
from services.terms import forget as forget_terms, user_public


router = APIRouter(prefix='/auth')


# -------------------------------------------------------------------------
# Pydantic модели
# -------------------------------------------------------------------------

class RequestOtpBody(BaseModel):
    phone: str


class VerifyOtpBody(BaseModel):
    phone: str
    code: str

    @field_validator('code')
    @classmethod
    def code_format(cls, val):
        val = (val or '').strip()
        if len(val) != 4 or not val.isdigit():
            raise ValueError('Код должен состоять из 4 цифр')
        return val


class CompleteProfileBody(BaseModel):
    full_name: Clean
    language: str = 'ru'

    @field_validator('full_name')
    @classmethod
    def full_name_not_empty(cls, val):
        val = (val or '').strip()
        if not val:
            raise ValueError('ФИО не может быть пустым')
        if len(val) > 200:
            raise ValueError('ФИО не должно быть длиннее 200 символов')
        return val

    @field_validator('language')
    @classmethod
    def language_valid(cls, val):
        val = (val or '').strip().lower()
        if val not in ('ru', 'kz'):
            raise ValueError("Язык должен быть 'ru' или 'kz'")
        return val


class FcmTokenBody(BaseModel):
    token: str

    @field_validator('token')
    @classmethod
    def token_not_empty(cls, val):
        val = (val or '').strip()
        if not val:
            raise ValueError('FCM-токен не может быть пустым')
        if len(val) > 500:
            raise ValueError('FCM-токен слишком длинный')
        return val


# -------------------------------------------------------------------------
# Демо-номер для ревью сторов
# -------------------------------------------------------------------------

def review_phone() -> Optional[str]:
    """
    Нормализованный демо-номер для ревьюеров Google Play / App Store,
    либо None, если функция выключена.

    Считается при каждом вызове, а не раз при старте: номер и код задают в
    админке («Настройки»), и включить или выключить демо-вход можно без
    перезапуска. Формат админка проверяет при вводе; кривое значение из .env
    просто выключает функцию.
    """
    raw = config['otp']['review_phone']
    code = config['otp']['review_code']
    if not raw or not code:
        return None
    # VerifyOtpBody принимает строго 4 цифры: код другого формата ревьюер
    # физически не сможет отправить, поэтому такой конфиг не включаем.
    if len(code) != 4 or not code.isdigit():
        return None
    try:
        return normalize_phone(raw)
    except WarnException:
        return None


# -------------------------------------------------------------------------
# Хелперы
# -------------------------------------------------------------------------

async def _user_by_phone(phone: str) -> Optional[dict]:
    rows = await query_db(f"""
        SELECT id, guid, phone, full_name, language, fcm_token, is_blocked,
               is_service, service_code
        FROM users
        WHERE phone = {fit_to_sql(phone)}
    """)
    return rows[0] if rows else None


async def _fixed_code(phone: str) -> Optional[str]:
    """
    Фиксированный код для номера, либо None — тогда код случайный и
    уходит по SMS.

    Фиксированный код бывает у демо-номера (review_phone) и у служебных
    аккаунтов, созданных в админке. SMS им не шлём: номера могут не
    существовать, а код владелец и так знает.
    """
    if phone == review_phone():
        return config['otp']['review_code']
    user = await _user_by_phone(phone)
    if user and user['is_service'] and user['service_code']:
        return user['service_code']
    return None


async def _create_user(phone: str) -> dict:
    now = get_timestamp_now()
    guid = new_guid()
    rows = await query_db(f"""
        INSERT INTO users (guid, phone, language, created_at, updated_at)
        VALUES (
            {fit_to_sql(guid)},
            {fit_to_sql(phone)},
            'ru',
            {fit_to_sql(now)},
            {fit_to_sql(now)}
        )
        RETURNING id, guid, phone, full_name, language, fcm_token, is_blocked
    """)
    return rows[0]


# -------------------------------------------------------------------------
# Эндпоинты
# -------------------------------------------------------------------------

@router.post('/request-otp')
async def request_otp(body: RequestOtpBody):
    phone = normalize_phone(body.phone)
    now = get_timestamp_now()

    # Защита от спама: не чаще 1 запроса в 60 секунд на номер.
    # Считаем "отправленным недавно" любой неиспользованный живой код,
    # созданный за последние 60 секунд.
    # Действует и для фиксированных кодов: иначе каждый новый запрос
    # давал бы свежие попытки угадать, и лимит на код ничего бы не стоил.
    rate_limit_boundary = add_minutes(now, -1)   # now - 1 минута
    recent = await query_db(f"""
        SELECT id FROM otp_codes
        WHERE phone = {fit_to_sql(phone)}
          AND used = false
          AND created_at > {fit_to_sql(rate_limit_boundary)}
        LIMIT 1
    """)
    if recent:
        raise WarnException(429, 'Код уже отправлен. Повторите попытку через минуту.')

    # Не больше max_requests_hour кодов в час на номер. Вместе с лимитом
    # попыток на код это ограничивает перебор и расход на SMS.
    hour_boundary = add_minutes(now, -60)
    per_hour = await query_db(f"""
        SELECT COUNT(*) AS cnt FROM otp_codes
        WHERE phone = {fit_to_sql(phone)}
          AND created_at > {fit_to_sql(hour_boundary)}
    """)
    if per_hour[0]['cnt'] >= config['otp']['max_requests_hour']:
        raise WarnException(429, 'Слишком много запросов кода. Попробуйте через час.')

    # Любой прежний неиспользованный код — помечаем использованным (Вариант А).
    await query_db(f"""
        UPDATE otp_codes
           SET used = true
         WHERE phone = {fit_to_sql(phone)}
           AND used = false
    """)

    # Создаём новый код
    # фиксированный — демо-номер ревью или служебный аккаунт, без SMS
    # dev           — '0000' (удобно тестировать)
    # прочее        — случайные 4 цифры
    fixed = await _fixed_code(phone)
    if fixed:
        code = fixed
    elif config['env'] == 'dev':
        code = config['otp']['mock_code']   # '0000'
    else:
        import secrets
        code = f'{secrets.randbelow(10000):04d}'

    expires_at = add_minutes(now, config['otp']['ttl_minutes'])
    await query_db(f"""
        INSERT INTO otp_codes (phone, code, created_at, expires_at, used)
        VALUES (
            {fit_to_sql(phone)},
            {fit_to_sql(code)},
            {fit_to_sql(now)},
            {fit_to_sql(expires_at)},
            false
        )
    """)

    if not fixed:
        await send_otp(phone, code)
    return {'sent': True}


@router.post('/verify-otp')
async def verify_otp(body: VerifyOtpBody):
    phone = normalize_phone(body.phone)
    now = get_timestamp_now()

    # Ищем живой неиспользованный код для этого номера.
    rows = await query_db(f"""
        SELECT id, code, expires_at
        FROM otp_codes
        WHERE phone = {fit_to_sql(phone)}
          AND used = false
        ORDER BY id DESC
        LIMIT 1
    """)
    if not rows:
        raise WarnException(400, 'Код не запрошен или уже использован')

    otp = rows[0]

    # Истёк?
    if otp['expires_at'] < now:
        # Пометим использованным, чтобы не светился в /request-otp rate-limit
        await query_db(f"""
            UPDATE otp_codes SET used = true WHERE id = {fit_to_sql(otp['id'])}
        """)
        raise WarnException(400, 'Срок действия кода истёк. Запросите новый.')

    # Сначала списываем попытку, потом сравниваем. Условие attempts < лимита
    # стоит прямо в UPDATE, поэтому даже тысяча параллельных запросов
    # получит не больше max_attempts сравнений на один код.
    max_attempts = config['otp']['max_attempts']
    slot = await query_db(f"""
        UPDATE otp_codes
           SET attempts = attempts + 1
         WHERE id = {fit_to_sql(otp['id'])}
           AND used = false
           AND attempts < {fit_to_sql(max_attempts)}
        RETURNING attempts, code
    """)
    if not slot:
        raise WarnException(400, 'Слишком много неверных попыток. Запросите новый код.')

    # Не совпал?
    if slot[0]['code'] != body.code:
        if slot[0]['attempts'] >= max_attempts:
            await query_db(f"""
                UPDATE otp_codes SET used = true WHERE id = {fit_to_sql(otp['id'])}
            """)
            raise WarnException(400, 'Слишком много неверных попыток. Запросите новый код.')
        raise WarnException(400, 'Неверный код')

    # Код валиден -> используем его. Условие used = false не даёт
    # войти одним кодом дважды параллельными запросами.
    consumed = await query_db(f"""
        UPDATE otp_codes SET used = true
         WHERE id = {fit_to_sql(otp['id'])} AND used = false
        RETURNING id
    """)
    if not consumed:
        raise WarnException(400, 'Код не запрошен или уже использован')

    # Ищем или создаём юзера
    user = await _user_by_phone(phone)
    is_new_user = False
    if user is None:
        user = await _create_user(phone)
        is_new_user = True
    elif user['is_blocked']:
        raise WarnException(403, BLOCKED_MESSAGE)

    # Демо-номером и служебными аккаунтами входят проверяющие магазинов и
    # тестировщики — каждый раз как новый человек. Согласие, оставшееся от
    # прошлого входа, спрятало бы от них шаг с условиями, а его и проверяют.
    if not is_new_user and (user['is_service'] or phone == review_phone()):
        await forget_terms(user['id'])

    token = issue_token(user['id'])
    return {
        'token': token,
        'is_new_user': is_new_user,
        'user': await user_public(user),
    }


@router.post('/complete-profile')
async def complete_profile(body: CompleteProfileBody, user=Depends(auth_user)):
    now = get_timestamp_now()
    rows = await query_db(f"""
        UPDATE users
           SET full_name = {fit_to_sql(body.full_name)},
               language  = {fit_to_sql(body.language)},
               updated_at = {fit_to_sql(now)}
         WHERE id = {fit_to_sql(user['id'])}
        RETURNING id, guid, phone, full_name, language
    """)
    return {'user': await user_public(rows[0])}


@router.post('/fcm-token')
async def set_fcm_token(body: FcmTokenBody, user=Depends(auth_user)):
    now = get_timestamp_now()
    await query_db(f"""
        UPDATE users
           SET fcm_token = {fit_to_sql(body.token)},
               updated_at = {fit_to_sql(now)}
         WHERE id = {fit_to_sql(user['id'])}
    """)
    return {'ok': True}
