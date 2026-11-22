import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import type { Category } from '@/api/types';
import { radius, space, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { dictName } from '@/utils/i18nDict';
import { mdiOrFallback } from '@/utils/icons';
import { useLang } from '@/utils/lang';

interface CategoryBarProps {
  categories: Category[];
  selectedId: number | null;
  onSelect: (cat: Category) => void;
}

/**
 * Ряд категорий над поиском: плитка с иконкой и подписью.
 *
 * Плитки разной ширины, по подписи: в одинаковые узкие не влезает
 * «Мейрамханалар», и слово рвалось бы посреди. Высота у всех общая — ряд
 * растягивает плитки по самой высокой, с подписью в две строки.
 *
 * Отступов сверху и снизу нет: их задаёт экран. Ряд должен идти от края до
 * края экрана — отступ страницы уже внутри прокрутки, иначе плитки
 * обрезались бы на расстоянии отступа от края.
 */
export function CategoryBar({ categories, selectedId, onSelect }: CategoryBarProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const lang = useLang();

  // Пока категории грузятся (или сервер их не отдал), пустая прокрутка всё
  // равно занимала бы место в колонке экрана — лишний зазор над фильтрами.
  if (categories.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.bar}
      contentContainerStyle={styles.content}
    >
      {categories.map((cat) => {
        const selected = cat.id === selectedId;
        const name = dictName(cat, lang);
        return (
          <Pressable
            key={cat.id}
            onPress={() => onSelect(cat)}
            accessibilityRole="button"
            // Подпись задана явно, а не собрана из детей: Android прочёл бы
            // в ней символ шрифта иконки непонятным знаком.
            accessibilityLabel={name}
            accessibilityState={{ selected }}
            style={({ pressed }) => [styles.tile, selected && styles.selected, pressed && styles.dim]}
          >
            <Icon
              name={mdiOrFallback(cat.icon)}
              size={26}
              color={selected ? colors.primary : colors.muted}
              accessible={false}
              importantForAccessibility="no"
            />
            {/* Крупный системный шрифт раздувал бы плитку вдвое — рост подписи ограничен. */}
            <Text style={styles.label} numberOfLines={2} maxFontSizeMultiplier={1.3}>
              {name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Горизонтальная прокрутка в колонке иначе тянется вниз на весь экран.
    bar: { flexGrow: 0 },
    content: { paddingHorizontal: space.page, gap: 8 },
    tile: {
      alignItems: 'center',
      gap: 6,
      minWidth: 80,
      maxWidth: 124,
      paddingHorizontal: 10,
      paddingVertical: 10,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: 1,
      // outline, а не border: плитку выбирают, и бледную рамку на фоне не видно.
      borderColor: colors.outline,
    },
    selected: { backgroundColor: `${colors.primary}22`, borderColor: colors.primary },
    dim: { opacity: 0.6 },
    // Вес у выбранной тот же: от жирного подпись шире, и ряд дёргался бы при выборе.
    label: {
      fontSize: 12,
      lineHeight: 16,
      fontWeight: '500',
      color: colors.text,
      textAlign: 'center',
    },
  });
