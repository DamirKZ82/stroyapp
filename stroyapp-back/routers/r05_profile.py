"""
Профиль текущего пользователя:

    GET    /profile          -> {user}
    PATCH  /profile          { full_name?, language? } -> {user}
    POST   /profile/terms    { version? } -> {user}   принять Условия использования
    DELETE /profile          -> {deleted: true}   удалить аккаунт и все данные
"""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator

from connections.connect_postgres import query_db
from handlers.h01_errors import WarnException
from handlers.h03_auth import auth_user
from libs.common import fit_to_sql
from libs.date import get_timestamp_now
from libs.text_filter import Clean
from services.account import purge_users
from services.terms import TERMS_VERSION, accept as accept_terms, user_public


router = APIRouter(prefix='/profile')


class ProfilePatchBody(BaseModel):
    full_name: Optional[Clean] = None
    language: Optional[str] = None

    @field_validator('full_name')
    @classmethod
    def full_name_valid(cls, val):
        if val is None:
            return None
        val = val.strip()
        if not val:
            raise ValueError('ФИО не может быть пустым')
        if len(val) > 200:
            raise ValueError('ФИО не должно быть длиннее 200 символов')
        return val

    @field_validator('language')
    @classmethod
    def language_valid(cls, val):
        if val is None:
            return None
        val = val.strip().lower()
        if val not in ('ru', 'kz'):
            raise ValueError("Язык должен быть 'ru' или 'kz'")
        return val


@router.get('')
async def get_profile(user=Depends(auth_user)):
    return {'user': await user_public(user)}


@router.patch('')
async def patch_profile(body: ProfilePatchBody, user=Depends(auth_user)):
    # Собираем набор полей для обновления
    updates = []
    if body.full_name is not None:
        updates.append(f"full_name = {fit_to_sql(body.full_name)}")
    if body.language is not None:
        updates.append(f"language = {fit_to_sql(body.language)}")

    if not updates:
        raise WarnException(400, 'Нет полей для обновления')

    updates.append(f"updated_at = {fit_to_sql(get_timestamp_now())}")
    set_clause = ', '.join(updates)

    rows = await query_db(f"""
        UPDATE users
           SET {set_clause}
         WHERE id = {fit_to_sql(user['id'])}
        RETURNING id, guid, phone, full_name, language
    """)
    return {'user': await user_public(rows[0])}


class TermsBody(BaseModel):
    version: Optional[str] = None


@router.post('/terms')
async def accept_terms_now(body: Optional[TermsBody] = None, user=Depends(auth_user)):
    """
    Человек нажал «Принимаю» под Условиями использования. Принимается
    действующая версия. version — версия, которую приложение показало
    человеку (пришла ему в terms_version): если с тех пор условия сменились,
    записывать согласие с новыми нельзя — он их не видел. Без version
    запрос принимает действующую как есть. Повторный вызов ничего не меняет.
    """
    if body is not None and body.version is not None and body.version != TERMS_VERSION:
        raise WarnException(409, 'Условия использования обновились. Откройте их ещё раз и подтвердите согласие.')
    await accept_terms(user['id'])
    return {'user': await user_public(user)}


@router.delete('')
async def delete_profile(user=Depends(auth_user)):
    """
    Удалить свой аккаунт: объявления с фото, заявки, чаты, отзывы, избранное
    и саму запись пользователя. Вернуть нельзя — приложение спрашивает
    подтверждение до вызова.

    Служебный аккаунт (тестовый вход для ревью сторов) чистится от данных,
    но остаётся: иначе первый же проверяющий, нажав «Удалить аккаунт»,
    оставил бы следующего без входа.
    """
    rows = await query_db(f"SELECT is_service FROM users WHERE id = {fit_to_sql(user['id'])}")
    is_service = bool(rows and rows[0]['is_service'])
    await purge_users([user['id']], keep_login=is_service)
    return {'deleted': True}
