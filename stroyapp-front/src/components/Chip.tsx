import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { ReactNode } from 'react';

import { radius, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';

/** Сколько чип добирает сверху и снизу через hitSlop: 36 + 6 + 6 = 48. */
const SLOP = 6;

export interface ChipProps {
  label: string;
  /** Выбран: заливка фирменным цветом. */
  selected?: boolean;
  /** Без onPress чип — просто метка (признаки объявления). */
  onPress?: () => void;
  icon?: keyof typeof Icon.glyphMap;
  disabled?: boolean;
}

/** Чип-таблетка: фильтр, вариант выбора или метка. */
export function Chip({ label, selected = false, onPress, icon, disabled }: ChipProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const tint = selected ? colors.onPrimary : onPress ? colors.text : colors.muted;
  // Значок — украшение, смысл несёт подпись. Подпись нажимаемого чипа обе
  // системы собирают из детей, и символ шрифта иконки прочёлся бы в ней
  // непонятным знаком. Именно accessibilityElementsHidden: сборщик подписи на
  // iOS пропускает только его, accessible={false} там не помогает.
  const body = (
    <>
      {icon ? (
        <Icon
          name={icon}
          size={16}
          color={tint}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : null}
      <Text style={[styles.label, { color: tint }, selected && styles.labelSelected]} numberOfLines={1}>
        {label}
      </Text>
    </>
  );

  // Рамка outline — только у нажимаемого чипа: это элемент управления, и
  // граница нужна ему с контрастом 3:1. Метке хватает бледной: и требования
  // к ней нет, и по рамке видно, что её не нажимают.
  if (!onPress) return <View style={[styles.chip, styles.static]}>{body}</View>;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      // Чип ниже 44, а попадать в него надо пальцем: добираем зону нажатия.
      // За границы родителя hitSlop не выходит, поэтому в ChipWrap под него
      // оставлен запас, а в ряд в одну строку ставят TouchChip.
      hitSlop={{ top: SLOP, bottom: SLOP }}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.selected,
        (pressed || disabled) && styles.dim,
      ]}
    >
      {body}
    </Pressable>
  );
}

/** Чипы в несколько строк с переносом. */
export function ChipWrap({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[wrapStyles.wrap, style]}>{children}</View>;
}

interface TouchChipProps extends ChipProps {
  onPress: () => void;
  /** Предел ширины: длинная подпись обрежется многоточием, а не вытолкнет соседей. */
  maxWidth?: number;
}

/**
 * Нажимаемый чип для ряда в одну строку (ChipRow): на вид те же 36, зона
 * нажатия — 44.
 *
 * Ряд по высоте равен чипу, и hitSlop в нём обрезается. Недостающие полоски
 * сверху и снизу ловит обёртка с тем же действием.
 */
export function TouchChip({ onPress, maxWidth, ...chip }: TouchChipProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={chip.disabled}
      // Для экранного диктора кнопка одна — сам чип, обёртка только ловит палец.
      accessible={false}
      importantForAccessibility="no"
      style={[rowStyles.target, maxWidth != null && { maxWidth }]}
    >
      <Chip {...chip} onPress={onPress} />
    </Pressable>
  );
}

interface ChipRowProps {
  children: ReactNode;
  /**
   * Ряд выходит за отступ страницы и идёт от края до края экрана — так он
   * стоит в заголовке списка с LIST_CONTENT. Выключить, если родитель уже
   * во всю ширину экрана.
   */
  bleed?: boolean;
}

/** Чипы в одну строку с прокруткой вбок: фильтры над списком. Внутрь — TouchChip. */
export function ChipRow({ children, bleed = true }: ChipRowProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // Над рядом бывает поле поиска: иначе первое нажатие на чип только
      // закрыло бы клавиатуру.
      keyboardShouldPersistTaps="handled"
      style={[rowStyles.row, bleed && rowStyles.bleed]}
      contentContainerStyle={rowStyles.content}
    >
      {children}
    </ScrollView>
  );
}

// Цветов тут нет — все они внутри Chip, поэтому стили обычные, не от темы.
const wrapStyles = StyleSheet.create({
  // Поле и отрицательный отступ гасят друг друга: чипы стоят там же, но
  // границы обёртки шире на hitSlop. Без этого у верхней и нижней строки он
  // обрезался бы по краю обёртки, и зона нажатия была бы 36–42 вместо 48.
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingVertical: SLOP,
    marginVertical: -SLOP,
  },
});

const rowStyles = StyleSheet.create({
  // Горизонтальная прокрутка в колонке иначе тянется вниз на весь экран.
  row: { flexGrow: 0 },
  // Отступ страницы перенесён внутрь прокрутки: иначе чипы обрезались бы
  // на расстоянии отступа от края экрана.
  bleed: { marginHorizontal: -space.page },
  content: { paddingHorizontal: space.page, gap: 8, alignItems: 'center' },
  target: { minHeight: 44, justifyContent: 'center' },
});

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: 36,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: radius.pill,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.outline,
    },
    static: { borderColor: colors.border },
    selected: { backgroundColor: colors.primary, borderColor: colors.primary },
    dim: { opacity: 0.6 },
    label: { fontSize: text.caption, fontWeight: '500', flexShrink: 1 },
    labelSelected: { fontWeight: '600' },
  });
