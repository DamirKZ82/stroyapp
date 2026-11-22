import type { ListingKind } from '@/api/types';

/**
 * Вид объявления по категории: магазин стройматериалов или бригада.
 * Иконки и подписи вида — в одном месте, чтобы поиск, мои объявления и
 * форма говорили одинаково.
 */
export const KIND_KEY: Record<ListingKind, string> = {
  material: 'kind.material',
  service: 'kind.service',
};

export const KIND_ICON: Record<ListingKind, 'storefront-outline' | 'account-hard-hat'> = {
  material: 'storefront-outline',
  service: 'account-hard-hat',
};

export const KINDS: ListingKind[] = ['material', 'service'];
