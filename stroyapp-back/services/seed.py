"""
Сиды справочников:
- cities   — крупные города Казахстана
- categories — категории материалов и услуг
- provider_attr_types — признаки объявлений (доставка, договор, гарантия…)

Идемпотентно: используем INSERT ... ON CONFLICT DO NOTHING.
"""
import pathlib

from connections.connect_postgres import query_db
from libs.common import fit_to_sql
from libs.date import get_timestamp_now


# -------------------------------------------------------------------------
# Миграции
# -------------------------------------------------------------------------

async def apply_migrations():
    """Применить db/migrations.sql. Все CREATE TABLE — IF NOT EXISTS."""
    sql_path = pathlib.Path(__file__).resolve().parent.parent / 'db' / 'migrations.sql'
    sql_text = sql_path.read_text(encoding='utf-8')
    # asyncpg умеет выполнять несколько statement'ов через execute()
    # но наш query_db делает fetch только для SELECT; для DDL-батча
    # используем прямое соединение.
    from connections.connect_postgres import _pool
    if _pool is None:
        raise RuntimeError('DB pool is not initialized')
    async with _pool.acquire() as conn:
        await conn.execute(sql_text)
    print(f"[{get_timestamp_now()}] ✅ Migrations applied")


# -------------------------------------------------------------------------
# Данные
# -------------------------------------------------------------------------

CITIES = [
    # Крупные города Казахстана. Список исчерпывающий для MVP; при необходимости дополним.
    ('Астана',       'Астана'),
    ('Алматы',       'Алматы'),
    ('Шымкент',      'Шымкент'),
    ('Караганда',    'Қарағанды'),
    ('Актобе',       'Ақтөбе'),
    ('Тараз',        'Тараз'),
    ('Павлодар',     'Павлодар'),
    ('Усть-Каменогорск', 'Өскемен'),
    ('Семей',        'Семей'),
    ('Атырау',       'Атырау'),
    ('Костанай',     'Қостанай'),
    ('Кызылорда',    'Қызылорда'),
    ('Уральск',      'Орал'),
    ('Петропавловск','Петропавл'),
    ('Актау',        'Ақтау'),
    ('Темиртау',     'Теміртау'),
    ('Туркестан',    'Түркістан'),
    ('Кокшетау',     'Көкшетау'),
    ('Талдыкорган',  'Талдықорған'),
    ('Экибастуз',    'Екібастұз'),
    ('Рудный',       'Рудный'),
    ('Жезказган',    'Жезқазған'),
    ('Балхаш',       'Балқаш'),
    ('Кентау',       'Кентау'),
    ('Жанаозен',     'Жаңаөзен'),
    ('Сатпаев',      'Сәтбаев'),
    ('Риддер',       'Риддер'),
    ('Степногорск',  'Степногорск'),
    ('Щучинск',      'Щучинск'),
    ('Шу',           'Шу'),
    ('Каскелен',     'Қаскелең'),
    ('Капшагай (Қонаев)', 'Қонаев'),
    ('Сарыагаш',     'Сарыағаш'),
    ('Жаркент',      'Жаркент'),
    ('Аягоз',        'Аягөз'),
    ('Байконур',     'Байқоңыр'),
]

MATERIAL_CATEGORIES = [
    # code, name_ru, name_kz, icon (MaterialCommunityIcons), sort_order
    ('mixes',       'Цемент и сухие смеси',        'Цемент және құрғақ қоспалар',    'sack',                  1),
    ('bricks',      'Кирпич и блоки',              'Кірпіш және блоктар',            'wall',                  2),
    ('lumber',      'Пиломатериалы',               'Ағаш материалдары',              'pine-tree',             3),
    ('roofing',     'Кровля и фасад',              'Шатыр және қасбет',              'home-roof',             4),
    ('plumbing',    'Сантехника',                  'Сантехника',                     'water-pump',            5),
    ('electrical',  'Электрика',                   'Электр жабдықтары',              'flash',                 6),
    ('flooring',    'Плитка и напольные покрытия', 'Плитка және еден жабындары',     'floor-plan',            7),
    ('paints',      'Краски и отделка',            'Бояулар және әрлеу',             'format-paint',          8),
    ('tools',       'Инструмент',                  'Құрал-саймандар',                'hammer-wrench',         9),
]

SERVICE_CATEGORIES = [
    ('turnkey',     'Ремонт под ключ',             'Кілтке дейін жөндеу',            'home-city',            11),
    ('finishing',   'Отделочные работы',           'Әрлеу жұмыстары',                'roller-brush',         12),
    ('electrician', 'Электрики',                   'Электриктер',                    'lightning-bolt',       13),
    ('plumber',     'Сантехники',                  'Сантехниктер',                   'pipe-wrench',          14),
    ('tiler',       'Плиточники',                  'Плитка қалаушылар',              'grid',                 15),
    ('roofer',      'Кровельщики',                 'Шатыр шеберлері',                'home-roof',            16),
    ('facade',      'Фасадные работы',             'Қасбет жұмыстары',               'office-building',      17),
    ('demolition',  'Демонтаж',                    'Бөлшектеу',                      'hammer',               18),
    ('machinery',   'Доставка и спецтехника',      'Жеткізу және арнайы техника',    'dump-truck',           19),
]

CATEGORIES = (
    [(c, 'material', ru, kz, icon, order) for c, ru, kz, icon, order in MATERIAL_CATEGORIES]
    + [(c, 'service', ru, kz, icon, order) for c, ru, kz, icon, order in SERVICE_CATEGORIES]
)

# Признаки объявления — одинаковые внутри вида категории:
# (attr_code, name_ru, name_kz, icon, sort_order).
MATERIAL_ATTRS = [
    ('delivery',    'Доставка',           'Жеткізу',             'truck-delivery',  1),
    ('pickup',      'Самовывоз',          'Өзі алып кету',       'store',           2),
    ('cashless',    'Безналичный расчёт', 'Қолма-қолсыз есеп',   'credit-card',     3),
    ('installment', 'Рассрочка',          'Бөліп төлеу',         'calendar-clock',  4),
    ('wholesale',   'Опт',                'Көтерме сауда',       'package-variant', 5),
]

SERVICE_ATTRS = [
    ('contract',     'Работа по договору',   'Шарт бойынша жұмыс',  'file-sign',        1),
    ('warranty',     'Гарантия на работы',   'Жұмысқа кепілдік',    'shield-check',     2),
    ('own_material', 'Со своим материалом',  'Өз материалымен',     'package-variant',  3),
    ('free_measure', 'Бесплатный замер',     'Тегін өлшеу',         'tape-measure',     4),
    ('estimate',     'Составим смету',       'Смета жасаймыз',      'calculator',       5),
]

PROVIDER_ATTR_TYPES = (
    [(c[0], *a) for c in MATERIAL_CATEGORIES for a in MATERIAL_ATTRS]
    + [(c[0], *a) for c in SERVICE_CATEGORIES for a in SERVICE_ATTRS]
)


async def seed_cities():
    rows = await query_db("SELECT COUNT(*)::int AS n FROM cities")
    if rows and rows[0]['n'] >= len(CITIES):
        return
    for name_ru, name_kz in CITIES:
        await query_db(f"""
            INSERT INTO cities (name_ru, name_kz)
            SELECT {fit_to_sql(name_ru)}, {fit_to_sql(name_kz)}
            WHERE NOT EXISTS (SELECT 1 FROM cities WHERE name_ru = {fit_to_sql(name_ru)})
        """)
    print(f"[{get_timestamp_now()}] 🌱 Cities seeded")


async def seed_categories():
    for code, kind, ru, kz, icon, order in CATEGORIES:
        await query_db(f"""
            INSERT INTO categories (code, kind, name_ru, name_kz, icon, sort_order)
            VALUES ({fit_to_sql(code)}, {fit_to_sql(kind)}, {fit_to_sql(ru)}, {fit_to_sql(kz)},
                    {fit_to_sql(icon)}, {fit_to_sql(order)})
            ON CONFLICT (code) DO NOTHING
        """)
    print(f"[{get_timestamp_now()}] 🌱 Categories seeded")


async def seed_provider_attr_types():
    for cat_code, code, ru, kz, icon, order in PROVIDER_ATTR_TYPES:
        await query_db(f"""
            INSERT INTO provider_attr_types
                (category_id, code, name_ru, name_kz, icon, sort_order)
            SELECT c.id, {fit_to_sql(code)}, {fit_to_sql(ru)}, {fit_to_sql(kz)},
                   {fit_to_sql(icon)}, {fit_to_sql(order)}
            FROM categories c
            WHERE c.code = {fit_to_sql(cat_code)}
              AND NOT EXISTS (
                  SELECT 1 FROM provider_attr_types pat
                  WHERE pat.category_id = c.id
                    AND pat.code = {fit_to_sql(code)}
              )
        """)
    print(f"[{get_timestamp_now()}] 🌱 Provider attribute types seeded")


async def seed_all():
    await seed_cities()
    await seed_categories()
    await seed_provider_attr_types()
