import { useTranslation } from 'react-i18next';

import type { ProviderCardData } from '@/api/types';
import { formatPrice } from '@/utils/format';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { unitLabel } from '@/utils/priceUnit';
import { ListingCard } from './ListingCard';

interface ProviderCardProps {
  item: ProviderCardData;
  onPress: () => void;
  onToggleFavorite?: () => void;
  isFavorite?: boolean;
  /**
   * Показывать ли плашку «Занято / Свободен». Без даты сервер всё равно
   * присылает is_busy_on_date: false, и отличить «свободен в этот день» от
   * «дату не спрашивали» может только экран поиска: showAvailability={!!date}.
   */
  showAvailability?: boolean;
}

/** Карточка исполнителя (ведущий, фотограф, …) в поиске и избранном. */
export function ProviderCard({
  item,
  onPress,
  onToggleFavorite,
  isFavorite,
  showAvailability = true,
}: ProviderCardProps) {
  const { t } = useTranslation();
  const lang = useLang();

  // В избранном занятости нет вовсе (там нет даты) — плашку не рисуем.
  const busy = item.is_busy_on_date;
  const badge =
    showAvailability && typeof busy === 'boolean'
      ? { busy, label: busy ? t('search.busy_badge') : t('provider.free_badge') }
      : null;

  const priceFrom = item.provider.price_from;
  const unit = item.provider.price_unit;
  // «от» стоит в пояснении, а не перед ценой: в казахском оно идёт после
  // числа («50 000 ₸ бастап»), и склеить одну строку на оба языка нельзя.
  const priceHint =
    priceFrom == null
      ? t('provider.price_negotiable')
      : [t('provider.price_from_prefix'), unitLabel(t, unit)]
          .filter(Boolean)
          .join(' · ');

  return (
    <ListingCard
      photo={item.main_photo}
      thumb={item.main_thumb}
      title={item.provider.name}
      subtitle={`${dictName(item.category, lang)} · ${dictName(item.city, lang)}`}
      rating={item.rating}
      badge={badge}
      price={priceFrom == null ? null : formatPrice(priceFrom)}
      priceHint={priceHint}
      onPress={onPress}
      onToggleFavorite={onToggleFavorite}
      isFavorite={isFavorite}
    />
  );
}
