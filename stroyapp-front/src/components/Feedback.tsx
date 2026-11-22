import { useEffect, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { radius, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';

/** Вертушка на весь экран — первая загрузка, когда показать ещё нечего. */
export function Loader() {
  const colors = useColors();
  return (
    <View style={plain.center}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

/**
 * Проговаривает сообщение экранному диктору, когда оно появилось или
 * сменилось. Для ошибок: фокус диктора остаётся на нажатой кнопке, и без
 * этого появившийся текст никто не услышит.
 *
 * Роль alert сама говорит только в браузере. На iOS «живых областей» нет, а
 * на Android accessibilityLiveRegion надёжно срабатывает только на смену
 * содержимого уже стоящего на экране элемента — наши же ошибки каждый раз
 * монтируются заново. Поэтому на обеих платформах говорим явно, а
 * liveRegion не ставим: вместе они дали бы на Android два объявления подряд.
 */
export function useAnnounce(message?: string | null): void {
  useEffect(() => {
    // В браузере метода с опциями нет, а alert там объявляет себя сам.
    if (!message || Platform.OS === 'web') return;
    // queue: на iOS объявление иначе обрывает то, что диктор говорит прямо
    // сейчас (название нажатой кнопки), а вторая ошибка формы — первую.
    AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
  }, [message]);
}

interface ErrorBannerProps {
  message?: string | null;
  /**
   * Проговорить ли текст диктору. false — когда полоса повторяет то, что
   * уже объявил кто-то другой: ошибку поля у кнопки формы показываем для
   * зрячих (само поле может быть прокручено за край), а диктору её уже
   * сказал Field.
   */
  announce?: boolean;
}

/**
 * Ошибка в виде полосы вверху формы или списка. Пустое сообщение — ничего
 * не рисует, поэтому её можно ставить без условия.
 */
export function ErrorBanner({ message, announce = true }: ErrorBannerProps) {
  const styles = useThemedStyles(makeStyles);
  useAnnounce(announce ? message : null);
  if (!message) return null;
  return (
    // accessible: без него роль на iOS и Android ни к чему не привязана —
    // элементом для диктора был бы только текст внутри. Без объявления
    // роль не ставим: в браузере alert проговаривает себя сам.
    <View style={styles.error} accessible accessibilityRole={announce ? 'alert' : undefined}>
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

interface EmptyStateProps {
  title: string;
  subtitle?: string;
  /** Кнопка под текстом: «Войти», «Добавить». */
  action?: ReactNode;
}

/** Пустой список или экран гостя: заголовок, пояснение и, если есть, действие. */
export function EmptyState({ title, subtitle, action }: EmptyStateProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySubtitle}>{subtitle}</Text> : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

type Tone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'muted';

/** Бейдж статуса: контур и текст одного цвета, без заливки. */
export function Badge({ label, tone = 'muted' }: { label: string; tone?: Tone }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const color = colors[tone];
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const plain = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    error: {
      backgroundColor: `${colors.danger}1F`,
      borderRadius: radius.inner,
      padding: 12,
    },
    errorText: { fontSize: text.caption, color: colors.danger },
    empty: {
      flexGrow: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 48,
      paddingHorizontal: space.page,
      gap: 8,
    },
    emptyTitle: { fontSize: text.subtitle, fontWeight: '600', color: colors.text, textAlign: 'center' },
    emptySubtitle: { fontSize: text.caption, color: colors.muted, textAlign: 'center' },
    emptyAction: { marginTop: 8, alignSelf: 'stretch' },
    badge: {
      alignSelf: 'flex-start',
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: radius.inner,
      borderWidth: 1,
    },
    badgeText: { fontSize: 12, fontWeight: '600' },
  });
