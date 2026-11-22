import { useTranslation } from 'react-i18next';

import type { City } from '@/api/types';
import { formatDateHuman } from '@/utils/format';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { ChipRow, TouchChip } from './Chip';

export interface FiltersBarValue {
  city: City | null;
  /** YYYY-MM-DD. */
  date: string | null;
  guests: number | null;
  priceMax: number | null;
  amenityCount: number;
}

interface FiltersBarProps {
  value: FiltersBarValue;
  onCityPress: () => void;
  onDatePress: () => void;
  onGuestsPress: () => void;
  onExtraFilters: () => void;
  /**
   * Показывать ли чип «Гости». У исполнителей такого фильтра нет: чип
   * открывал шторку, а введённое число никуда не шло.
   */
  showGuests?: boolean;
}

/**
 * maxWidth — чтобы длинное название города обрезалось многоточием, а не
 * выталкивало остальные фильтры за экран: в прокрутке чип ничем не сжат.
 */
const CHIP_MAX_WIDTH = 240;

/**
 * Ряд фильтров поиска: город, дата, гости и «остальное».
 *
 * Сам ничего не выбирает — по нажатию экран открывает свою шторку. Чип
 * залит, когда фильтр задан, так что сброшенный поиск виден с одного
 * взгляда.
 *
 * Как и ряд категорий, идёт от края до края экрана: отступ страницы уже
 * внутри прокрутки. Выход за отступ страницы делает обёртка экрана, поэтому
 * у ChipRow он выключен — иначе ряд вылез бы за экран вдвое. Отступы сверху
 * и снизу задаёт экран.
 */
export function FiltersBar({
  value,
  onCityPress,
  onDatePress,
  onGuestsPress,
  onExtraFilters,
  showGuests = true,
}: FiltersBarProps) {
  const { t } = useTranslation();
  const lang = useLang();

  // Цена считается за один фильтр, удобства — каждое отдельно: число на чипе
  // совпадает с тем, сколько полей человек тронул в шторке.
  const extraCount = value.amenityCount + (value.priceMax ? 1 : 0);

  return (
    <ChipRow bleed={false}>
      <TouchChip
        icon="map-marker"
        label={value.city ? dictName(value.city, lang) : t('filters.city')}
        selected={!!value.city}
        onPress={onCityPress}
        maxWidth={CHIP_MAX_WIDTH}
      />
      <TouchChip
        icon="calendar"
        label={value.date ? formatDateHuman(value.date, lang) : t('filters.date')}
        selected={!!value.date}
        onPress={onDatePress}
        maxWidth={CHIP_MAX_WIDTH}
      />
      {showGuests ? (
        <TouchChip
          icon="account-group-outline"
          label={value.guests ? t('filters.guests_count', { count: value.guests }) : t('filters.guests')}
          selected={!!value.guests}
          onPress={onGuestsPress}
          maxWidth={CHIP_MAX_WIDTH}
        />
      ) : null}
      <TouchChip
        icon="tune-variant"
        label={extraCount > 0 ? t('filters.title_count', { count: extraCount }) : t('filters.title')}
        selected={extraCount > 0}
        onPress={onExtraFilters}
        maxWidth={CHIP_MAX_WIDTH}
      />
    </ChipRow>
  );
}
