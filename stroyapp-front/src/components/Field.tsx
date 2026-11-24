import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { createContext, forwardRef, useContext, useMemo, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputInstance,
  type TextInputProps,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { HIT, radius, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { useAnnounce } from './Feedback';

interface FieldInfo {
  label?: string;
  error?: string | null;
}

/**
 * Подпись и ошибка Field для поля внутри него.
 *
 * На экране они стоят рядом с полем, но для экранного диктора это отдельные
 * тексты: поле читалось бы без названия и без ошибки. Контекст, а не
 * cloneElement: внутри Field бывает и строка из двух полей, и поле в обёртке.
 */
const FieldContext = createContext<FieldInfo>({});

interface FieldProps {
  label?: string;
  /** Подсказка под полем. Если есть ошибка — показывается она. */
  hint?: string;
  error?: string | null;
  children: ReactNode;
}

/** Подпись, само поле и строка под ним — подсказка или ошибка. */
export function Field({ label, hint, error, children }: FieldProps) {
  const styles = useThemedStyles(makeStyles);
  const info = useMemo(() => ({ label, error }), [label, error]);
  // Ошибка может появиться за краем экрана, а фокус диктора остаётся на
  // кнопке «Отправить» — без этого нажатие выглядит так, будто ничего не было.
  useAnnounce(error);
  return (
    <View style={styles.field}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <FieldContext.Provider value={info}>{children}</FieldContext.Provider>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}

/** Клавиатуры без кнопки «Готово» — на iOS закрыть их нечем. */
const PADS = ['number-pad', 'phone-pad', 'decimal-pad', 'numeric'];

interface InputProps extends TextInputProps {
  invalid?: boolean;
}

/**
 * Поле ввода.
 *
 * Шрифт — 16: при меньшем iOS увеличивает экран при фокусе.
 *
 * Цифровым клавиатурам на iOS даём подпись кнопки «Готово»: по ней система
 * сама ставит над клавиатурой панель с этой кнопкой — у каждого поля свою.
 * Общая панель через InputAccessoryView с одним ID не годится: она ищет
 * своё поле один раз, когда монтируется сама, а поля форм и шторок
 * появляются позже — панель не показывалась бы вовсе.
 */
export const Input = forwardRef<TextInputInstance, InputProps>(function Input(
  { invalid, style, multiline, keyboardType, ...rest },
  ref,
) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const field = useContext(FieldContext);
  const pad = keyboardType ? PADS.includes(keyboardType) : false;
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.muted}
      multiline={multiline}
      keyboardType={keyboardType}
      inputAccessoryViewButtonLabel={pad ? t('common.done') : undefined}
      // Ошибка — подсказкой, а не названием: название у поля своё, а на
      // Android текст в названии заменил бы для диктора введённое значение.
      accessibilityHint={field.error ?? undefined}
      textAlignVertical={multiline ? 'top' : 'center'}
      style={[styles.input, multiline && styles.multiline, invalid && styles.invalid, style]}
      {...rest}
    />
  );
});

interface SelectFieldProps {
  /** Выбранное значение; пусто — показывается placeholder. */
  value?: string | null;
  placeholder: string;
  onPress: () => void;
  /** Название для экранного диктора. По умолчанию — подпись Field вокруг. */
  label?: string;
  icon?: keyof typeof Icon.glyphMap;
  invalid?: boolean;
  disabled?: boolean;
}

/**
 * Поле-выбор: выглядит как поле ввода, по нажатию открывает шторку
 * (город, дата). Значение приходит снаружи.
 */
export function SelectField({
  value,
  placeholder,
  onPress,
  label,
  icon = 'chevron-down',
  invalid,
  disabled,
}: SelectFieldProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const field = useContext(FieldContext);
  // Без названия диктор читал только значение: «12 октября, кнопка» — и
  // непонятно, что это дата события.
  const name = label ?? field.label;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={name ? `${name}: ${value || placeholder}` : undefined}
      accessibilityHint={field.error ?? undefined}
      style={({ pressed }) => [
        styles.input,
        styles.select,
        invalid && styles.invalid,
        (pressed || disabled) && styles.dim,
      ]}
    >
      <Text style={[styles.selectText, !value && styles.placeholder]} numberOfLines={1}>
        {value || placeholder}
      </Text>
      <Icon name={icon} size={20} color={colors.muted} />
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    field: { gap: 6 },
    label: { fontSize: text.caption, color: colors.muted },
    hint: { fontSize: 13, color: colors.muted },
    error: { fontSize: 13, color: colors.danger },
    input: {
      minHeight: HIT,
      borderWidth: 1,
      // outline, а не border: поле стоит на карточке того же цвета, и
      // рамка — единственное, что показывает, где оно.
      borderColor: colors.outline,
      borderRadius: radius.inner,
      backgroundColor: colors.card,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
      color: colors.text,
    },
    multiline: { minHeight: 96 },
    invalid: { borderColor: colors.danger },
    select: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    selectText: { flex: 1, fontSize: 16, color: colors.text },
    placeholder: { color: colors.muted },
    dim: { opacity: 0.6 },
  });
