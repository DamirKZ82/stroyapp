/**
 * Единственная категория, у которой объявление двухуровневое (заведение →
 * залы): поиск по ней ищет залы, а при добавлении открывается форма
 * заведения. У остальных категорий — плоский исполнитель.
 */
export const RESTAURANT_CODE = 'restaurant';

/** Категория «заведение с залами», а не исполнитель. */
export function isVenueCategory(cat: { code: string } | null | undefined): boolean {
  return cat?.code === RESTAURANT_CODE;
}
