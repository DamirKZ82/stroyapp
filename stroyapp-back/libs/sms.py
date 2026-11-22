"""
Отправка SMS через Mobizon (Казахстан).

Логика:
  - dev: ничего не отправляем, код постоянный (свой у входа в приложение и у
    пароля админки), он пишется в консоль.
  - prod: реальный HTTP к Mobizon API.

Конфиг (из .env):
  MOBIZON_API_KEY  — ключ из ЛК Mobizon (~256 hex). Без него отправка отключена.
  MOBIZON_SENDER   — подпись отправителя (опционально). Если зарегистрирована —
                     SMS придёт от 'TOIAPP'. Если нет — от общего 'MOBINFO'/etc.

Документация Mobizon: https://help.mobizon.com/help/api-docs
"""
import os

import httpx

from config import config
from libs.date import get_timestamp_now


# Эндпоинт казахстанского узла Mobizon
MOBIZON_API_URL = 'https://api.mobizon.kz/service/Message/SendSmsMessage'

# Таймаут на HTTP-запрос. Mobizon обычно отвечает за 1-2 сек, но кладу запас.
MOBIZON_TIMEOUT_SEC = 10


def _build_otp_text(code: str) -> str:
    """
    Текст SMS с OTP-кодом.
    Латиница — 1 SMS на 160 символов = дёшево. Кириллица — 70 символов.
    """
    return f'ToiApp: vash kod {code}. Nikomu ne soobshchaite.'


def _build_admin_code_text(code: str) -> str:
    """
    Текст SMS с кодом для пароля админки. Говорит, для чего код: его не
    спутать с кодом входа в приложение и труднее выманить «назовите код из SMS».
    """
    return f'ToiApp admin: kod {code} dlya parolya adminki. Nikomu ne soobshchaite.'


async def send_otp(phone: str, code: str) -> None:
    """
    Отправить OTP-код на номер телефона.
    Никогда не падает наружу — ошибки только логируются.
    Иначе при сбоях у Mobizon юзер не сможет даже попытаться залогиниться.
    """
    await _send_code(phone, code, _build_otp_text(code), code_in_log=True)


async def send_admin_code(phone: str, code: str) -> None:
    """
    Отправить код для задания пароля админки. Тоже никогда не падает наружу.
    Вне разработки сам код в журнал сервера не попадает ни при каком сбое:
    им задают пароль админки, а журнал читают не только админы.
    """
    await _send_code(phone, code, _build_admin_code_text(code), code_in_log=False)


async def _send_code(phone: str, code: str, text: str, code_in_log: bool) -> None:
    # На dev — мок. Не тратим деньги на тестовые SMS.
    if config['env'] == 'dev':
        print(f"[{get_timestamp_now()}] 📱 MOCK SMS -> {phone}: код {code}")
        return

    api_key = os.environ.get('MOBIZON_API_KEY', '').strip()
    if not api_key:
        # Прод, но ключ не настроен — не падаем, но громко жалуемся в лог.
        print(
            f"[{get_timestamp_now()}] ⚠️ MOBIZON_API_KEY не настроен. "
            f"SMS на {phone} НЕ отправлен." + (f" Код: {code}" if code_in_log else ''),
        )
        return

    sender = os.environ.get('MOBIZON_SENDER', '').strip()

    # Mobizon хочет номер БЕЗ '+', только цифры.
    # Наш phone уже нормализован в формате +7XXXXXXXXXX.
    recipient = phone.lstrip('+')

    payload = {
        'apiKey': api_key,
        'recipient': recipient,
        'text': text,
        # Тип сообщения: 1 = верификационное (правильный тариф для OTP).
        # У Mobizon эта классификация официальна, влияет на цену и доставку
        # в ночное время (рекламные SMS только 9:00–21:00).
    }
    if sender:
        payload['from'] = sender

    try:
        async with httpx.AsyncClient(timeout=MOBIZON_TIMEOUT_SEC) as client:
            response = await client.post(
                MOBIZON_API_URL,
                params={'output': 'json', 'api': 'v1'},
                data=payload,
            )

        # Любой код ответа кроме 200 — ошибка транспорта/прав.
        if response.status_code != 200:
            print(
                f"[{get_timestamp_now()}] ❌ Mobizon HTTP {response.status_code} "
                f"на {phone}: {response.text[:200]}"
            )
            return

        body = response.json()
        # Mobizon отвечает структурой: {"code": 0, "data": {...}, "message": "..."}
        # code=0 — успех, остальное — ошибка.
        if body.get('code', -1) != 0:
            print(
                f"[{get_timestamp_now()}] ❌ Mobizon API error на {phone}: "
                f"code={body.get('code')} msg={body.get('message')}"
            )
            return

        msg_id = body.get('data', {}).get('messageId') or body.get('data', {}).get('campaignId')
        print(
            f"[{get_timestamp_now()}] ✉️ SMS отправлен -> {phone} "
            f"(id={msg_id})"
        )

    except httpx.HTTPError as e:
        print(f"[{get_timestamp_now()}] ❌ Mobizon network error на {phone}: {e}")
    except Exception as e:
        print(f"[{get_timestamp_now()}] ❌ Mobizon unexpected error на {phone}: {e}")
