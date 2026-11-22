import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { HIT, radius, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';

type IconName = keyof typeof Icon.glyphMap;

interface ButtonProps {
  label: string;
  onPress: () => void;
  /** filled — главное действие экрана; outline — второстепенное; text — ссылка. */
  variant?: 'filled' | 'outline' | 'text';
  /** danger — то, что нельзя вернуть: удалить, отклонить. */
  tone?: 'primary' | 'danger';
  icon?: IconName;
  /** Идёт запрос: вместо подписи вертушка, нажать нельзя. */
  busy?: boolean;
  disabled?: boolean;
  /** Низкая кнопка для строк списка и карточек. */
  small?: boolean;
  /**
   * link — кнопка уводит из приложения: в браузер, карты, звонилку.
   * Экранный диктор тогда предупреждает об этом заранее.
   */
  accessibilityRole?: 'button' | 'link';
  /**
   * Название для экранного диктора, если подписи мало: у кнопки с номером
   * телефона подпись — одни цифры, без слова «позвонить».
   */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Кнопка.
 *
 * Отклик на нажатие — прозрачность, как у системных кнопок iOS: без ряби и
 * без тени. Пока идёт запрос, кнопка не меняет ширину — вертушка встаёт на
 * место подписи, иначе соседние кнопки в строке прыгают.
 *
 * Подпись не обрезается многоточием, пока есть выход: кнопки в подвале
 * делят строку пополам, и при крупном системном шрифте «Забронировать» уже
 * не помещается — главное действие читалось бы как «Заброниров…». Подпись
 * из нескольких слов уходит на вторую строку; одно слово перенос разорвал
 * бы посреди, поэтому оно остаётся в строке и уменьшается (как в Segment).
 */
export function Button({
  label,
  onPress,
  variant = 'filled',
  tone = 'primary',
  icon,
  busy = false,
  disabled = false,
  small = false,
  accessibilityRole = 'button',
  accessibilityLabel,
  style,
}: ButtonProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const off = disabled || busy;

  const toneColor = tone === 'danger' ? colors.danger : colors.primary;
  const filled = variant === 'filled';
  const foreground = filled ? colors.onPrimary : toneColor;
  const lines = label.trim().includes(' ') ? 2 : 1;

  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole={accessibilityRole}
      // Название задано явно: иначе оно берётся из текста внутри, а на время
      // запроса текст заменяет вертушка — кнопка оставалась без имени.
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: off, busy }}
      hitSlop={variant === 'text' ? 8 : undefined}
      style={({ pressed }) => [
        styles.base,
        small && styles.small,
        filled && { backgroundColor: toneColor },
        variant === 'outline' && [styles.outline, { borderColor: toneColor }],
        variant === 'text' && styles.text,
        off && styles.off,
        pressed && styles.pressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={small ? 18 : 20} color={foreground} /> : null}
          <Text
            style={[styles.label, small && styles.labelSmall, { color: foreground }]}
            numberOfLines={lines}
            adjustsFontSizeToFit
            // 0.7, а не больше: при системном шрифте ×1.3 и это всё ещё
            // крупнее обычного, а запас нужен узким экранам в 360 точек.
            // Нижний предел действует только на iOS: Android читает лишь
            // minimumFontSize, а его <Text> в RN 0.86 не передаёт, — там
            // слово уменьшается, пока не влезет целиком, без многоточия.
            minimumFontScale={0.7}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    base: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      minHeight: HIT,
      borderRadius: radius.inner,
      paddingHorizontal: space.card,
      // Заметен только при подписи в две строки: без него текст упирался
      // бы в края кнопки. Однострочная и так ниже minHeight.
      paddingVertical: 6,
    },
    small: { minHeight: 44, paddingHorizontal: 12 },
    outline: { borderWidth: 1, backgroundColor: colors.card },
    text: { minHeight: 44, paddingHorizontal: 8 },
    off: { opacity: 0.5 },
    pressed: { opacity: 0.7 },
    label: { fontSize: text.body, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
    labelSmall: { fontSize: text.caption },
  });
