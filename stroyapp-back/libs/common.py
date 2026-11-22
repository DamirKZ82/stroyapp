"""
Общие утилиты.
"""
import uuid


def fit_to_sql(value) -> str:
    """
    Подготовка значения для инлайн-вставки в SQL через f-string.

    Правила:
        None       -> 'null'
        bool       -> 'true' / 'false'
        int/float  -> строковое представление числа
        str        -> строка в одинарных кавычках с экранированием апострофов,
                      без нулевого байта и «половинок» суррогатных пар
        list/tuple -> 'ARRAY[...]' с рекурсивным fit_to_sql для каждого элемента

    Пример:
        sql = f"INSERT INTO t (a, b, c) VALUES ({fit_to_sql('O\\'Neil')}, {fit_to_sql(None)}, {fit_to_sql(True)})"
        # -> "INSERT INTO t (a, b, c) VALUES ('O''Neil', null, true)"
    """
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (list, tuple)):
        inner = ', '.join(fit_to_sql(item) for item in value)
        return f"ARRAY[{inner}]"
    # Всё остальное приводим к строке и экранируем одинарные кавычки удвоением.
    # clean_text — здесь, в единственном месте, через которое строки попадают
    # в запрос: JSON пропускает и нулевой байт, и «половинку» суррогатной пары,
    # а запрос с ними не просто падает. На «половинке» asyncpg спотыкается ещё
    # при кодировании и не возвращает соединение в пул: десять таких запросов
    # оставляли воркер без соединений, и он переставал отвечать.
    text = clean_text(str(value)).replace("'", "''")
    return f"'{text}'"


def clean_text(value: str) -> str:
    """
    Текст без того, что не дойдёт до базы: нулевого байта и «половинок»
    суррогатных пар. JSON пропускает и то и другое, а запрос с ними падает —
    вместо отказа пользователь получил бы сбой сервера.
    """
    return value.replace('\x00', '').encode('utf-8', 'ignore').decode('utf-8')


def new_guid() -> str:
    """Генерация нового GUID в формате строки CHAR(36)."""
    return str(uuid.uuid4())
