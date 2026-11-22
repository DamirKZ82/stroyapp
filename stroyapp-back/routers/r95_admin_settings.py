"""
Ключи и настройки интеграций в админке (libs/settings.py).

    GET    /admin/api/settings          список: откуда значение, само значение (секрет — маской)
    PUT    /admin/api/settings/{key}    задать: {value, password}
    DELETE /admin/api/settings/{key}    сбросить к .env: {password}

Любое изменение подтверждается паролем админа: ключ кассы или SMS в чужих
руках — это деньги, а вход в админку мог остаться открытым на чужом
компьютере. В журнал действий пишется, какой ключ поменяли, но не значение.
"""
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, field_validator

from handlers.h01_errors import WarnException
from handlers.h03_auth import auth_admin
from libs.settings import BY_KEY, clear_setting, describe_settings, store_setting, validate
from routers.r94_admin_access import _confirm_by_password, _typed_password
from services.moderation import log_action


router = APIRouter(prefix='/admin/api/settings')


class PasswordOnlyBody(BaseModel):
    password: str

    @field_validator('password')
    @classmethod
    def password_typed(cls, val):
        return _typed_password(val)


class SettingBody(PasswordOnlyBody):
    value: str


def _setting_or_404(key: str):
    setting = BY_KEY.get(key)
    if setting is None:
        raise WarnException(404, 'Такой настройки нет')
    return setting


@router.get('')
async def list_settings(admin=Depends(auth_admin)):
    return {'items': await describe_settings()}


@router.put('/{key}')
async def put_setting(key: str, body: SettingBody, request: Request, admin=Depends(auth_admin)):
    setting = _setting_or_404(key)
    try:
        raw = validate(setting, body.value)
    except ValueError as e:
        raise WarnException(400, str(e))
    await _confirm_by_password(admin, body.password, request)
    await store_setting(key, raw, admin['id'])
    await log_action(admin, 'setting_update', 'setting', None, f'{setting.group}: {setting.label}',
                     None if setting.secret else raw)
    return {'items': await describe_settings()}


@router.delete('/{key}')
async def delete_setting(key: str, body: PasswordOnlyBody, request: Request, admin=Depends(auth_admin)):
    setting = _setting_or_404(key)
    await _confirm_by_password(admin, body.password, request)
    await clear_setting(key)
    await log_action(admin, 'setting_reset', 'setting', None, f'{setting.group}: {setting.label}',
                     'вернулось значение из .env')
    return {'items': await describe_settings()}
