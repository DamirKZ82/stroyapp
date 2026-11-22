"""
Тариф продавца: магазина или бригады. Клиенты пользуются бесплатно, деньги по
сделкам через платформу не идут — платит только продавец, за подписку.

Тарифы:
    trial — пробный период, trial_days с первого объявления: прайс как в Pro.
    free  — после пробного периода, если не оплачен Pro: объявления видны,
            но в прайсе показываются только первые free_items позиций.
    pro   — оплачен: прайс до pro_items позиций, продвижение в поиске
            (выше при сортировке «по рейтингу») и значок «Проверенный»,
            если админ сверил БИН/ИИН.

Позиции сверх лимита не удаляются: при неоплате они просто не видны в
поиске и на карточке, а после оплаты возвращаются сами.

Состояние лежит в seller_plans (по строке на продавца), оплаты — в payments.
"""
from datetime import datetime, timedelta

from config import config
from connections.connect_postgres import query_db
from libs.common import fit_to_sql
from libs.date import get_timestamp_now


_FMT = '%Y-%m-%dT%H:%M:%S'

# Сроки оплаты, месяцев → множитель цены месяца. Дольше — дешевле за месяц.
PERIODS = {1: 1.0, 3: 2.7, 12: 10.0}
# Месяц тарифа — 30 дней: так срок не зависит от длины календарного месяца.
MONTH_DAYS = 30


def add_days(ts: str, days: int) -> str:
    return (datetime.strptime(ts, _FMT) + timedelta(days=days)).strftime(_FMT)


def period_price(months: int) -> int:
    """Цена за срок, ₸, округлённая до сотни вниз."""
    raw = config['plans']['pro_month_price'] * PERIODS[months]
    return int(raw // 100 * 100)


def plan_from_row(row: dict | None, now: str | None = None) -> dict:
    """Тариф по строке seller_plans (или её отсутствию)."""
    now = now or get_timestamp_now()
    plans = config['plans']
    if row is None:
        # Объявлений ещё не было — пробный период начнётся с первого.
        return {
            'tier': 'none',
            'trial_ends_at': None,
            'paid_until': None,
            'items_limit': plans['pro_items'],
            'promoted': False,
        }
    paid = bool(row['paid_until'] and row['paid_until'] > now)
    trial = row['trial_ends_at'] > now
    tier = 'pro' if paid else 'trial' if trial else 'free'
    return {
        'tier': tier,
        'trial_ends_at': row['trial_ends_at'],
        'paid_until': row['paid_until'],
        'items_limit': plans['pro_items'] if tier in ('pro', 'trial') else plans['free_items'],
        'promoted': paid,
    }


async def get_plan(user_id: int) -> dict:
    rows = await query_db(f"""
        SELECT trial_ends_at, paid_until FROM seller_plans
        WHERE user_id = {fit_to_sql(user_id)}
    """)
    return plan_from_row(rows[0] if rows else None)


async def start_trial(user_id: int, tx=None) -> None:
    """С первого объявления начинается пробный период. Повторно ничего не меняет."""
    now = get_timestamp_now()
    sql = f"""
        INSERT INTO seller_plans (user_id, trial_ends_at, paid_until, created_at, updated_at)
        VALUES ({fit_to_sql(user_id)}, {fit_to_sql(add_days(now, config['plans']['trial_days']))},
                null, {fit_to_sql(now)}, {fit_to_sql(now)})
        ON CONFLICT (user_id) DO NOTHING
    """
    if tx is not None:
        await tx.query(sql)
    else:
        await query_db(sql)


async def extend_pro(tx, user_id: int, months: int) -> str:
    """
    Продлить Pro на months месяцев внутри транзакции tx. Оплата поверх ещё
    действующей добавляется к её концу, а не к сегодняшнему дню.
    Возвращает новый paid_until.
    """
    now = get_timestamp_now()
    rows = await tx.query(f"""
        SELECT paid_until FROM seller_plans
        WHERE user_id = {fit_to_sql(user_id)}
        FOR UPDATE
    """)
    if not rows:
        # Оплатили, не создав объявления: пробный период уже не нужен.
        await tx.query(f"""
            INSERT INTO seller_plans (user_id, trial_ends_at, paid_until, created_at, updated_at)
            VALUES ({fit_to_sql(user_id)}, {fit_to_sql(now)}, null, {fit_to_sql(now)}, {fit_to_sql(now)})
        """)
        base = now
    else:
        current = rows[0]['paid_until']
        base = current if current and current > now else now
    until = add_days(base, months * MONTH_DAYS)
    await tx.query(f"""
        UPDATE seller_plans
           SET paid_until = {fit_to_sql(until)}, updated_at = {fit_to_sql(now)}
         WHERE user_id = {fit_to_sql(user_id)}
    """)
    return until


# -------------------------------------------------------------------------
# Кусочки SQL для поиска и карточки. owner — выражение с id владельца
# объявления (обычно p.owner_id), now — уже экранированная строка времени.
# -------------------------------------------------------------------------

def paid_sql(owner: str, now: str) -> str:
    """Оплачен ли Pro у владельца."""
    return (f"EXISTS (SELECT 1 FROM seller_plans sp WHERE sp.user_id = {owner} "
            f"AND sp.paid_until > {now})")


def items_limit_sql(owner: str, now: str) -> str:
    """Сколько позиций прайса владельца видно сейчас."""
    plans = config['plans']
    return (f"(CASE WHEN EXISTS (SELECT 1 FROM seller_plans sp WHERE sp.user_id = {owner} "
            f"AND (sp.paid_until > {now} OR sp.trial_ends_at > {now})) "
            f"THEN {int(plans['pro_items'])} ELSE {int(plans['free_items'])} END)")


def visible_item_sql(pi: str, owner: str, now: str) -> str:
    """
    Позиция прайса видна: её номер в прайсе меньше лимита тарифа. sort_order
    сервер ставит сам, подряд с нуля (PUT /providers/{guid}/items).
    """
    return f"{pi}.sort_order < {items_limit_sql(owner, now)}"


def verified_sql(p: str, now: str) -> str:
    """Значок «Проверенный»: админ сверил БИН и у владельца оплачен Pro."""
    return f"({p}.verified_at IS NOT NULL AND {paid_sql(p + '.owner_id', now)})"
