"""
Мелочи для списков админки: постраничная выдача и поиск по подстроке.
"""
import re

from libs.common import fit_to_sql


# Потолок номера страницы: без него OFFSET от огромного числа не влезает в
# bigint, и вместо отказа «неверный параметр» получается сбой сервера.
MAX_PAGE = 100_000


def limit_offset(page: int, page_size: int) -> str:
    return f'LIMIT {fit_to_sql(page_size)} OFFSET {fit_to_sql((page - 1) * page_size)}'


def like(value: str) -> str:
    """
    Значение для ILIKE: '%текст%' со снятым смыслом у % и _ внутри текста.
    Иначе поиск по «100%» или «a_b» находил бы совсем не то.
    """
    text = value.strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    return fit_to_sql(f'%{text}%')


_PHONE_CHARS = re.compile(r'[\d\s()+\-]+')


def phone_match(column: str, q: str) -> str:
    """
    Условие поиска по номеру телефона. В базе номера лежат как +77011234567,
    а в поиск их вставляют так, как видят: «+7 701 123 45 67» или
    «8 (701) 123-45-67». Поэтому запрос из цифр и знаков номера ищем по одним
    цифрам; всё остальное — как обычную подстроку.
    """
    text = q.strip()
    if _PHONE_CHARS.fullmatch(text):
        digits = re.sub(r'\D', '', text)
        if len(digits) >= 3:
            variants = [digits]
            if digits[0] == '8':
                variants.append('7' + digits[1:])   # «8 701…» — тот же номер, что «+7 701…»
            return '(' + ' OR '.join(f'{column} LIKE {like(v)}' for v in variants) + ')'
    return f'{column} ILIKE {like(q)}'


def paged(items: list, total: int, page: int, page_size: int) -> dict:
    return {'items': items, 'total': total, 'page': page, 'page_size': page_size}


def where_sql(conditions: list) -> str:
    return ' AND '.join(conditions) if conditions else 'true'
