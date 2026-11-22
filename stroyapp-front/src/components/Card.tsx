import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { HIT, radius, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';

interface CardProps {
  title?: string;
  hint?: string;
  /** Элемент справа от заголовка: кнопка, переключатель. */
  action?: ReactNode;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Карточка: белый блок на сером фоне. Глубину даёт разница цветов, а не
 * тень — так карточка одинаково читается в светлой и тёмной теме.
 */
export function Card({ title, hint, action, children, style }: CardProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.card, style]}>
      {title || action ? (
        <View style={styles.head}>
          <View style={styles.headText}>
            {title ? (
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
            ) : null}
            {hint ? (
              <Text style={styles.hint} numberOfLines={2}>
                {hint}
              </Text>
            ) : null}
          </View>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** Подпись над карточкой или группой строк: «Описание», «Удобства». */
export function SectionLabel({ children }: { children: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text style={styles.section} accessibilityRole="header">
      {children}
    </Text>
  );
}

/** Строки в одной карточке с волосяными разделителями, как в настройках iOS. */
export function RowGroup({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={[styles.group, style]}>{children}</View>;
}

interface RowProps {
  title: string;
  /** Вторая строка под заголовком. */
  subtitle?: string;
  /** Значение справа: «Астана», «3». */
  value?: string;
  icon?: keyof typeof Icon.glyphMap;
  onPress?: () => void;
  /** Первая строка в группе — без разделителя сверху. */
  first?: boolean;
  danger?: boolean;
  /** Свой элемент справа вместо стрелки: переключатель, галочка. */
  right?: ReactNode;
  /**
   * Что прочтёт экранный диктор. В строке без onPress подпись и значение —
   * отдельные элементы, и читаются они порознь; с этим текстом строка
   * становится одним элементом: «Дата: 12 октября».
   * Не задавать, когда в right стоит то, что нажимают (переключатель):
   * внутри слитой строки диктор до него не доберётся.
   */
  accessibilityLabel?: string;
  /**
   * Роль нажимаемой строки. 'link' — когда строка уводит из приложения
   * (сайт, почта, магазин): диктор предупреждает, что это ссылка.
   */
  accessibilityRole?: 'button' | 'link';
}

/** Строка списка внутри RowGroup. С onPress — нажимаемая, со стрелкой. */
export function Row({
  title,
  subtitle,
  value,
  icon,
  onPress,
  first,
  danger,
  right,
  accessibilityLabel,
  accessibilityRole = 'button',
}: RowProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const tint = danger ? colors.danger : colors.text;
  // Значки строки — украшение: смысл несёт заголовок. Подпись нажимаемой
  // строки без своей accessibilityLabel обе системы собирают из детей, и
  // символ шрифта прочёлся бы в ней непонятным знаком. Именно
  // accessibilityElementsHidden: сборщик подписи на iOS пропускает только
  // его, accessible={false} там не помогает (как в Chip).
  const body = (
    <>
      {icon ? (
        <Icon
          name={icon}
          size={22}
          color={danger ? colors.danger : colors.muted}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : null}
      <View style={styles.rowText}>
        {/* Две строки, а не одна: «Политика конфиденциальности» при крупном
            системном шрифте в одну не помещается, а строка растёт сама. */}
        <Text style={[styles.rowTitle, { color: tint }]} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text style={styles.rowValue} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {right ??
        (onPress ? (
          <Icon
            name="chevron-right"
            size={20}
            color={colors.muted}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        ) : null)}
    </>
  );

  if (!onPress) {
    return (
      <View
        style={[styles.row, !first && styles.rowDivided]}
        accessible={!!accessibilityLabel}
        accessibilityLabel={accessibilityLabel}
      >
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.row, !first && styles.rowDivided, pressed && styles.rowPressed]}
    >
      {body}
    </Pressable>
  );
}

interface SwitchRowProps {
  label: string;
  /** Пояснение второй строкой: что значит включённый переключатель. */
  hint?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  /** Первая строка в группе — без разделителя сверху. */
  first?: boolean;
}

/**
 * Строка «подпись + переключатель» внутри RowGroup.
 *
 * Нажимается вся строка, а не сам Switch: он ниже 44 (31 на iOS, около 27
 * на Android), а hitSlop системный Switch в RN 0.86 не слушает ни там, ни
 * там. Поэтому переключатель только показывает значение и нажатий не
 * ловит — иначе одно касание переключало бы дважды. Для диктора строка и
 * есть переключатель.
 *
 * Отклик — сменой фона, как у Row: строки стоят в одной группе и должны
 * откликаться одинаково.
 */
export function SwitchRow({
  label,
  hint,
  value,
  onValueChange,
  disabled = false,
  first,
}: SwitchRowProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      // Пояснение — в подписи, а не в accessibilityHint: подсказки многие
      // выключают, а без пояснения непонятно, что переключаешь.
      accessibilityLabel={hint ? `${label}, ${hint}` : label}
      accessibilityState={{ checked: value, disabled }}
      style={({ pressed }) => [styles.row, !first && styles.rowDivided, pressed && styles.rowPressed]}
    >
      <View style={styles.rowText}>
        <Text
          style={[styles.rowTitle, { color: disabled ? colors.muted : colors.text }]}
          numberOfLines={2}
        >
          {label}
        </Text>
        {hint ? (
          <Text style={styles.rowSubtitle} numberOfLines={3}>
            {hint}
          </Text>
        ) : null}
      </View>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Switch
          value={value}
          disabled={disabled}
          trackColor={{
            true: colors.primary,
            // На Android выключенная дорожка цвета border на белой карточке
            // почти не видна — там рамка элементов управления, outline. На
            // iOS оставляем системную: она сама подстраивается под тему.
            false: Platform.OS === 'android' ? colors.outline : undefined,
          }}
        />
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.card,
      borderRadius: radius.card,
      padding: space.card,
      gap: space.gap,
    },
    head: { flexDirection: 'row', alignItems: 'center', gap: space.gap },
    headText: { flex: 1, minWidth: 0, gap: 2 },
    title: { fontSize: text.section, fontWeight: '600', color: colors.text },
    hint: { fontSize: text.caption, color: colors.muted },
    section: { fontSize: text.caption, color: colors.muted, paddingHorizontal: 4 },
    group: { backgroundColor: colors.card, borderRadius: radius.card, overflow: 'hidden' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.gap,
      minHeight: HIT,
      paddingHorizontal: space.card,
      paddingVertical: 10,
    },
    rowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    rowPressed: { backgroundColor: colors.background },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    rowTitle: { fontSize: text.body },
    rowSubtitle: { fontSize: text.caption, color: colors.muted },
    rowValue: { fontSize: text.body, color: colors.muted, flexShrink: 0, maxWidth: '45%' },
  });
