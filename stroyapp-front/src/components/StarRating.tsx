import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { HIT } from '@/theme';
import { useColors } from '@/theme/scheme';

interface StarRatingProps {
  value: number;
  /** Без onChange звёзды только показывают оценку. */
  onChange?: (value: number) => void;
  size?: number;
}

/** Пять звёзд: оценка в отзыве или её выбор. */
export function StarRating({ value, onChange, size = 28 }: StarRatingProps) {
  const { t } = useTranslation();
  const colors = useColors();
  // Зону нажатия даёт отступ внутри самой звезды, а не hitSlop: ряд высотой
  // ровно с иконку, а за границы родителя hitSlop не выходит. Зазор между
  // звёздами тогда не нужен — его заменяют отступы.
  const pad = Math.max(6, (HIT - size) / 2);
  return (
    <View style={onChange ? styles.pickRow : styles.row}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= value;
        const star = (
          <Icon
            name={filled ? 'star' : 'star-outline'}
            size={size}
            color={filled ? colors.accent : colors.muted}
          />
        );
        if (!onChange) return <View key={n}>{star}</View>;
        return (
          <Pressable
            key={n}
            onPress={() => onChange(n)}
            // Выбор одного из пяти: с ролью и отметкой диктор говорит, что
            // это и какая оценка стоит, а не просто «1», «2», «3».
            accessibilityRole="radio"
            accessibilityState={{ checked: n === value }}
            // Словами: косую черту диктор читает как дробь или знак.
            accessibilityLabel={t('review_form.rating_value', { n })}
            style={{ padding: pad }}
          >
            {star}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 2 },
  pickRow: { flexDirection: 'row' },
});
