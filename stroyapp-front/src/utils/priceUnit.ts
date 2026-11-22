import type { TFunction } from 'i18next';

import type { PriceUnit } from '@/api/types';

/**
 * Единица измерения прайса: «м²», «мешок», «рейс». Одна на карточку в
 * поиске, прайс объявления и форму владельца.
 *
 * Ключи выписаны целиком, а не склеены из `units.${unit}`: так их находит
 * поиск по проекту, а новая единица без перевода не соберётся — вместо того
 * чтобы молча показать на экране сам ключ.
 */
export const UNIT_KEY: Record<PriceUnit, string> = {
  piece: 'units.piece',
  m2: 'units.m2',
  m3: 'units.m3',
  m: 'units.m',
  kg: 'units.kg',
  ton: 'units.ton',
  bag: 'units.bag',
  pack: 'units.pack',
  roll: 'units.roll',
  sheet: 'units.sheet',
  liter: 'units.liter',
  hour: 'units.hour',
  day: 'units.day',
  trip: 'units.trip',
  object: 'units.object',
  work: 'units.work',
};

/** Порядок единиц в выборе: материалы сначала, работы потом. */
export const UNITS: PriceUnit[] = Object.keys(UNIT_KEY) as PriceUnit[];

/** Короткое название единицы: «м²». null — единица не задана. */
export function unitName(t: TFunction, unit: PriceUnit | null | undefined): string | null {
  return unit ? t(UNIT_KEY[unit]) : null;
}

/** Цена «за единицу»: «за м²» / «м² үшін». null — единица не задана. */
export function unitLabel(t: TFunction, unit: PriceUnit | null | undefined): string | null {
  return unit ? t('units.per', { unit: t(UNIT_KEY[unit]) }) : null;
}
