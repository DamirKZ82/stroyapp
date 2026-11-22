import { useTranslation } from 'react-i18next';

import type { HallCardData } from '@/api/types';
import { capacityLabel } from '@/utils/capacity';
import { formatPrice } from '@/utils/format';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { ListingCard } from './ListingCard';

interface HallCardProps {
  item: HallCardData;
  onPress: () => void;
  onToggleFavorite?: () => void;
  isFavorite?: boolean;
  /**
   * Показывать ли плашку «Занято / Есть места». Без даты сервер всё равно
   * присылает is_busy_on_date: false, и карточка сама не отличит «свободен
   * в этот день» от «дату не спрашивали» — это знает только экран поиска:
   * showAvailability={!!date}.
   */
  showAvailability?: boolean;
}

/** Карточка зала в поиске и избранном. */
export function HallCard({
  item,
  onPress,
  onToggleFavorite,
  isFavorite,
  showAvailability = true,
}: HallCardProps) {
  const { t } = useTranslation();
  const lang = useLang();

  // Избранное приходит без цены на дату и без занятости (там нет даты),
  // хотя по типу поля обязательны. Берём будничную цену как «от» — так же
  // считает сервер в поиске без даты; раньше в избранном стоял прочерк.
  const dated = item.price_on_date != null;
  const price = dated ? item.price_on_date : item.hall.price_weekday;
  const estimate = dated ? item.price_is_estimate : true;

  const busy = item.is_busy_on_date;
  const badge =
    showAvailability && typeof busy === 'boolean'
      ? { busy, label: busy ? t('search.busy_badge') : t('search.free_badge') }
      : null;

  const priceHint = [
    estimate ? t('hall.from_per_evening') : t('hall.per_evening'),
    capacityLabel(t, item.hall.capacity_min, item.hall.capacity_max),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <ListingCard
      photo={item.main_photo}
      thumb={item.main_thumb}
      title={item.hall.name}
      subtitle={`${item.venue.name} · ${dictName(item.city, lang)}`}
      rating={item.rating}
      badge={badge}
      price={formatPrice(price)}
      priceHint={priceHint}
      onPress={onPress}
      onToggleFavorite={onToggleFavorite}
      isFavorite={isFavorite}
    />
  );
}
