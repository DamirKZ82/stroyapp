import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import type { TFunction } from 'i18next';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';

import { text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';

// Number: среднее сервер считает в SQL и может прислать строкой.
const formatAvg = (avg: number | string) => Number(avg).toFixed(1);

/**
 * Рейтинг словами для диктора: без слова «отзывы» он прочёл бы «4,8» и «(12)»
 * как два непонятных числа.
 */
export function ratingLabel(t: TFunction, avg: number | string, count: number): string {
  return `${t('listing.reviews')}: ${formatAvg(avg)} (${count})`;
}

interface RatingInlineProps {
  avg: number | string;
  count: number;
  /** Место строки в родителе: в ряду с названием — flexShrink: 0, в колонке — alignSelf. */
  style?: StyleProp<ViewStyle>;
  /**
   * false — внутри нажимаемой карточки, у которой своя подпись с рейтингом:
   * отдельный элемент стал бы на Android лишней остановкой диктора внутри
   * кнопки.
   */
  accessible?: boolean;
}

/** Звезда, средняя оценка и число отзывов в одну строку. */
export function RatingInline({ avg, count, style, accessible = true }: RatingInlineProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View
      style={[styles.row, style]}
      // Одним элементом: иначе диктор читает оценку и число по отдельности.
      accessible={accessible}
      accessibilityLabel={accessible ? ratingLabel(t, avg, count) : undefined}
    >
      <Icon name="star" size={16} color={colors.accent} />
      <Text style={styles.value}>{formatAvg(avg)}</Text>
      <Text style={styles.count}>{`(${count})`}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    value: { fontSize: text.caption, fontWeight: '600', color: colors.text },
    count: { fontSize: text.caption, color: colors.muted },
  });
