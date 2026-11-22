import { API_BASE_URL } from '@/config';

/**
 * Полный адрес фото. Сервер отдаёт путь от корня (`/uploads/halls/1/x.jpg`);
 * пустой путь даёт null — картинку тогда не рисуем, а показываем заглушку.
 */
export function photoUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
}
