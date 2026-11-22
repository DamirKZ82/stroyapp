/**
 * Числовые поля форм. Значение поля — всегда строка: человек может стереть
 * всё, и пустое поле — не ноль.
 */

/**
 * Только цифры и не длиннее max. Цифровая клавиатура сама от лишнего не
 * спасает: текст с пробелами и буквами в поле можно вставить.
 */
export const onlyDigits = (value: string, max: number): string =>
  value.replace(/\D/g, '').slice(0, max);

/** Целое из поля; null — поле пустое. */
export const intOrNull = (value: string): number | null => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
};
