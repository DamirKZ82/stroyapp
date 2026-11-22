import type { TFunction } from 'i18next';

/**
 * Вместимость зала одной фразой — общая для карточки в поиске, карточки зала
 * и списка залов владельца: один и тот же зал не должен читаться по-разному.
 *
 * Владелец может заполнить только одну границу или ни одной — раньше на
 * месте пустой печатался знак вопроса: «?–300 гостей».
 */
export function capacityLabel(t: TFunction, min: number | null, max: number | null): string | null {
  if (min != null && max != null) {
    return min === max ? t('filters.guests_count', { count: max }) : t('hall.capacity', { min, max });
  }
  if (max != null) return t('hall.capacity_up_to', { max });
  if (min != null) return t('hall.capacity_from', { min });
  return null;
}
