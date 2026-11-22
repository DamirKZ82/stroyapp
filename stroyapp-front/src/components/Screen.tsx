import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { useKeyboardShown } from '@/utils/useKeyboardShown';
import { useSafeBottomInset } from '@/utils/useSafeBottomInset';

interface ScreenProps {
  /**
   * Экран-вкладка: системной шапки нет, отступ сверху под вырез делаем сами.
   * Без tab — экран открыт над вкладками и сам включает шапку через
   * <Stack.Screen options={{ headerShown: true, title }} />: вырез уже обошла
   * шапка, и второй отступ сверху давал бы пустую полосу.
   */
  tab?: boolean;
  /**
   * Содержимое в ScrollView с отступами экрана — формы и карточки.
   * Для списков не ставить: внутри свой FlatList с LIST_CONTENT.
   */
  scroll?: boolean;
  /** Закреплённая полоса с кнопками под содержимым. */
  footer?: ReactNode;
  /** Потянуть вниз, чтобы обновить (только вместе со scroll). */
  refreshing?: boolean;
  onRefresh?: () => void;
  children: ReactNode;
}

/**
 * Рамка экрана: фон, безопасные края, клавиатура и закреплённый низ.
 *
 * Клавиатура: содержимое поднимаем над ней сами на обеих системах. На
 * Android окно под клавиатуру больше не сжимается: приложение всегда
 * рисуется от края до края (в SDK 57 это не отключается), и
 * softwareKeyboardLayoutMode: resize из app.json ничего не даёт — без
 * отступа клавиатура просто легла бы поверх последних полей и кнопки
 * «Сохранить». Если же окно где-то всё-таки сожмётся, отступ сам выйдет
 * нулевым: он считается от нижнего края рамки.
 *
 * Поправка на высоту шапки нужна потому, что экран под шапкой начинается не
 * с нуля, а KeyboardAvoidingView считает от верха окна. На Android высота
 * шапки уже включает строку состояния.
 */
export function Screen({ tab = false, scroll = false, footer, refreshing, onRefresh, children }: ScreenProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;

  return (
    <SafeAreaView style={[styles.screen, tab && WEB_TABS_ROOM]} edges={tab ? ['top'] : []}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'web' ? undefined : 'padding'}
        keyboardVerticalOffset={tab ? 0 : headerHeight}
      >
        {scroll ? (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={[
              styles.body,
              tab ? { paddingBottom: TAB_BOTTOM } : !footer && { paddingBottom: 32 + insets.bottom },
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            refreshControl={
              onRefresh ? (
                <RefreshControl
                  refreshing={!!refreshing}
                  onRefresh={onRefresh}
                  tintColor={colors.primary}
                  colors={[colors.primary]}
                />
              ) : undefined
            }
          >
            {children}
          </ScrollView>
        ) : (
          children
        )}
        {footer ? <Footer>{footer}</Footer> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Отступ под кнопками закреплённого низа, когда системного края под ним нет. */
const FOOTER_PAD = 12;

/**
 * Закреплённый низ. Отдельным компонентом, чтобы за клавиатурой следили
 * только экраны с кнопками внизу и перерисовывалась одна эта полоса.
 */
function Footer({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const safeBottom = useSafeBottomInset();
  const keyboardShown = useKeyboardShown();
  // С открытой клавиатурой полоса стоит прямо на ней: отступ под системный
  // край был бы пустым местом, которого на экране и так осталось мало.
  const paddingBottom = keyboardShown ? FOOTER_PAD : Math.max(safeBottom, FOOTER_PAD);
  return <View style={[styles.footer, { paddingBottom }]}>{children}</View>;
}

/**
 * Только для веб-превью (expo start --web): там вкладки рисуются полосой
 * поверх верха экрана и закрывают заголовок. В приложении этого отступа нет.
 */
const WEB_TABS_ROOM = Platform.OS === 'web' ? ({ paddingTop: 64 } as const) : null;

/** Отступы содержимого списка: contentContainerStyle у FlatList. */
export const LIST_CONTENT = { padding: space.page, gap: space.gap, paddingBottom: 32 } as const;

/**
 * LIST_CONTENT для списка с EmptyState или вертушкой первой загрузки:
 * flexGrow растягивает содержимое на всю высоту, и они встают по центру, а
 * не липнут к шапке.
 */
export const LIST_CONTENT_FILL = { ...LIST_CONTENT, flexGrow: 1 } as const;

/**
 * Запас снизу на экранах-вкладках. На iOS системная панель вкладок лежит
 * поверх содержимого, и последняя карточка без запаса прячется под ней.
 * Системную подстройку отступов списка на iOS макет вкладок отключает
 * (disableAutomaticContentInsets), так что этот запас — единственный. На
 * Android панель место занимает сама — там хватает обычного отступа.
 */
export const TAB_BOTTOM = Platform.OS === 'ios' ? 96 : 32;

/**
 * Отступы списка на вкладке. Вкладки берут именно эту константу, а не
 * собирают свою: запас под панель меняется в одном месте.
 *
 * Сразу с flexGrow, как LIST_CONTENT_FILL: пустое состояние есть у каждой
 * вкладки, а длинному списку flexGrow ничего не меняет — второй вариант
 * без него был бы лишним выбором.
 */
export const TAB_LIST_CONTENT = { ...LIST_CONTENT_FILL, paddingBottom: TAB_BOTTOM } as const;

interface ScreenTitleProps {
  title: string;
  subtitle?: string;
  /** Кнопка справа от заголовка. */
  action?: ReactNode;
}

/**
 * Заголовок экрана-вкладки. У вкладок системной шапки нет, заголовок —
 * обычный текст первой строкой содержимого.
 */
export function ScreenTitle({ title, subtitle, action }: ScreenTitleProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.titleRow}>
      <View style={styles.titleText}>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {/* Системной шапки у вкладки нет, и без роли диктору не за что
            зацепиться в списке заголовков. */}
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
      </View>
      {action}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    body: { padding: space.page, gap: space.gap, paddingBottom: 32 },
    footer: {
      flexDirection: 'row',
      gap: space.gap,
      paddingHorizontal: space.page,
      paddingTop: 8,
      backgroundColor: colors.card,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.gap },
    titleText: { flex: 1, minWidth: 0, gap: 2 },
    title: { fontSize: text.title, fontWeight: '700', color: colors.text },
    subtitle: { fontSize: text.caption, color: colors.muted },
  });
