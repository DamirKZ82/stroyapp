import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Stack, useFocusEffect } from 'expo-router';
import { memo, useCallback, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ListRenderItem,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, dictsApi, providersApi } from '@/api';
import type { Category, CategoryBrief, City, ListingKind, PriceUnit } from '@/api/types';
import { Button } from '@/components/Button';
import { Card, Row, SectionLabel } from '@/components/Card';
import { Badge, EmptyState, ErrorBanner, Loader } from '@/components/Feedback';
import { LIST_CONTENT_FILL, Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { Thumb } from '@/components/Thumb';
import { space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { KIND_ICON, KIND_KEY, KINDS } from '@/utils/category';
import { formatPrice } from '@/utils/format';
import { dictName } from '@/utils/i18nDict';
import { mdiOrFallback } from '@/utils/icons';
import { useLang } from '@/utils/lang';
import { pushOnce } from '@/utils/nav';
import { unitLabel } from '@/utils/priceUnit';

/**
 * Строка единого списка. Справочные поля (город, категория) лежат как есть,
 * а не готовым текстом: название на нужном языке собирается при отрисовке,
 * и смена языка не требует перезагрузки списка.
 */
interface Listing {
  guid: string;
  name: string;
  cityId: number;
  category: CategoryBrief;
  thumb: string | null;
  priceFrom: number | null;
  priceUnit: PriceUnit | null;
  itemsCount: number;
  isActive: boolean;
}

/**
 * Объявления продавца: магазины и бригады одним списком. Разница между ними
 * только в категории, форма одна.
 */
export default function MyListingsScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  const [items, setItems] = useState<Listing[]>([]);
  const [cities, setCities] = useState<Record<number, City>>({});
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Фокус и «потянуть вниз» могут запустить два запроса сразу: показываем
  // ответ только последнего, иначе старый ответ затрёт свежий — например,
  // вернёт в список только что удалённое объявление.
  const lastRequest = useRef(0);

  const load = useCallback(async () => {
    const request = ++lastRequest.current;
    try {
      const [provs, cityList] = await Promise.all([
        providersApi.my(),
        // Справочник городов — только подписи в строках: его сбой не должен
        // прятать сами объявления за полосой ошибки. Строки тогда без города,
        // а прежний справочник (если был) остаётся.
        dictsApi
          .cities()
          .then((r) => r.items)
          .catch(() => null),
      ]);
      if (request !== lastRequest.current) return;

      if (cityList) {
        const cityMap: Record<number, City> = {};
        for (const city of cityList) cityMap[city.id] = city;
        setCities(cityMap);
      }

      const providerItems = provs.items.map(
        (p): Listing => ({
          guid: p.guid,
          name: p.name,
          cityId: p.city_id,
          category: p.category,
          thumb: p.main_thumb,
          priceFrom: p.price_from,
          priceUnit: p.price_unit,
          itemsCount: p.items_count,
          isActive: p.is_active,
        }),
      );

      setItems(providerItems);
      // Ошибку снимаем после удачного ответа, а не перед запросом: иначе при
      // повторе после сбоя на время запроса показывалось бы «объявлений
      // нет» с кнопкой добавления — а мы этого ещё не знаем.
      setError(null);
    } catch (e) {
      if (request !== lastRequest.current) return;
      // Прежний список при ошибке не трогаем: полоса ошибки над тем, что
      // уже показано, полезнее пустого экрана.
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      if (request === lastRequest.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [t]);

  // Категории нужны только для шторки добавления — грузим отдельно и молча:
  // без них экран остаётся рабочим, просто категорию спросит сама форма.
  const loadCategories = useCallback(async () => {
    try {
      const resp = await dictsApi.categories();
      setCategories(resp.items);
    } catch {
      /* необязательно */
    }
  }, []);

  // Только по фокусу, без отдельного useEffect: фокус срабатывает и при
  // первом открытии, и при возврате из формы — список сразу видит правки.
  useFocusEffect(
    useCallback(() => {
      void load();
      void loadCategories();
    }, [load, loadCategories]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
    void loadCategories();
  }, [load, loadCategories]);

  const startAdding = useCallback(() => {
    if (categories.length > 0) {
      setPickerOpen(true);
    } else {
      // Справочник не доехал — не блокируем добавление.
      pushOnce('/provider-form');
    }
  }, [categories.length]);

  const openCreate = (cat: Category) => {
    setPickerOpen(false);
    pushOnce({ pathname: '/provider-form', params: { categoryId: String(cat.id) } });
  };

  const openListing = useCallback((item: Listing) => {
    // Отдельного экрана продавца у объявления нет: сразу форма с прайсом.
    pushOnce({ pathname: '/provider-form', params: { providerGuid: item.guid } });
  }, []);

  const renderItem: ListRenderItem<Listing> = useCallback(
    ({ item }) => <ListingRow item={item} city={cities[item.cityId]} onPress={openListing} />,
    [cities, openListing],
  );

  const keyExtractor = useCallback((item: Listing) => item.guid, []);

  const screenOptions = { headerShown: true, title: t('owner.listings_title') };

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={screenOptions} />
        <Loader />
      </Screen>
    );
  }

  const addButton = <Button label={t('owner.add_listing')} icon="plus" onPress={startAdding} />;

  // Пустой заголовок списку не отдаём: обёртка нулевой высоты всё равно
  // получила бы свой gap, и первая карточка съехала бы вниз.
  // Список пуст и есть ошибка — значит, не загрузилось вовсе: даём явный
  // повтор, потому что потянуть вниз пустой экран мало кто догадается.
  const header =
    error || items.length > 0 ? (
      <View style={styles.header}>
        <ErrorBanner message={error} />
        {items.length > 0 ? (
          addButton
        ) : (
          <Button
            label={t('common.retry')}
            variant="outline"
            busy={refreshing}
            onPress={onRefresh}
          />
        )}
      </View>
    ) : null;

  return (
    <Screen>
      <Stack.Screen options={screenOptions} />
      <FlatList
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={LIST_CONTENT_FILL}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        ListHeaderComponent={header}
        ListEmptyComponent={
          // При ошибке «объявлений нет» было бы неправдой: мы этого не знаем.
          error ? null : (
            <EmptyState
              title={t('owner.listings_empty_title')}
              subtitle={t('owner.listings_empty_hint')}
              action={addButton}
            />
          )
        }
      />

      <Sheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={t('owner.choose_category')}
      >
        {/* Sheet сам не прокручивается, а категорий может стать больше, чем
            влезает в шторку на небольшом экране. */}
        <ScrollView style={styles.sheetList}>
          {/* Сначала вид — магазин или бригада, — под ним его категории. */}
          {KINDS.map((kind: ListingKind) => {
            const group = categories.filter((cat) => cat.kind === kind);
            if (group.length === 0) return null;
            return (
              <View key={kind} style={styles.group}>
                <View style={styles.groupLabel}>
                  <SectionLabel>{t(KIND_KEY[kind])}</SectionLabel>
                </View>
                {group.map((cat, index) => (
                  <Row
                    key={cat.id}
                    first={index === 0}
                    title={dictName(cat, lang)}
                    // Имя иконки с сервера набор MDI может не знать.
                    icon={mdiOrFallback(cat.icon)}
                    onPress={() => openCreate(cat)}
                  />
                ))}
              </View>
            );
          })}
        </ScrollView>
      </Sheet>
    </Screen>
  );
}

interface ListingRowProps {
  item: Listing;
  /** Города может не быть в справочнике (скрыт, удалён) — строка без него. */
  city: City | undefined;
  onPress: (item: Listing) => void;
}

/** Карточка объявления: превью, название, пояснения и стрелка. */
const ListingRow = memo(function ListingRow({ item, city, onPress }: ListingRowProps) {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  const cityName = city ? dictName(city, lang) : '';
  const meta = [dictName(item.category, lang), cityName].filter(Boolean).join(' · ');
  const unit = unitLabel(t, item.priceUnit);
  const kind: ListingKind = item.category.kind ?? 'material';

  return (
    <Pressable
      onPress={() => onPress(item)}
      accessibilityRole="button"
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Card style={styles.card}>
        <Thumb
          path={item.thumb}
          size={THUMB}
          icon={KIND_ICON[kind]}
          iconSize={32}
        />

        <View style={styles.body}>
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
          {meta ? (
            <Text style={styles.meta} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}

          <Text style={styles.meta} numberOfLines={1}>
            {item.itemsCount > 0
              ? t('owner.items_count', { count: item.itemsCount })
              : t('owner.no_items')}
          </Text>
          {item.priceFrom == null ? (
            <Text style={styles.meta} numberOfLines={1}>
              {t('provider.price_negotiable')}
            </Text>
          ) : (
            // Слова «от» здесь нет: в русском оно стоит перед числом, в
            // казахском после, и одной строкой на оба языка не склеить.
            // Владелец сам вводил эту цену как «цена от».
            <Text style={styles.meta} numberOfLines={1}>
              <Text style={styles.price}>{formatPrice(item.priceFrom)}</Text>
              {unit ? ` · ${unit}` : ''}
            </Text>
          )}

          {!item.isActive ? (
            <View style={styles.badge}>
              {/* warning, а не danger: «снято с публикации» — состояние,
                  которое владелец выбрал сам, а не ошибка. */}
              <Badge label={t('owner.provider_inactive')} tone="warning" />
            </View>
          ) : null}
        </View>

        {/* Стрелка — украшение: подпись строки Android собирает из детей,
            и значок шрифта прочёлся бы в ней непонятным знаком. iOS пропускает
            при этом только accessibilityElementsHidden. */}
        <Icon
          name="chevron-right"
          size={20}
          color={colors.muted}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      </Card>
    </Pressable>
  );
});

const THUMB = 72;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    header: { gap: space.gap },
    pressed: { opacity: 0.7 },
    // Отступ меньше обычного у карточки: превью само даёт ей высоту, и с
    // полным отступом строка выходила бы рыхлой.
    card: { flexDirection: 'row', alignItems: 'center', padding: 12 },
    body: { flex: 1, minWidth: 0, gap: 2 },
    name: { fontSize: text.body, fontWeight: '600', color: colors.text },
    meta: { fontSize: text.caption, color: colors.muted },
    price: { fontWeight: '600', color: colors.primary },
    badge: { marginTop: 4 },
    group: { marginBottom: space.gap },
    groupLabel: { paddingHorizontal: space.page, paddingBottom: 4 },
    // Список выходит за поля шторки (у Sheet они space.page), а строки
    // возвращают отступ себе: подсветка нажатия и разделители идут от края
    // до края. flexShrink — чтобы длинный список сжимался под maxHeight
    // шторки и прокручивался, а не уезжал за экран.
    sheetList: { flexGrow: 0, flexShrink: 1, marginHorizontal: -space.page },
  });
