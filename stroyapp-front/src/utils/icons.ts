import { MaterialCommunityIcons } from '@expo/vector-icons';

export type MdiName = keyof typeof MaterialCommunityIcons.glyphMap;

/**
 * Имя иконки приходит с сервера строкой, и набор MDI в приложении может
 * оказаться старше, чем у того, кто заводил категорию. Незнакомое имя
 * рисуется знаком вопроса, поэтому сверяемся с набором сами.
 * hasOwnProperty, а не `in`: иначе «constructor» сошёл бы за иконку.
 */
export function mdiOrFallback(
  name: string | null | undefined,
  fallback: MdiName = 'shape-outline',
): MdiName {
  return name && Object.prototype.hasOwnProperty.call(MaterialCommunityIcons.glyphMap, name)
    ? (name as MdiName)
    : fallback;
}
