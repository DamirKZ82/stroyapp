import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { space } from '@/theme';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { intOrNull, onlyDigits } from '@/utils/number';
import { Button } from './Button';
import { Chip, ChipWrap } from './Chip';
import { Field, Input } from './Field';
import { Segment } from './Segment';
import { Sheet } from './Sheet';

export type SortOption = 'rating_desc' | 'price_asc' | 'price_desc';

export interface FiltersValue {
  priceMax: number | null;
  amenityIds: number[];
  sort: SortOption;
}

/**
 * Тег фильтра: удобство зала или атрибут исполнителя. Шторке нужны только
 * id и названия, поэтому подходит любой справочник с такими полями.
 */
interface FilterTag {
  id: number;
  name_ru: string;
  name_kz: string;
}

interface FiltersSheetProps {
  visible: boolean;
  onClose: () => void;
  value: FiltersValue;
  onApply: (value: FiltersValue) => void;
  /** Теги для фильтра. Пустой список — раздела с чипами нет. */
  amenities: FilterTag[];
  /** Подпись раздела с тегами. По умолчанию — «Удобства». */
  amenitiesLabel?: string;
}

const DEFAULT_SORT: SortOption = 'rating_desc';
// Пример суммы, а не текст: переводить в нём нечего.
const PRICE_PLACEHOLDER = '500000';

const priceText = (price: number | null) => (price ? String(price) : '');

/**
 * Шторка фильтров поиска: предел цены, сортировка, теги.
 *
 * Изменения копятся в черновике и уходят наружу только по «Применить» или
 * «Сбросить» — поиск не перезапускается на каждый чип.
 */
export function FiltersSheet({
  visible,
  onClose,
  value,
  onApply,
  amenities,
  amenitiesLabel,
}: FiltersSheetProps) {
  const { t } = useTranslation();
  const lang = useLang();

  const [priceMax, setPriceMax] = useState(priceText(value.priceMax));
  const [amenityIds, setAmenityIds] = useState<number[]>(value.amenityIds);
  const [sort, setSort] = useState<SortOption>(value.sort);

  // Черновик сверяется с value только в момент открытия. Следить за самим
  // value нельзя: экран собирает его новым объектом на каждом рендере, и
  // любое обновление экрана под открытой шторкой стирало бы набранное.
  // Сверка идёт прямо в рендере, а не в эффекте — иначе шторка на кадр
  // показывается с черновиком от прошлого открытия.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) {
      setPriceMax(priceText(value.priceMax));
      setAmenityIds(value.amenityIds);
      setSort(value.sort);
    }
  }

  const toggleAmenity = (id: number) =>
    setAmenityIds((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const apply = () => {
    const price = intOrNull(priceMax);
    onApply({
      priceMax: price !== null && price > 0 ? price : null,
      amenityIds,
      sort,
    });
    onClose();
  };

  // Сброс сразу применяется и закрывает шторку: иначе после него нужно ещё
  // раз нажать «Применить», а закрыв крестиком, человек остаётся со старыми
  // фильтрами, хотя видел пустые.
  // Черновик чистим тоже: на iOS шторка уезжает ещё долю секунды, и без
  // этого она закрывалась бы с прежними отмеченными чипами — будто сброс
  // не сработал.
  const reset = () => {
    setPriceMax('');
    setAmenityIds([]);
    setSort(DEFAULT_SORT);
    onApply({ priceMax: null, amenityIds: [], sort: DEFAULT_SORT });
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('filters.title')}>
      {/* Тегов бывает на несколько экранов, а с клавиатурой места ещё
          меньше: поля прокручиваются, кнопки остаются на месте. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        alwaysBounceVertical={false}
        showsVerticalScrollIndicator={false}
      >
        <Field label={t('filters.max_price')}>
          <Input
            value={priceMax}
            onChangeText={(input) => setPriceMax(onlyDigits(input, 10))}
            keyboardType="number-pad"
            placeholder={PRICE_PLACEHOLDER}
            // Подпись Field — отдельный текст; без этого экранный диктор
            // назвал бы поле по примеру в нём: «500000».
            accessibilityLabel={t('filters.max_price')}
          />
        </Field>

        <Field label={t('filters.sort')}>
          <Segment
            value={sort}
            onChange={setSort}
            options={[
              { value: 'rating_desc', label: t('filters.sort_rating') },
              { value: 'price_asc', label: t('filters.sort_price_asc') },
              { value: 'price_desc', label: t('filters.sort_price_desc') },
            ]}
          />
        </Field>

        {amenities.length > 0 ? (
          <Field label={amenitiesLabel ?? t('filters.amenities')}>
            <ChipWrap>
              {amenities.map((item) => (
                <Chip
                  key={item.id}
                  label={dictName(item, lang)}
                  selected={amenityIds.includes(item.id)}
                  onPress={() => toggleAmenity(item.id)}
                />
              ))}
            </ChipWrap>
          </Field>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Button
          label={t('common.reset')}
          variant="outline"
          onPress={reset}
          style={styles.action}
        />
        <Button label={t('common.apply')} onPress={apply} style={styles.action} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // flexGrow: 0 — по высоте содержимого; высоту ограничивает сама шторка
  // (maxHeight), и при нехватке места сжимается именно прокрутка.
  scroll: { flexGrow: 0 },
  content: { gap: space.card },
  actions: { flexDirection: 'row', gap: space.gap },
  action: { flex: 1 },
});
