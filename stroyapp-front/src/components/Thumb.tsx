import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { FILL, radius, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { photoUrl } from '@/utils/photo';

interface ThumbProps {
  /**
   * Путь превью, как его отдаёт сервер (`main_thumb`, `thumb_path`). Адрес
   * собирает сам Thumb через photoUrl — все места, где он стоит, получают
   * именно путь. Готовый адрес (http…) photoUrl пропускает как есть.
   */
  path?: string | null;
  size: number;
  /** Заглушка, пока фото нет или оно не загрузилось. */
  icon?: keyof typeof Icon.glyphMap;
  iconSize?: number;
}

/**
 * Квадратное превью в строке списка: зал, объявление, чат.
 *
 * Заглушка лежит под фото всегда: её видно, пока фото грузится и если оно
 * не загрузилось, — без своего состояния ошибки.
 *
 * Для диктора превью нет: оно всегда стоит внутри строки со своей подписью,
 * а значок заглушки — символ шрифта, и Android, собирая подпись строки из
 * детей, прочёл бы его как непонятный знак.
 */
export function Thumb({ path, size, icon = 'image-outline', iconSize = 24 }: ThumbProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const uri = photoUrl(path);

  return (
    <View
      style={[styles.thumb, { width: size, height: size }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Icon name={icon} size={iconSize} color={colors.muted} />
      {uri ? <Image source={{ uri }} contentFit="cover" transition={150} style={FILL} /> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    thumb: {
      flexShrink: 0,
      borderRadius: radius.inner,
      // border, а не background: нажатая строка красится в background, и
      // заглушка с ней слилась бы.
      backgroundColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      // Фото обрезается по скруглению.
      overflow: 'hidden',
    },
  });
