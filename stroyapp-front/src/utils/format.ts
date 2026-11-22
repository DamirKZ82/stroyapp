/**
 * Форматирование цены и дат.
 */

/** Цена с пробелами как разделителем тысяч: 350 000 ₸ */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const abs = Math.abs(value);
  const withSpaces = abs.toLocaleString('ru-RU').replace(/,/g, ' ');
  return `${withSpaces} ₸`;
}

const monthsRu = [
  '', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const monthsKz = [
  '', 'қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым',
  'шілде', 'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан',
];

/** '2027-05-15' -> '15 мая 2027' */
export function formatDateHuman(iso: string, lang: 'ru' | 'kz' = 'ru'): string {
  if (!iso || iso.length !== 10) return iso;
  const [y, m, d] = iso.split('-');
  const months = lang === 'kz' ? monthsKz : monthsRu;
  return `${parseInt(d, 10)} ${months[parseInt(m, 10)]} ${y}`;
}

// «Сегодня» по часам телефона здесь нет намеренно: сервер считает даты по
// UTC+5, и у телефона в другом поясе или около полуночи такое «сегодня»
// разрешало бы день, который сервер отклонит. Брать serverToday из
// '@/utils/serverTime'.

/** 'YYYY-MM' из 'YYYY-MM-DD' */
export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}
