"""
Оплата тарифа продавца картой.

Шлюз — Freedom Pay (бывший PayBox), казахстанский эквайринг: продавец
переходит на их страницу оплаты, после оплаты Freedom Pay присылает серверу
результат (result_url), и тариф продлевается. Деньги по сделкам между
клиентом и продавцом здесь не ходят — только подписка.

Подпись запросов Freedom Pay: md5 от строки
    <имя скрипта>;<значения параметров по алфавиту ключей>;<секретный ключ>
где имя скрипта — последняя часть адреса (init_payment.php, result …).

Без ключей кассы (config['freedompay']) оплата на проде недоступна, а в
разработке работает тестовый шлюз: страница /payments/test/{guid} с кнопкой
«Оплатить», которая сразу засчитывает оплату.

ВНИМАНИЕ: обмен с Freedom Pay написан по их документации и на боевой кассе
ещё не проверялся. Перед запуском — пробная оплата в тестовом режиме
(FREEDOMPAY_TESTING=1).
"""
import hashlib
import secrets
import xml.etree.ElementTree as ET
from typing import Optional

import httpx

from config import config
from connections.connect_postgres import query_db, transaction
from handlers.h01_errors import WarnException
from libs.common import fit_to_sql
from libs.date import get_timestamp_now
from libs.plans import extend_pro


def gateway() -> Optional[str]:
    """Какой шлюз работает: 'freedompay', 'test' (разработка) или None."""
    fp = config['freedompay']
    if fp['merchant_id'] and fp['secret']:
        return 'freedompay'
    if config['env'] == 'dev':
        return 'test'
    return None


# -------------------------------------------------------------------------
# Подпись Freedom Pay
# -------------------------------------------------------------------------

def _flatten(params: dict) -> list[str]:
    return [str(params[k]) for k in sorted(params) if k != 'pg_sig']


def fp_sign(script: str, params: dict) -> str:
    parts = [script, *_flatten(params), config['freedompay']['secret']]
    return hashlib.md5(';'.join(parts).encode('utf-8')).hexdigest()


def fp_check(script: str, params: dict) -> bool:
    sig = params.get('pg_sig') or ''
    return secrets.compare_digest(sig, fp_sign(script, params))


def fp_xml_answer(script: str, status: str, description: str) -> str:
    """Ответ серверу Freedom Pay на result_url — подписанный XML."""
    params = {'pg_status': status, 'pg_description': description, 'pg_salt': secrets.token_hex(8)}
    params['pg_sig'] = fp_sign(script, params)
    body = ''.join(f'<{k}>{v}</{k}>' for k, v in params.items())
    return f'<?xml version="1.0" encoding="utf-8"?><response>{body}</response>'


async def fp_init(payment: dict, description: str) -> str:
    """Создать платёж в Freedom Pay. Возвращает адрес страницы оплаты."""
    fp = config['freedompay']
    base = config['public_url']
    params = {
        'pg_merchant_id': fp['merchant_id'],
        'pg_order_id': payment['guid'],
        'pg_amount': payment['amount'],
        'pg_currency': 'KZT',
        'pg_description': description,
        'pg_salt': secrets.token_hex(8),
        'pg_result_url': f'{base}/payments/freedompay/result',
        'pg_success_url': f'{base}/payments/done?status=ok',
        'pg_failure_url': f'{base}/payments/done?status=fail',
        'pg_testing_mode': fp['testing_mode'],
        'pg_language': 'ru',
    }
    params['pg_sig'] = fp_sign('init_payment.php', params)
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(f"{fp['api_url']}/init_payment.php", data=params)
        root = ET.fromstring(resp.text)
    except (httpx.HTTPError, ET.ParseError):
        raise WarnException(502, 'Платёжный сервис не ответил. Попробуйте ещё раз через минуту')
    answer = {child.tag: (child.text or '') for child in root}
    if answer.get('pg_status') != 'ok' or not answer.get('pg_redirect_url'):
        raise WarnException(502, 'Платёжный сервис отказал: ' + (answer.get('pg_error_description') or 'неизвестная ошибка'))
    if answer.get('pg_payment_id'):
        await query_db(f"""
            UPDATE payments SET external_id = {fit_to_sql(answer['pg_payment_id'])}
            WHERE id = {fit_to_sql(payment['id'])}
        """)
    return answer['pg_redirect_url']


# -------------------------------------------------------------------------
# Общее для всех шлюзов
# -------------------------------------------------------------------------

async def mark_paid(payment_guid: str, external_id: Optional[str] = None) -> Optional[str]:
    """
    Засчитать оплату и продлить тариф. Повторный вызов (шлюз прислал
    результат дважды) ничего не меняет. Возвращает новый paid_until или None,
    если платежа нет или он уже засчитан.
    """
    now = get_timestamp_now()
    async with transaction() as tx:
        rows = await tx.query(f"""
            SELECT id, user_id, months, status FROM payments
            WHERE guid = {fit_to_sql(payment_guid)}
            FOR UPDATE
        """)
        if not rows or rows[0]['status'] == 'paid':
            return None
        p = rows[0]
        await tx.query(f"""
            UPDATE payments
               SET status = 'paid', paid_at = {fit_to_sql(now)},
                   external_id = COALESCE({fit_to_sql(external_id)}, external_id)
             WHERE id = {fit_to_sql(p['id'])}
        """)
        if p['user_id'] is None:
            # Аккаунт удалили, пока шла оплата: продлевать некому.
            return None
        return await extend_pro(tx, p['user_id'], p['months'])


async def mark_failed(payment_guid: str) -> None:
    await query_db(f"""
        UPDATE payments SET status = 'failed'
        WHERE guid = {fit_to_sql(payment_guid)} AND status = 'pending'
    """)
