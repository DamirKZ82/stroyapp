import { useTranslation } from 'react-i18next';

import type { City } from '@/api/types';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { ChipRow, TouchChip } from './Chip';

export interface FiltersBarValue {
  city: City | null;
  priceMax: number | null;
  tagCount: number;
}

interface FiltersBarProps {
  value: FiltersBarValue;
  onCityPress: () => void;
  onExtraFilters: () => void;
}

/**
 * maxWidth — чтобы длинное название города обрезалось многоточием, а не
 * выталкивало остальные фильтры за экран: в прокрутке чип ничем не сжат.
 */
const CHIP_MAX_WIDTH = 240;

/**
 * Ряд фильтров поиска: город и «остальное» (цена, условия, сортировка).
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
  onExtraFilters,
}: FiltersBarProps) {
  const { t } = useTranslation();
  const lang = useLang();

  // Цена считается за один фильтр, условия — каждое отдельно: число на чипе
  // совпадает с тем, сколько полей человек тронул в шторке.
  const extraCount = value.tagCount + (value.priceMax ? 1 : 0);

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
        icon="tune-variant"
        label={extraCount > 0 ? t('filters.title_count', { count: extraCount }) : t('filters.title')}
        selected={extraCount > 0}
        onPress={onExtraFilters}
        maxWidth={CHIP_MAX_WIDTH}
      />
    </ChipRow>
  );
}
