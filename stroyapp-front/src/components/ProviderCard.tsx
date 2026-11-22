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
}

/** Карточка магазина или бригады в поиске и избранном. */
export function ProviderCard({ item, onPress, onToggleFavorite, isFavorite }: ProviderCardProps) {
  const { t } = useTranslation();
  const lang = useLang();

  const priceFrom = item.provider.price_from;
  const unit = item.provider.price_unit;
  // «от» стоит в пояснении, а не перед ценой: в казахском оно идёт после
  // числа («50 000 ₸ бастап»), и склеить одну строку на оба языка нельзя.
  const priceHint =
    priceFrom == null
      ? t('provider.price_negotiable')
      : [t('provider.price_from_prefix'), unitLabel(t, unit)].filter(Boolean).join(' · ');

  // Позиции прайса, совпавшие с поиском: ради них человек и искал.
  const extraLines = (item.matched_items ?? []).map((it) =>
    it.price == null
      ? `${it.name} — ${t('provider.price_negotiable')}`
      : `${it.name} — ${formatPrice(it.price)} ${unitLabel(t, it.unit) ?? ''}`.trim(),
  );

  return (
    <ListingCard
      photo={item.main_photo}
      thumb={item.main_thumb}
      title={item.provider.name}
      subtitle={`${dictName(item.category, lang)} · ${dictName(item.city, lang)}`}
      rating={item.rating}
      verified={!!item.provider.verified}
      price={priceFrom == null ? null : formatPrice(priceFrom)}
      priceHint={priceHint}
      extraLines={extraLines}
      onPress={onPress}
      onToggleFavorite={onToggleFavorite}
      isFavorite={isFavorite}
    />
  );
}
