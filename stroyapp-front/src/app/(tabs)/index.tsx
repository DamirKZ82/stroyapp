import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type ListRenderItem,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, dictsApi, searchApi } from '@/api';
import type {
  Category,
  City,
  ItemSearchRow,
  ListingKind,
  ProviderAttrType,
  ProviderCardData,
} from '@/api/types';
import { Button } from '@/components/Button';
import { CategoryBar } from '@/components/CategoryBar';
import { CityPicker } from '@/components/CityPicker';
import { EmptyState, ErrorBanner, Loader } from '@/components/Feedback';
import { Input } from '@/components/Field';
import { FiltersBar, type FiltersBarValue } from '@/components/FiltersBar';
import { FiltersSheet, type FiltersValue, type SortOption } from '@/components/FiltersSheet';
import { ProviderCard } from '@/components/ProviderCard';
import { RatingInline } from '@/components/RatingInline';
import { Screen, ScreenTitle, TAB_LIST_CONTENT } from '@/components/Screen';
import { Segment } from '@/components/Segment';
import { Thumb } from '@/components/Thumb';
import { useAuthStore } from '@/store/authStore';
import { useFavoritesStore } from '@/store/favoritesStore';
import { secureDelete, secureGet, secureSet } from '@/store/secureStorage';
import { useIsAuthed, useRequireAuth } from '@/store/useRequireAuth';
import { radius, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { KIND_KEY, KINDS } from '@/utils/category';
import { findNearestCity } from '@/utils/cityCoords';
import { formatPrice } from '@/utils/format';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { pushOnce } from '@/utils/nav';
import { intOrNull } from '@/utils/number';
import { unitLabel } from '@/utils/priceUnit';

const PAGE_SIZE = 20;
// Ключ остался от прежнего названия приложения. Переименовать — значит
// потерять выбранный город у всех, кто уже пользуется приложением.
const SAVED_CITY_KEY = 'stroyapp.selectedCityId';
/** Дальше этого от ближайшего нашего города — «мы у вас пока не работаем». */
const NEAREST_CITY_KM = 50;
/**
 * Сколько ждём свежие координаты, когда телефон не помнит последнее место.
 * В помещении и с выключенным GPS он может искать спутники минутами.
 */
const GEO_TIMEOUT_MS = 8000;
/**
 * Насколько старое «последнее известное место» ещё годится. Нужен город, а
 * не точка: за сутки он меняется редко, а ошибку человек поправит сам — по
 * подсказке «Ваш город — …».
 */
const GEO_LAST_KNOWN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Сколько первый поиск ждёт город по геолокации. Последнее известное место
 * приходит за доли секунды, и тогда ищем сразу по городу, одним запросом.
 * Не успели (нужны свежие координаты, человек отвечает на вопрос о
 * доступе) — ищем без города; когда он определится, поиск повторится сам.
 */
const GEO_GRACE_MS = 1500;
const DEFAULT_SORT: SortOption = 'rating_desc';

type CitySource = 'user' | 'geo' | 'none';
/** Объявления целиком или отдельные позиции прайсов — для сравнения цен. */
type Mode = 'listings' | 'items';
type Row = ProviderCardData | ItemSearchRow;
type IconName = keyof typeof Icon.glyphMap;

/** Короче сервер текст не ищет: по одной букве совпало бы всё подряд. */
const QUERY_MIN = 2;
/** Пауза после набора, прежде чем искать: не слать запрос на каждую букву. */
const QUERY_DEBOUNCE_MS = 400;

const isItemRow = (row: Row): row is ItemSearchRow => 'item' in row;
const guidOf = (row: Row) => (isItemRow(row) ? row.item.guid : row.provider.guid);

/**
 * Главная вкладка: поиск стройматериалов (магазины) и строительных бригад.
 *
 * Весь экран — один список: приветствие, вид, строка поиска, категории и
 * фильтры лежат в его заголовке. Так список остаётся единственной прокруткой
 * экрана, и системная панель вкладок сворачивается при прокрутке, а нажатие
 * на вкладку возвращает наверх.
 *
 * С текстом поиска можно переключиться на «Сравнить цены»: тогда в списке
 * не объявления, а совпавшие позиции прайсов всех магазинов, дешёвые сверху.
 */
export default function SearchScreen() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const lang = useLang();
  // По имени — только того, кто закончил вход: у не принявшего условия
  // остальной экран гостевой, и приветствие по имени с ним спорило бы.
  const authed = useIsAuthed();
  const userName = useAuthStore((s) => (authed ? (s.user?.full_name ?? null) : null));

  const [kind, setKind] = useState<ListingKind>('material');
  const [categories, setCategories] = useState<Category[]>([]);
  // null — все категории выбранного вида.
  const [category, setCategory] = useState<Category | null>(null);
  const categoryId = category?.id ?? null;
  const categoryCode = category?.code ?? null;
  const kindCategories = categories.filter((c) => c.kind === kind);

  // draft — то, что в поле сейчас; query — что уже ушло в поиск.
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('listings');
  const canCompare = query.length >= QUERY_MIN;
  // Без текста сравнивать нечего: режим остаётся выбранным, но не действует,
  // и вернётся сам, когда человек снова что-то наберёт.
  const effectiveMode: Mode = canCompare ? mode : 'listings';

  const [cities, setCities] = useState<City[]>([]);
  const [attrTypes, setAttrTypes] = useState<ProviderAttrType[]>([]);

  const [city, setCity] = useState<City | null>(null);
  const [citySource, setCitySource] = useState<CitySource>('none');
  const [showNoCityBanner, setShowNoCityBanner] = useState(false);
  // Состояние, а не ref: поиск ждёт, пока город определится, и должен
  // запуститься, когда это случится.
  const [citySettled, setCitySettled] = useState(false);

  const [priceMax, setPriceMax] = useState<number | null>(null);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [sort, setSort] = useState<SortOption>(DEFAULT_SORT);

  const [cityOpen, setCityOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  // true с самого начала: до первого ответа «ничего не найдено» показывать
  // рано — ещё грузятся справочники и определяется город.
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // message: null — ошибка без текста от сервера. Общий текст подставляется
  // при показе: тогда поиску не нужен t, и смена языка его не перезапускает.
  const [error, setError] = useState<{ message: string | null } | null>(null);

  const favGuids = useFavoritesStore((s) => s.guids);
  const toggleFav = useFavoritesStore((s) => s.toggleProvider);
  const requireAuth = useRequireAuth();

  // Номер последнего запроса. Ответы приходят не по порядку: без сверки
  // медленный ответ по прошлому фильтру затирал бы счётчик и страницы нового.
  const requestSeq = useRef(0);
  const listRef = useRef<FlatList<Row>>(null);
  // Следующая страница не загрузилась. Вертушка внизу меняет высоту списка,
  // и список сам зовёт onEndReached ещё раз — без сети это бесконечный круг
  // запросов. Повторяем только по новому движению пальцем.
  const moreFailed = useRef(false);
  const citiesBusy = useRef(false);
  // Человек сам выбрал город или «Все города». Геолокация может ответить
  // уже после этого — и не должна затирать его выбор.
  const cityTouched = useRef(false);

  const loadCategories = useCallback(async () => {
    try {
      const { items } = await dictsApi.categories();
      setCategories(items);
    } catch {
      // Без категорий поиск всё равно работает — по виду целиком.
    }
  }, []);

  const loadCities = useCallback(async () => {
    if (citiesBusy.current) return;
    citiesBusy.current = true;
    try {
      const citiesResp = await dictsApi.cities();
      setCities(citiesResp.items);

      // Город, выбранный руками, важнее геолокации: её тогда и не спрашиваем.
      const savedRaw = await secureGet(SAVED_CITY_KEY);
      const savedId = savedRaw ? intOrNull(savedRaw) : null;
      const saved = citiesResp.items.find((x) => x.id === savedId);
      if (saved) {
        setCity(saved);
        setCitySource('user');
        return;
      }

      // Геолокацию до конца не дожидаемся: без «последнего места» свежие
      // координаты в помещении идут до GEO_TIMEOUT_MS, и всё это время, при
      // каждом запуске, на экране была бы одна вертушка.
      const detection = detectCity(citiesResp.items).then((detected) => {
        if (cityTouched.current) return;
        if (detected.city) {
          setCity(detected.city);
          setCitySource('geo');
          // Город мог прийти уже после первого поиска: выдача сменится под
          // человеком, поэтому возвращаем его наверх, к подсказке о городе.
          listRef.current?.scrollToOffset({ offset: 0, animated: false });
        } else if (detected.outside) {
          setShowNoCityBanner(true);
        }
      });
      await withTimeout(detection, GEO_GRACE_MS);
    } catch {
      // Справочники не пришли. Ошибку покажет сам поиск, а справочники
      // запросим ещё раз, когда человек потянет список.
    } finally {
      citiesBusy.current = false;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.all([loadCategories(), loadCities()]);
      setCitySettled(true);
    })();
  }, [loadCategories, loadCities]);

  // Текст уходит в поиск после паузы в наборе.
  useEffect(() => {
    const next = draft.trim();
    if (next === query) return;
    const timer = setTimeout(() => setQuery(next), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, query]);

  // Атрибуты («доставка», «гарантия»…) свои у каждого вида и категории.
  useEffect(() => {
    // Сразу чистим: иначе в фильтрах до ответа висели бы теги прошлой категории.
    setAttrTypes([]);
    if (!categoryCode) return;
    let stale = false;
    dictsApi
      .providerAttrTypes(categoryCode)
      .then((resp) => {
        if (!stale) setAttrTypes(resp.items);
      })
      .catch(() => {
        // Без тегов фильтры просто короче — это не ошибка для человека.
      });
    return () => {
      stale = true;
    };
  }, [categoryCode]);

  const cityId = city?.id;

  const doSearch = useCallback(
    async (pageToLoad: number) => {
      const seq = ++requestSeq.current;
      const replace = pageToLoad === 1;
      if (replace) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const common = {
          kind,
          category_id: categoryId ?? undefined,
          city_id: cityId,
          price_max: priceMax ?? undefined,
          sort,
          page: pageToLoad,
          page_size: PAGE_SIZE,
        };
        const resp =
          effectiveMode === 'items'
            ? await searchApi.items({ ...common, q: query })
            : await searchApi.providers({
                ...common,
                q: query || undefined,
                attr_ids: tagIds.length ? tagIds : undefined,
              });
        if (seq !== requestSeq.current) return;
        const next: Row[] = resp.items;
        setRows((prev) => (replace ? next : appendNew(prev, next)));
        setTotal(resp.total);
        setPage(resp.page);
        setHasMore(resp.page * resp.page_size < resp.total);
        moreFailed.current = false;
      } catch (e) {
        if (seq !== requestSeq.current) return;
        setError({ message: e instanceof ApiError ? e.message : null });
        if (!replace) moreFailed.current = true;
      } finally {
        // Флажки снимает только последний запрос: устаревший погасил бы
        // вертушку, пока идёт тот, что его сменил.
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
          setRefreshing(false);
        }
      }
    },
    [kind, categoryId, cityId, priceMax, sort, effectiveMode, query, tagIds],
  );

  // Любая смена фильтра меняет doSearch — и поиск начинается с первой страницы.
  useEffect(() => {
    if (!citySettled) return;
    void doSearch(1);
  }, [citySettled, doSearch]);

  const reload = () => {
    // Справочники, не пришедшие при запуске (не было сети), иначе остались бы
    // пустыми до перезапуска приложения: вкладка не размонтируется.
    if (categories.length === 0) void loadCategories();
    if (cities.length === 0) void loadCities();
    void doSearch(1);
  };

  const onRefresh = () => {
    // Город ещё определяется: поиск без него пришлось бы тут же повторять.
    if (!citySettled) return;
    setRefreshing(true);
    reload();
  };

  const loadMore = () => {
    if (loading || loadingMore || !hasMore) return;
    void doSearch(page + 1);
  };

  const onEndReached = () => {
    if (!moreFailed.current) loadMore();
  };

  // Повтор неудавшейся страницы. Сам список второй раз onEndReached не
  // позовёт: для этой высоты содержимого он его уже звал, а человек стоит в
  // самом низу и дальше прокрутить не может.
  const onScrollBeginDrag = () => {
    if (!moreFailed.current) return;
    moreFailed.current = false;
    loadMore();
  };

  const onSelectCity = (next: City) => {
    cityTouched.current = true;
    setCity(next);
    setCitySource('user');
    setShowNoCityBanner(false);
    // Не сохранилось — город всё равно выбран до конца запуска, а ошибка
    // хранилища человеку ничего не скажет.
    secureSet(SAVED_CITY_KEY, String(next.id)).catch(() => {});
  };

  // «Все города»: снимаем город и забываем сохранённый, иначе при
  // следующем запуске он вернулся бы сам.
  const onClearCity = () => {
    cityTouched.current = true;
    setCity(null);
    setCitySource('user');
    setShowNoCityBanner(false);
    secureDelete(SAVED_CITY_KEY).catch(() => {});
  };

  /** Новая выдача вместо старой: чистим список и показываем вертушку. */
  const resetResults = () => {
    // Ответ по прежнему фильтру, если он ещё в пути, больше не нужен: успей
    // он до нового запроса — лёг бы в только что очищенный список.
    requestSeq.current += 1;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    setRows([]);
    setTotal(0);
    setPage(1);
    setHasMore(false);
    // Поиск стартует в эффекте, кадром позже: без этого между очисткой списка
    // и вертушкой мелькнуло бы «ничего не найдено».
    setLoading(true);
  };

  const onSelectKind = (next: ListingKind) => {
    if (next === kind) return;
    resetResults();
    setKind(next);
    setCategory(null);
    // Теги у магазинов и бригад разные, а цены несравнимы.
    setPriceMax(null);
    setTagIds([]);
  };

  // Повторное нажатие на выбранную категорию снимает её — снова весь вид.
  const onSelectCategory = (next: Category) => {
    resetResults();
    setCategory((current) => (current?.id === next.id ? null : next));
    setTagIds([]);
  };

  const onSelectMode = (next: Mode) => {
    if (next === mode) return;
    resetResults();
    setMode(next);
    // Сравнивают цены — значит, дешёвые сверху; объявления — лучшие сверху.
    setSort(next === 'items' ? 'price_asc' : DEFAULT_SORT);
  };

  // «Найти» на клавиатуре — искать сразу, не дожидаясь паузы.
  const onSubmitQuery = () => setQuery(draft.trim());

  const onApplyFilters = (value: FiltersValue) => {
    setPriceMax(value.priceMax);
    // Шторка каждый раз отдаёт новый массив. Тот же набор тегов оставляем
    // прежним массивом, иначе «Применить» без изменений перезапускал бы поиск.
    setTagIds((prev) => (sameIds(prev, value.tagIds) ? prev : value.tagIds));
    setSort(value.sort);
  };

  const renderItem: ListRenderItem<Row> = useCallback(
    ({ item }) => {
      if (isItemRow(item)) {
        return (
          <ItemRow
            row={item}
            onPress={() =>
              pushOnce({ pathname: '/provider', params: { providerGuid: item.provider.guid } })
            }
          />
        );
      }
      // Состояние избранного для действия читаем в момент нажатия, а не из
      // замыкания: после входа через шторку действие выполняется позже, когда
      // избранное вошедшего уже могло загрузиться.
      const nowFav = (guid: string) => useFavoritesStore.getState().isFav(guid);
      const guid = item.provider.guid;
      return (
        <ProviderCard
          item={item}
          isFavorite={favGuids.has(guid)}
          onToggleFavorite={() => requireAuth('favorite', () => void toggleFav(guid, !nowFav(guid)))}
          onPress={() => pushOnce({ pathname: '/provider', params: { providerGuid: guid } })}
        />
      );
    },
    [favGuids, requireAuth, toggleFav],
  );

  const keyExtractor = useCallback((row: Row) => guidOf(row), []);

  const filtersValue: FiltersBarValue = {
    city,
    priceMax,
    tagCount: tagIds.length,
  };

  const firstName = userName?.trim().split(/\s+/)[0] || null;
  const hasExtraFilters = !!priceMax || tagIds.length > 0;
  // При обновлении жестом вертушку показывает сам список — вторая ни к чему.
  const firstLoad = loading && !refreshing && rows.length === 0;
  const errorText = error ? (error.message ?? t('common.error_generic')) : null;

  const header = (
    <View style={styles.header}>
      <ScreenTitle
        subtitle={firstName ? t('search.greeting', { name: firstName }) : t('search.greeting_guest')}
        title={t('search.plan_title')}
        action={
          <Pressable
            onPress={() => setFiltersOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t('filters.title')}
            accessibilityState={{ selected: hasExtraFilters }}
            style={({ pressed }) => [styles.filterButton, pressed && styles.dim]}
          >
            <Icon name="tune-variant" size={22} color={colors.text} />
            {hasExtraFilters ? <View style={styles.filterDot} /> : null}
          </Pressable>
        }
      />

      <Segment
        value={kind}
        options={KINDS.map((k) => ({ value: k, label: t(KIND_KEY[k]) }))}
        onChange={onSelectKind}
      />

      <Input
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={onSubmitQuery}
        placeholder={
          kind === 'material' ? t('search.query_placeholder_material') : t('search.query_placeholder_service')
        }
        accessibilityLabel={t('search.query_label')}
        returnKeyType="search"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />

      {canCompare ? (
        <Segment
          value={mode}
          options={[
            { value: 'listings', label: kind === 'material' ? t('search.mode_shops') : t('search.mode_crews') },
            { value: 'items', label: t('search.mode_compare') },
          ]}
          onChange={onSelectMode}
        />
      ) : null}

      {/* Без категорий ряда нет, а пустая обёртка всё равно забрала бы зазор. */}
      {kindCategories.length > 0 ? (
        <View style={styles.bleed}>
          <CategoryBar categories={kindCategories} selectedId={categoryId} onSelect={onSelectCategory} />
        </View>
      ) : null}
      <View style={styles.bleed}>
        <FiltersBar
          value={filtersValue}
          onCityPress={() => setCityOpen(true)}
          onExtraFilters={() => setFiltersOpen(true)}
        />
      </View>

      <ErrorBanner message={errorText} />
      {showNoCityBanner ? (
        <Notice
          icon="information-outline"
          message={t('search.no_city_nearby')}
          onClose={() => setShowNoCityBanner(false)}
        />
      ) : null}
      {citySource === 'geo' && city ? (
        <Notice
          icon="crosshairs-gps"
          message={t('search.city_detected', { city: dictName(city, lang) })}
          // Город остаётся, пропадает только подсказка: «угаданный» становится
          // обычным выбранным.
          onClose={() => setCitySource('user')}
        />
      ) : null}
      {/* Пока ответа нет — ещё не пришёл или не удался, — «Найдено: 0» было
          бы неправдой. */}
      {firstLoad || (error && rows.length === 0) ? null : (
        <Text style={styles.count}>{t('search.results_count', { count: total })}</Text>
      )}
    </View>
  );

  return (
    <Screen tab>
      <FlatList
        // Ключа у списка нет намеренно: с ним список пересоздавался бы вместе
        // с заголовком, и поле поиска теряло бы фокус посреди набора.
        ref={listRef}
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={TAB_LIST_CONTENT}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        // Поиск не удался — «ничего не найдено» было бы неправдой, а жест
        // «потянуть» на пустом экране не очевиден: нужна кнопка.
        ListEmptyComponent={
          firstLoad ? (
            <View style={styles.firstLoad}>
              <Loader />
            </View>
          ) : error ? (
            <Button label={t('common.retry')} variant="outline" onPress={reload} />
          ) : !loading ? (
            <EmptyState title={t('search.no_results')} subtitle={t('search.no_results_hint')} />
          ) : null
        }
        ListFooterComponent={
          loadingMore ? <ActivityIndicator color={colors.primary} style={styles.more} /> : null
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        onEndReached={onEndReached}
        onEndReachedThreshold={0.4}
        onScrollBeginDrag={onScrollBeginDrag}
      />

      <CityPicker
        visible={cityOpen}
        cities={cities}
        selectedId={city?.id ?? null}
        onSelect={onSelectCity}
        onClear={onClearCity}
        onClose={() => setCityOpen(false)}
      />
      <FiltersSheet
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        // В сравнении цен теги не действуют: сервер ищет по позициям.
        tags={effectiveMode === 'items' ? [] : attrTypes}
        tagsLabel={t('provider.attrs_label')}
        value={{ priceMax, tagIds: tagIds, sort }}
        onApply={onApplyFilters}
      />
    </Screen>
  );
}

/** Позиция прайса в сравнении цен: что, почём, у кого. */
function ItemRow({ row, onPress }: { row: ItemSearchRow; onPress: () => void }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const lang = useLang();
  const price =
    row.item.price !== null
      ? [formatPrice(row.item.price), unitLabel(t, row.item.unit)].filter(Boolean).join(' ')
      : t('provider.price_negotiable');
  const where = [row.provider.name, dictName(row.city, lang)].join(' · ');
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${row.item.name}, ${price}, ${where}`}
      style={({ pressed }) => [styles.itemRow, pressed && styles.dim]}
    >
      <Thumb path={row.main_thumb} size={56} icon="storefront-outline" />
      <View style={styles.itemBody}>
        <Text style={styles.itemName} numberOfLines={2}>
          {row.item.name}
        </Text>
        <Text style={styles.itemWhere} numberOfLines={1}>
          {where}
        </Text>
        {row.rating.count > 0 ? (
          <RatingInline avg={row.rating.avg} count={row.rating.count} accessible={false} />
        ) : null}
      </View>
      <Text style={styles.itemPrice} numberOfLines={2}>
        {price}
      </Text>
    </Pressable>
  );
}

interface NoticeProps {
  icon: IconName;
  message: string;
  onClose: () => void;
}

/** Подсказка про город над результатами, которую можно закрыть. */
function Notice({ icon, message, onClose }: NoticeProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.notice}>
      {/* Иконка — украшение. Сама она — текст из одного значка шрифта, и
          диктор останавливался бы на ней молча. */}
      <Icon
        name={icon}
        size={20}
        color={colors.primary}
        accessible={false}
        importantForAccessibility="no"
      />
      <Text style={styles.noticeText}>{message}</Text>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        style={({ pressed }) => [styles.noticeClose, pressed && styles.dim]}
      >
        <Icon name="close" size={20} color={colors.muted} />
      </Pressable>
    </View>
  );
}

/**
 * Ближайший из наших городов по геолокации.
 * outside — координаты получили, но рядом нет ни одного нашего города.
 * Отказ в доступе, выключенный GPS и истёкшее ожидание — просто «не знаем».
 */
async function detectCity(cities: City[]): Promise<{ city: City | null; outside: boolean }> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return { city: null, outside: false };
    // Сначала место, которое телефон уже знает: оно отдаётся сразу, а чтобы
    // выбрать город, его точности хватает. Свежие координаты просим, только
    // когда его нет, — их можно ждать секундами.
    const position =
      (await Location.getLastKnownPositionAsync({ maxAge: GEO_LAST_KNOWN_MAX_AGE_MS }).catch(
        () => null,
      )) ??
      (await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        GEO_TIMEOUT_MS,
      ));
    if (!position) return { city: null, outside: false };
    const nearest = findNearestCity(
      cities,
      { lat: position.coords.latitude, lng: position.coords.longitude },
      NEAREST_CITY_KM,
    );
    return nearest ? { city: nearest.city, outside: false } : { city: null, outside: true };
  } catch {
    return { city: null, outside: false };
  }
}

/** Результат промиса или null, если он не успел за отведённое время. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

/**
 * Дописать страницу, пропустив уже показанное. Пока человек листает, в
 * выдаче появляются новые объявления и сдвигают страницы: одна и та же
 * карточка приходит дважды, а два одинаковых ключа ломают список.
 */
function appendNew<T extends Row>(prev: T[], next: T[]): T[] {
  const seen = new Set(prev.map(guidOf));
  return [...prev, ...next.filter((row) => !seen.has(guidOf(row)))];
}

const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((id) => b.includes(id));

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    header: { gap: space.gap },
    // Ряды категорий и фильтров идут от края до края экрана: отступ страницы
    // у них внутри прокрутки, а отступ списка мешал бы — обрезал бы плитки.
    bleed: { marginHorizontal: -space.page },
    filterButton: {
      width: 44,
      height: 44,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.inner,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.outline,
    },
    filterDot: {
      position: 'absolute',
      top: 8,
      right: 8,
      width: 8,
      height: 8,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    dim: { opacity: 0.6 },
    notice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingLeft: 12,
      borderRadius: radius.inner,
      backgroundColor: `${colors.primary}22`,
    },
    noticeText: {
      flex: 1,
      minWidth: 0,
      paddingVertical: 10,
      fontSize: text.caption,
      color: colors.text,
    },
    // Крестик маленький, а попадать в него надо пальцем: зона 44 на всю
    // высоту подсказки.
    noticeClose: {
      width: 44,
      minHeight: 44,
      flexShrink: 0,
      alignSelf: 'stretch',
      alignItems: 'center',
      justifyContent: 'center',
    },
    count: { fontSize: text.caption, color: colors.muted },
    firstLoad: { flexGrow: 1, minHeight: 160, justifyContent: 'center' },
    more: { paddingVertical: 12 },
    itemRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.gap,
      padding: 12,
      borderRadius: radius.card,
      backgroundColor: colors.card,
    },
    itemBody: { flex: 1, minWidth: 0, gap: 2 },
    itemName: { fontSize: text.body, fontWeight: '600', color: colors.text },
    itemWhere: { fontSize: text.caption, color: colors.muted },
    itemPrice: {
      flexShrink: 0,
      maxWidth: 130,
      textAlign: 'right',
      fontSize: text.body,
      fontWeight: '700',
      color: colors.text,
    },
  });
