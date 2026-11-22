/**
 * Координаты в формах владельца (заведение, исполнитель): разбор поля и
 * вставка пары из карт. Лежит отдельно, чтобы правка разбора не делалась в
 * двух формах, из которых одну забывают.
 */

/**
 * Пара «43.238949, 76.889709» — так координаты копируются из 2GIS и других
 * карт. Точка в обеих частях обязательна: иначе широту с десятичной запятой
 * («43,238949») приняли бы за пару из двух целых.
 */
const COORD_PAIR = /^\s*(-?\d+\.\d+)\s*[,;\s]\s*(-?\d+\.\d+)\s*$/;

/**
 * Разбор координаты из поля: null — поле пустое, undefined — введено не
 * число или число вне диапазона.
 */
export function parseCoord(raw: string, max: number): number | null | undefined {
  const value = raw.trim().replace(',', '.');
  if (!value) return null;
  // Number, а не parseFloat: тот молча взял бы «43.2» из «43.2.5», и в базу
  // ушла бы не та точка, что набрал владелец.
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= max ? parsed : undefined;
}

/**
 * Новый текст одного из полей координат. Если вставили пару целиком —
 * возвращает её разложенной по обоим полям, иначе — тот же текст без
 * посторонних символов, для одного этого поля.
 */
export function splitCoordPaste(previous: string, raw: string): { lat: string; lng: string } | string {
  // Вставку отличаем от набора по скачку длины. При наборе пару не ловим:
  // «43.238949,76.8» совпало бы с ней на полуслове, и остаток долготы
  // человек дописал бы уже в широту.
  const pair = Math.abs(raw.length - previous.length) > 1 ? COORD_PAIR.exec(raw) : null;
  if (pair) return { lat: pair[1], lng: pair[2] };
  return raw.replace(/[^0-9.,\-]/g, '');
}
