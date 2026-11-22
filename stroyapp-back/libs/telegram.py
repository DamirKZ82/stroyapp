"""
Сообщение админам в Telegram: сбой сервера, новая жалоба, события доступа в
админку (запрошен код, задан пароль, назначен или снят админ).

Если токен или чат не заданы — тихо ничего не делаем: уведомления удобство,
а не часть работы сервиса.
"""
import httpx

from config import config
from libs.date import get_timestamp_now


async def send_to_admins(text: str) -> None:
    """Отправить текст в чат админов. Не бросает: сбой Telegram — не сбой запроса."""
    tg = config['telegram']
    if not tg['bot_token'] or not tg['chat_id']:
        return
    try:
        url = f"https://api.telegram.org/bot{tg['bot_token']}/sendMessage"
        async with httpx.AsyncClient(timeout=5) as client:
            answer = await client.post(url, json={
                'chat_id': tg['chat_id'],
                'text': text,
                # Без превью ссылок: в тексте есть ссылка на админку — ходить
                # по ней серверам Telegram незачем.
                'link_preview_options': {'is_disabled': True},
            })
        if answer.status_code != 200:
            # Отказ Telegram (лимит сообщений, неверный чат) иначе не виден нигде.
            print(f"[{get_timestamp_now()}] ⚠️ Telegram notify refused: {answer.status_code}")
    except Exception as err:
        print(f"[{get_timestamp_now()}] ⚠️ Telegram notify failed: {err}")
