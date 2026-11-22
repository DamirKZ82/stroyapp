import { Pressable, StyleSheet, Text, View } from 'react-native';

import { HIT, radius, text, type ThemeColors } from '@/theme';
import { useThemedStyles } from '@/theme/scheme';

interface SegmentProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

/**
 * Переключатель из двух–четырёх вариантов в одну строку: язык, тема,
 * единица цены. Нарисован сам, а не системный: у системного на Android
 * нет ни своей формы, ни подписей в две строки.
 */
export function Segment<T extends string>({ value, options, onChange, disabled }: SegmentProps<T>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.segment, disabled && styles.dim]} accessibilityRole="tablist">
      {options.map((option, index) => {
        const chosen = option.value === value;
        // Подписи из нескольких слов («за мероприятие») при крупном системном
        // шрифте переносим на вторую строку, а не режем многоточием. Одному
        // слову вторую строку не даём: его разорвало бы посреди, и лучше
        // пусть оно, как раньше, уменьшится.
        const lines = option.label.trim().includes(' ') ? 2 : 1;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            disabled={disabled}
            accessibilityRole="tab"
            accessibilityState={{ selected: chosen }}
            style={[styles.item, index > 0 && styles.divided, chosen && styles.chosen]}
          >
            <Text
              style={[styles.label, chosen && styles.labelChosen]}
              numberOfLines={lines}
              adjustsFontSizeToFit
              // Нижний предел действует только на iOS: Android читает лишь
              // minimumFontSize, а его <Text> в RN 0.86 не передаёт, — там
              // подпись уменьшается, пока не влезет целиком, без многоточия.
              minimumFontScale={0.8}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    segment: {
      flexDirection: 'row',
      borderWidth: 1,
      borderColor: colors.outline,
      borderRadius: radius.inner,
      backgroundColor: colors.card,
      overflow: 'hidden',
    },
    item: {
      flex: 1,
      minHeight: HIT,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 6,
      // Чтобы подпись в две строки не липла к краям: высота тут minHeight.
      paddingVertical: 4,
    },
    // Внутри — бледный волосяной разделитель: границу элемента уже даёт
    // рамка outline, а тёмные перегородки делили бы его на отдельные кнопки.
    divided: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
    chosen: { backgroundColor: colors.primary },
    dim: { opacity: 0.5 },
    // textAlign — для подписи в две строки: alignItems ровняет только блок.
    label: { fontSize: text.caption, color: colors.text, textAlign: 'center' },
    labelChosen: { color: colors.onPrimary, fontWeight: '600' },
  });
