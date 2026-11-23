"""
Тариф продавца и его оплата (libs/plans.py, libs/payments.py).

    GET  /subscription                  — мой тариф, цены, доступна ли оплата
    POST /subscription/checkout         — начать оплату: {months: 1|3|12} → адрес страницы оплаты
    GET  /subscription/payments         — мои оплаты

Страницы и обратные вызовы шлюза (без JWT):
    POST /payments/freedompay/result    — Freedom Pay сообщает результат оплаты
    GET  /payments/done                 — «оплата прошла / не прошла», куда шлюз возвращает человека
                                          (from=cabinet — со ссылкой обратно в веб-кабинет)
    GET  /payments/test/{guid}          — тестовая страница оплаты (только в разработке)
    POST /payments/test/{guid}/pay      — «оплатить» на тестовой странице
"""
import html

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from typing import Literal, Optional

from pydantic import BaseModel, field_validator

from config import config
from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from handlers.h03_auth import auth_user
from libs.common import fit_to_sql, new_guid
from libs.date import get_timestamp_now
from libs.payments import fp_check, fp_init, fp_xml_answer, gateway, mark_failed, mark_paid
from libs.plans import PERIODS, get_plan, period_price


router = APIRouter()


class CheckoutBody(BaseModel):
    months: int
    # Откуда платят: из веб-кабинета человека после оплаты ведём обратно в
    # него, а не просим «вернуться в приложение».
    back: Optional[Literal['app', 'cabinet']] = None

    @field_validator('months')
    @classmethod
    def months_ok(cls, val):
        if val not in PERIODS:
            raise ValueError(f'Срок оплаты — один из: {sorted(PERIODS)} мес.')
        return val


def _offer() -> dict:
    plans = config['plans']
    return {
        'trial_days': plans['trial_days'],
        'free_items': plans['free_items'],
        'pro_items': plans['pro_items'],
        'periods': [{'months': m, 'amount': period_price(m)} for m in sorted(PERIODS)],
        'can_pay': gateway() is not None,
    }


@router.get('/subscription')
async def my_subscription(user=Depends(auth_user)):
    plan = await get_plan(user['id'])
    return {'plan': plan, 'offer': _offer()}


@router.post('/subscription/checkout')
async def checkout(body: CheckoutBody, user=Depends(auth_user)):
    gw = gateway()
    if gw is None:
        raise WarnException(503, f"Оплата картой пока недоступна. Напишите на {config['support_email']}")
    now = get_timestamp_now()
    amount = period_price(body.months)
    rows = await query_db(f"""
        INSERT INTO payments (guid, user_id, months, amount, status, gateway, created_at)
        VALUES ({fit_to_sql(new_guid())}, {fit_to_sql(user['id'])}, {fit_to_sql(body.months)},
                {fit_to_sql(amount)}, 'pending', {fit_to_sql(gw)}, {fit_to_sql(now)})
        RETURNING id, guid, amount, months
    """)
    payment = rows[0]
    if gw == 'test':
        url = f"{config['public_url']}/payments/test/{payment['guid']}"
        if body.back == 'cabinet':
            url += '?from=cabinet'
    else:
        url = await fp_init(payment, f"StroyApp Pro, {body.months} мес.", body.back)
    return {'payment_guid': payment['guid'], 'url': url}


@router.get('/subscription/payments')
async def my_payments(user=Depends(auth_user)):
    rows = await query_db(f"""
        SELECT guid, months, amount, status, gateway, created_at, paid_at
        FROM payments
        WHERE user_id = {fit_to_sql(user['id'])} AND status <> 'pending'
        ORDER BY id DESC
        LIMIT 50
    """)
    return {'items': rows}


# -------------------------------------------------------------------------
# Шлюз
# -------------------------------------------------------------------------

@router.post('/payments/freedompay/result')
async def freedompay_result(request: Request):
    """
    Freedom Pay присылает результат оплаты формой. Подпись считается с именем
    скрипта 'result' — последней частью адреса.
    """
    form = await request.form()
    params = {k: str(v) for k, v in form.items()}
    if not config['freedompay']['secret'] or not fp_check('result', params):
        return Response(fp_xml_answer('result', 'rejected', 'bad signature'), media_type='application/xml')
    order = params.get('pg_order_id', '')
    if params.get('pg_result') == '1':
        await mark_paid(order, params.get('pg_payment_id'))
    else:
        await mark_failed(order)
    return Response(fp_xml_answer('result', 'ok', 'accepted'), media_type='application/xml')


def _page(title: str, body: str) -> HTMLResponse:
    return HTMLResponse(f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>
  body {{ font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 32px 16px;
         background: #F4F2EE; color: #1A1A1A; }}
  main {{ max-width: 420px; margin: 0 auto; background: #fff; border-radius: 14px; padding: 24px; }}
  h1 {{ font-size: 22px; margin: 0 0 12px; }}
  p {{ font-size: 16px; line-height: 1.45; }}
  button, a.btn {{ display: flex; align-items: center; justify-content: center; width: 100%;
           min-height: 48px; border: 0; border-radius: 10px; background: #1E4E79; box-sizing: border-box;
           color: #fff; font-size: 16px; font-weight: 600; text-decoration: none; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #0F1720; color: #E8EAED; }} main {{ background: #18222D; }}
    button, a.btn {{ background: #5B9BD5; color: #0F1720; }}
  }}
</style></head><body><main>{body}</main></body></html>""")


@router.get('/payments/done')
async def payment_done(status: str = 'ok', from_: Optional[str] = Query(None, alias='from')):
    if from_ == 'cabinet':
        back = '<a class="btn" href="/cabinet#plan">Вернуться в кабинет</a>'
        if status == 'ok':
            return _page('Оплата прошла', '<h1>Оплата прошла</h1><p>Тариф Pro продлён '
                         'и уже действует.</p>' + back)
        return _page('Оплата не прошла', '<h1>Оплата не прошла</h1><p>Деньги не списаны. '
                     'Попробуйте ещё раз из кабинета.</p>' + back)
    if status == 'ok':
        return _page('Оплата прошла', '<h1>Оплата прошла</h1><p>Тариф Pro продлён. '
                     'Вернитесь в приложение — он уже действует.</p>')
    return _page('Оплата не прошла', '<h1>Оплата не прошла</h1><p>Деньги не списаны. '
                 'Вернитесь в приложение и попробуйте ещё раз.</p>')


def _require_test_gateway():
    if gateway() != 'test':
        raise WarnException(404, 'Страница не найдена')


@router.get('/payments/test/{guid}')
async def test_checkout_page(guid: str, from_: Optional[str] = Query(None, alias='from')):
    _require_test_gateway()
    rows = await query_db(f"""
        SELECT amount, months, status FROM payments WHERE guid = {fit_to_sql(guid)}
    """)
    if not rows:
        raise WarnException(404, 'Платёж не найден')
    p = rows[0]
    safe = html.escape(guid)
    return _page('Тестовая оплата', f"""<h1>Тестовая оплата</h1>
<p>Pro на {p['months']} мес. — {f"{p['amount']:,}".replace(',', ' ')} ₸ (статус: {html.escape(p['status'])}).
Деньги не списываются: эта страница есть только в разработке.</p>
<form method="post" action="/payments/test/{safe}/pay{'?from=cabinet' if from_ == 'cabinet' else ''}"><button type="submit">Оплатить</button></form>""")


@router.post('/payments/test/{guid}/pay')
async def test_checkout_pay(guid: str, from_: Optional[str] = Query(None, alias='from')):
    _require_test_gateway()
    await mark_paid(guid, 'test')
    tail = '&from=cabinet' if from_ == 'cabinet' else ''
    return RedirectResponse(f'/payments/done?status=ok{tail}', status_code=303)
