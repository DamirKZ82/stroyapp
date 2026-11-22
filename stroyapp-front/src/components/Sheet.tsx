import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';

import { FILL, radius, scrim, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { useKeyboardShown } from '@/utils/useKeyboardShown';
import { useSafeBottomInset } from '@/utils/useSafeBottomInset';

/** Зона нажатия крестика и сама иконка в ней. */
const CLOSE_HIT = 44;
const CLOSE_ICON = 24;

interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  /** false — закрыть нельзя ни крестиком, ни тапом мимо (идёт запрос). */
  dismissable?: boolean;
  children: ReactNode;
}

/**
 * Шторка снизу: выбор города, даты, фильтры, вход.
 *
 * Это обычный Modal, а не системный лист: во всех шторках есть поля ввода
 * или список с поиском, а системные листы на Android с ними пока не дружат.
 *
 * Внутри нет ScrollView намеренно: содержимым бывает FlatList, а вложенные
 * списки одной ориентации в React Native запрещены. Длинное содержимое
 * прокручивает сам ребёнок.
 */
export function Sheet({ visible, onClose, title, dismissable = true, children }: SheetProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const close = dismissable ? onClose : undefined;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}
      statusBarTranslucent
    >
      {/* Свой SafeAreaProvider: на iOS вкладки оборачивают каждый экран в
          свой, и там нижний отступ включает высоту панели вкладок (~83 вместо
          34) — шторка из поиска висела бы с пустой полосой под кнопками.
          Шторка — отдельное окно поверх всего, отступы меряем в нём самом.
          initialMetrics — чтобы в первом кадре не было отступа вкладки. */}
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        {/* Затемнение отдельно от шторки: на весь экран и не едет с клавиатурой. */}
        <Pressable
          style={styles.backdrop}
          onPress={close}
          // Пока шторку закрыть нельзя, для диктора затемнения нет: иначе он
          // находил бы «Закрыть», которое ничего не делает.
          accessible={dismissable}
          importantForAccessibility={dismissable ? 'yes' : 'no'}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        />
        <KeyboardAvoidingView
          style={styles.holder}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          pointerEvents="box-none"
        >
          <Panel title={title} dismissable={dismissable} onClose={onClose}>
            {children}
          </Panel>
        </KeyboardAvoidingView>
      </SafeAreaProvider>
    </Modal>
  );
}

interface PanelProps {
  title?: string;
  dismissable: boolean;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Сама шторка. Отдельным компонентом, потому что нижний отступ надо читать
 * под SafeAreaProvider шторки, а не под тем, где её объявили.
 */
function Panel({ title, dismissable, onClose, children }: PanelProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const safeBottom = useSafeBottomInset();
  const keyboardShown = useKeyboardShown();
  // С открытой клавиатурой шторка стоит прямо на ней, как закреплённый низ
  // экрана: отступ под системный край был бы пустой полосой над клавиатурой.
  const paddingBottom = space.page + (keyboardShown ? 0 : safeBottom);

  return (
    <View style={[styles.sheet, { paddingBottom }]}>
      <View style={styles.grabber} />
      {title || dismissable ? (
        <View style={styles.head}>
          <Text style={styles.title} numberOfLines={1}>
            {title ?? ''}
          </Text>
          {dismissable ? (
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              style={styles.close}
            >
              <Icon name="close" size={CLOSE_ICON} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backdrop: { ...FILL, backgroundColor: scrim },
    holder: { flex: 1, justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: space.page,
      paddingTop: 8,
      gap: space.gap,
      maxHeight: '88%',
      // С открытой клавиатурой места меньше 88% экрана: шторка сжимается, а
      // её содержимое (у кого оно длинное) прокручивается, а не уезжает вверх.
      flexShrink: 1,
    },
    grabber: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: radius.pill,
      backgroundColor: colors.border,
    },
    // Высота — под крестик, и без него тоже: иначе заголовок прыгал бы, когда
    // шторку на время запроса нельзя закрыть. Отрицательный отступ справа
    // ставит иконку крестика на край содержимого: строка заходит в поле
    // шторки сама, и вся зона нажатия остаётся внутри неё.
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.gap,
      minHeight: CLOSE_HIT,
      marginRight: -(CLOSE_HIT - CLOSE_ICON) / 2,
    },
    // Размер у самой кнопки, а не hitSlop: тот не выходит за границы
    // родителя, а строка заголовка была высотой с иконку — попадать
    // приходилось точно в значок.
    close: {
      width: CLOSE_HIT,
      height: CLOSE_HIT,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: { flex: 1, fontSize: text.section, fontWeight: '700', color: colors.text },
  });
