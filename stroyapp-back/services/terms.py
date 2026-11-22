"""
Согласие с Условиями использования (страница /terms, static/terms.html).

Приложение спрашивает согласие при входе: человек видит условия и нажимает
«Принимаю». Здесь это согласие хранится — кто, какую версию и когда принял.
Магазины приложений требуют этого от сервисов, где люди пишут друг другу и
публикуют своё: условия должны прямо запрещать оскорбления и недопустимые
материалы, а человек — согласиться с ними до того, как что-то опубликует.

TERMS_VERSION — версия текста на странице. Меняется вместе с существенной
правкой условий: у всех, кто принимал прежнюю, флаг terms_accepted снова
станет false, и приложение спросит согласие заново. Прежние согласия не
удаляются: строка таблицы — «этот человек принял эту версию тогда-то».

Сервер согласия не требует — только хранит и отдаёт флаг. Сборки приложения,
вышедшие раньше, о нём не знают, и отказ в запросах закрыл бы их
пользователям переписку и заявки. Спрашивает и не пускает дальше само
приложение.

Приложение получает номер действующей версии вместе с пользователем
(terms_version) и возвращает его в запросе согласия. Так в строке таблицы
оказывается версия, которую человек действительно открывал: если условия
сменились, пока шторка была открыта, сервер ответит 409, и приложение
покажет шаг заново.

У демо-номера и служебных аккаунтов согласие сбрасывается при каждом входе
(routers/r01_auth.py): ими пользуются проверяющие магазинов и тестировщики,
и шаг согласия они должны видеть каждый раз, как видит его новый человек.

Вместе с аккаунтом согласия удаляются (services/account.py).
"""
from connections.connect_postgres import query_db
from libs.common import fit_to_sql
from libs.date import get_timestamp_now


# Та же версия стоит в шапке static/terms.html — менять вместе.
TERMS_VERSION = '1.0'


async def is_accepted(user_id: int) -> bool:
    """Принял ли человек действующую версию условий."""
    rows = await query_db(f"""
        SELECT 1 AS x FROM terms_acceptances
        WHERE user_id = {fit_to_sql(user_id)}
          AND version = {fit_to_sql(TERMS_VERSION)}
    """)
    return bool(rows)


async def accept(user_id: int) -> None:
    # Повторное согласие с той же версией ничего не меняет: в строке остаётся
    # время первого. ON CONFLICT, а не проверка перед вставкой: два запроса
    # разом (двойное нажатие) дают одну строку и ни одной ошибки.
    await query_db(f"""
        INSERT INTO terms_acceptances (user_id, version, accepted_at)
        VALUES (
            {fit_to_sql(user_id)},
            {fit_to_sql(TERMS_VERSION)},
            {fit_to_sql(get_timestamp_now())}
        )
        ON CONFLICT (user_id, version) DO NOTHING
    """)


async def forget(user_id: int) -> None:
    """Забыть согласие с действующей версией: при следующем входе спросят снова."""
    await query_db(f"""
        DELETE FROM terms_acceptances
        WHERE user_id = {fit_to_sql(user_id)}
          AND version = {fit_to_sql(TERMS_VERSION)}
    """)


async def user_public(user: dict) -> dict:
    """
    Пользователь, каким его получает приложение, — один и тот же срез во всех
    ответах, где он есть (вход, профиль, смена имени и языка). Приложение
    кладёт пришедший объект в своё хранилище целиком, и ответ без
    terms_accepted стёр бы у него уже известное согласие.

    Без fcm_token, is_blocked и служебных признаков: приложению они не нужны.
    """
    return {
        'id': user['id'],
        'guid': user['guid'],
        'phone': user['phone'],
        'full_name': user['full_name'],
        'language': user['language'],
        'terms_accepted': await is_accepted(user['id']),
        'terms_version': TERMS_VERSION,
    }
