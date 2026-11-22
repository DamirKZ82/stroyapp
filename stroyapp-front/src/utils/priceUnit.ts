import type { TFunction } from 'i18next';

import type { PriceUnit } from '@/api/types';

/**
 * Единица цены исполнителя («за час», «за персону») — одна на карточку в
 * поиске, карточку исполнителя, список и форму владельца.
 *
 * Ключи выписаны целиком, а не склеены из `unit_${unit}`: так их находит
 * поиск по проекту, а новая единица без перевода не соберётся — вместо того
 * чтобы молча показать на экране сам ключ.
 */
export const UNIT_KEY: Record<PriceUnit, string> = {
  event: 'provider.unit_event',
  hour: 'provider.unit_hour',
  person: 'provider.unit_person',
  day: 'provider.unit_day',
};

/** Подпись единицы цены; null — единица не задана. */
export function unitLabel(t: TFunction, unit: PriceUnit | null | undefined): string | null {
  return unit ? t(UNIT_KEY[unit]) : null;
}
