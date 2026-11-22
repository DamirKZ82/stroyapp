"""
Публичные юридические страницы: Privacy Policy, Условия использования и
удаление аккаунта.
Открываются без авторизации, отдаются как HTML для Google Play Console
и для показа в мобильном приложении.
"""
import pathlib

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from libs.date import get_timestamp_now
from services.terms import TERMS_VERSION


router = APIRouter()

# static/ лежит рядом с main.py (в контейнере — /app/static/)
_STATIC_DIR = pathlib.Path(__file__).resolve().parent.parent / 'static'


def _check_terms_version() -> None:
    """
    Версия в шапке страницы условий и TERMS_VERSION меняются вместе. Сверяем
    один раз при старте: если они разошлись, в строках согласия записана не
    та версия, которую видит человек, — и это видно в логе сразу после
    выкладки, а не через полгода.
    """
    path = _STATIC_DIR / 'terms.html'
    if path.exists() and f'Версия {TERMS_VERSION} ' not in path.read_text(encoding='utf-8'):
        print(
            f"[{get_timestamp_now()}] ⚠️ static/terms.html: в шапке не «Версия {TERMS_VERSION}» — "
            f"страница условий и TERMS_VERSION в services/terms.py разошлись"
        )


_check_terms_version()


@router.get('/privacy')
async def privacy():
    path = _STATIC_DIR / 'privacy.html'
    if not path.exists():
        raise HTTPException(status_code=404, detail='Privacy policy not found')
    return FileResponse(path, media_type='text/html; charset=utf-8')


@router.get('/terms')
async def terms():
    """
    Условия использования. На эту страницу ведёт шаг согласия при входе в
    приложение; версия текста — services/terms.TERMS_VERSION.
    """
    path = _STATIC_DIR / 'terms.html'
    if not path.exists():
        raise HTTPException(status_code=404, detail='Terms not found')
    # no-cache: браузер сверяется с сервером при каждом открытии. Человек
    # принимает условия, глядя на эту страницу, — прежняя версия из кэша
    # значила бы согласие не с тем текстом.
    return FileResponse(path, media_type='text/html; charset=utf-8', headers={'Cache-Control': 'no-cache'})


@router.get('/account-deletion')
async def account_deletion():
    """Страница «как удалить аккаунт» — её адрес просит Google Play (Data safety)."""
    path = _STATIC_DIR / 'account-deletion.html'
    if not path.exists():
        raise HTTPException(status_code=404, detail='Page not found')
    return FileResponse(path, media_type='text/html; charset=utf-8')
