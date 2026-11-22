import { useTranslation } from 'react-i18next';

import type { AppLanguage } from '@/i18n';

/**
 * Текущий язык интерфейса.
 *
 * Берётся из i18n, а не из профиля: гость тоже может переключить язык, и
 * названия городов и категорий должны смениться вместе с остальным текстом.
 * Раньше язык справочников читали из user.language, и гостю, выбравшему
 * казахский, города показывались по-русски.
 */
export function useLang(): AppLanguage {
  const { i18n } = useTranslation();
  return i18n.language === 'kz' ? 'kz' : 'ru';
}
