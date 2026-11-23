"""
Веб-кабинет продавца: /cabinet.

Страница и два её файла (static/cabinet.*). Данные кабинет берёт из того же
API, что и приложение, с тем же токеном: вход по номеру и коду из SMS,
заявки, переписка, прайс и тариф. Своих эндпоинтов у кабинета нет —
правила (кто что видит, блокировки, лимиты прайса) остаются в одном месте.

Оплата тарифа картой идёт отсюда, а не из приложения: так покупка
подписки не попадает под правила встроенных покупок App Store.
"""
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, RedirectResponse


router = APIRouter(prefix='/cabinet')

_STATIC_DIR = Path(__file__).resolve().parent.parent / 'static'

_PAGE_FILES = {
    'cabinet.css': 'text/css; charset=utf-8',
    'cabinet.js': 'text/javascript; charset=utf-8',
}

# Как у админки: скрипты, стили и данные — только со своего сервера. Фото
# объявлений лежат в /uploads того же адреса. form-action 'self' — на
# случай, если браузер отправит форму входа сам, без скрипта.
_CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")


def _page_file(name: str, media_type: str) -> FileResponse:
    path = _STATIC_DIR / name
    if not path.exists():
        raise HTTPException(status_code=404, detail='Not found')
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            # Новая версия после выкладки открывается сразу.
            'Cache-Control': 'no-store',
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'same-origin',
            'Content-Security-Policy': _CSP,
        },
    )


@router.get('', include_in_schema=False)
async def cabinet_page():
    return _page_file('cabinet.html', 'text/html; charset=utf-8')


@router.get('/', include_in_schema=False)
async def cabinet_slash():
    return RedirectResponse('/cabinet', status_code=308)


@router.get('/{name}', include_in_schema=False)
async def cabinet_file(name: str):
    if name not in _PAGE_FILES:
        raise HTTPException(status_code=404, detail='Not found')
    return _page_file(name, _PAGE_FILES[name])
