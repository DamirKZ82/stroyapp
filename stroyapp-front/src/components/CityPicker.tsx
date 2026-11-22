import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  type ListRenderItem,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import type { City } from '@/api/types';
import { HIT, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { Input } from './Field';
import { Sheet } from './Sheet';

interface CityPickerProps {
  visible: boolean;
  cities: City[];
  onSelect: (city: City) => void;
  onClose: () => void;
  /** Текущий город — отмечается галочкой. */
  selectedId?: number | null;
  /**
   * Если передан, первой строкой идёт «Все города»: выбранный город иначе
   * нельзя снять, только сменить на другой. В формах владельца город
   * обязателен, там этот пункт не нужен.
   */
  onClear?: () => void;
}

/** Меньше трёх строк список не делаем: иначе «не найдено» негде показать. */
const MIN_ROWS = 3;

/**
 * Шторка выбора города с поиском.
 *
 * Ищем сразу по русскому и казахскому названию: человек набирает «Уральск»
 * или «Орал» так, как привык, а не так, как выбран язык интерфейса.
 */
export function CityPicker({
  visible,
  cities,
  onSelect,
  onClose,
  selectedId,
  onClear,
}: CityPickerProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const lang = useLang();
  const { height: windowHeight } = useWindowDimensions();
  const [query, setQuery] = useState('');

  // Сам компонент живёт всё время, пока открыт экран, поэтому прошлый поиск
  // остался бы в поле. Сбрасываем прямо в рендере, а не в useEffect: эффект
  // сработал бы после первого кадра, и шторка выезжала бы со старым запросом.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setQuery('');
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return cities;
    return cities.filter(
      (city) =>
        city.name_ru.toLowerCase().includes(needle) || city.name_kz.toLowerCase().includes(needle),
    );
  }, [query, cities]);

  // Высота считается по полному списку, а не по найденному: иначе шторка
  // прыгала бы на каждую набранную букву. Потолок в полэкрана оставляет место
  // заголовку и полю; когда выезжает клавиатура, список сжимается сам
  // (flexShrink) под maxHeight шторки.
  const listHeight = Math.min(
    Math.max(cities.length, MIN_ROWS) * HIT,
    Math.round(windowHeight * 0.5),
  );

  const renderItem: ListRenderItem<City> = useCallback(
    ({ item, index }) => {
      const chosen = item.id === selectedId;
      return (
        <Pressable
          onPress={() => {
            onSelect(item);
            onClose();
          }}
          accessibilityRole="button"
          accessibilityState={{ selected: chosen }}
          style={({ pressed }) => [
            styles.row,
            (index > 0 || (!!onClear && !query.trim())) && styles.divided,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.name, chosen && styles.nameChosen]} numberOfLines={1}>
            {dictName(item, lang)}
          </Text>
          {chosen ? <Icon name="check" size={22} color={colors.primary} /> : null}
        </Pressable>
      );
    },
    [selectedId, onSelect, onClose, onClear, query, styles, colors, lang],
  );

  const keyExtractor = useCallback((city: City) => String(city.id), []);

  return (
    <Sheet visible={visible} onClose={onClose} title={t('city_picker.title')}>
      <Input
        value={query}
        onChangeText={setQuery}
        placeholder={t('common.search')}
        // Подсказка пропадает с первой буквой, и поле осталось бы без имени.
        accessibilityLabel={t('common.search')}
        clearButtonMode="while-editing"
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
      />
      <FlatList
        data={filtered}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        // «Все города» прячем, пока человек ищет: строка не про его запрос.
        ListHeaderComponent={
          onClear && !query.trim() ? (
            <Pressable
              onPress={() => {
                onClear();
                onClose();
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedId == null }}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <Text style={[styles.name, selectedId == null && styles.nameChosen]} numberOfLines={1}>
                {t('city_picker.all')}
              </Text>
              {selectedId == null ? <Icon name="check" size={22} color={colors.primary} /> : null}
            </Pressable>
          ) : null
        }
        style={[styles.list, { height: listHeight }]}
        // Без этого первое нажатие на город при открытой клавиатуре только
        // прятало бы её, и выбирать приходилось бы вторым нажатием.
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={styles.empty}>{t('city_picker.empty')}</Text>}
      />
    </Sheet>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Список выходит за поля шторки (у Sheet они space.page), а строки
    // возвращают отступ себе: подсветка нажатия и разделители идут от края
    // до края, как в системных списках.
    list: { flexGrow: 0, flexShrink: 1, marginHorizontal: -space.page },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.gap,
      minHeight: HIT,
      paddingHorizontal: space.page,
    },
    divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    pressed: { backgroundColor: colors.background },
    name: { flex: 1, minWidth: 0, fontSize: text.body, color: colors.text },
    nameChosen: { fontWeight: '600' },
    empty: {
      fontSize: text.body,
      color: colors.muted,
      textAlign: 'center',
      paddingVertical: 24,
      paddingHorizontal: space.page,
    },
  });
