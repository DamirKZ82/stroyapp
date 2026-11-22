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
  Amenity,
  Category,
  City,
  HallCardData,
  ProviderAttrType,
  ProviderCardData,
} from '@/api/types';
import { Button } from '@/components/Button';
import { CategoryBar } from '@/components/CategoryBar';
import { CityPicker } from '@/components/CityPicker';
import { DatePickerSheet } from '@/components/DatePickerSheet';
import { EmptyState, ErrorBanner, Loader } from '@/components/Feedback';
import { FiltersBar, type FiltersBarValue } from '@/components/FiltersBar';
import { FiltersSheet, type FiltersValue, type SortOption } from '@/components/FiltersSheet';
import { GuestsPicker } from '@/components/GuestsPicker';
import { HallCard } from '@/components/HallCard';
import { ProviderCard } from '@/components/ProviderCard';
import { Screen, ScreenTitle, TAB_LIST_CONTENT } from '@/components/Screen';
import { useAuthStore } from '@/store/authStore';
import { useFavoritesStore } from '@/store/favoritesStore';
import { secureDelete, secureGet, secureSet } from '@/store/secureStorage';
import { useIsAuthed, useRequireAuth } from '@/store/useRequireAuth';
import { radius, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { isVenueCategory } from '@/utils/category';
import { findNearestCity } from '@/utils/cityCoords';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { pushOnce } from '@/utils/nav';
import { intOrNull } from '@/utils/number';

const PAGE_SIZE = 20;
// Ключ остался от прежнего названия приложения. Переименовать — значит
// потерять выбранный город у всех, кто уже пользуется приложением.
const SAVED_CITY_KEY = 'toyhana.selectedCityId';
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
type Row = HallCardData | ProviderCardData;
type IconName = keyof typeof Icon.glyphMap;

const isHall = (row: Row): row is HallCardData => 'hall' in row;
const guidOf = (row: Row) => (isHall(row) ? row.hall.guid : row.provider.guid);

/**
 * Главная вкладка: поиск залов и исполнителей.
 *
 * Весь экран — один список: приветствие, категории и фильтры лежат в его
 * заголовке. Так список остаётся единственной прокруткой экрана, и системная
 * панель вкладок сворачивается при прокрутке, а нажатие на вкладку
 * возвращает наверх — с отдельной шапкой над списком система этого не умеет.
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

  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState<Category | null>(null);
  // Категории нет (сервер без /dicts/categories или не было сети) — экран
  // работает как раньше: поиск залов.
  const providerCategory = category && !isVenueCategory(category) ? category : null;
  const isRestaurant = !providerCategory;
  const providerCategoryId = providerCategory?.id ?? null;
  const providerCategoryCode = providerCategory?.code ?? null;

  const [cities, setCities] = useState<City[]>([]);
  const [amenities, setAmenities] = useState<Amenity[]>([]);
  const [attrTypes, setAttrTypes] = useState<ProviderAttrType[]>([]);

  const [city, setCity] = useState<City | null>(null);
  const [citySource, setCitySource] = useState<CitySource>('none');
  const [showNoCityBanner, setShowNoCityBanner] = useState(false);
  // Состояние, а не ref: поиск ждёт, пока город определится, и должен
  // запуститься, когда это случится. Ref перерисовки не вызывает — без
  // города (геолокация запрещена или человек вне Казахстана) поиск не
  // стартовал бы вовсе.
  const [citySettled, setCitySettled] = useState(false);

  const [date, setDate] = useState<string | null>(null);
  const [guests, setGuests] = useState<number | null>(null);
  const [priceMax, setPriceMax] = useState<number | null>(null);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [sort, setSort] = useState<SortOption>(DEFAULT_SORT);

  const [cityOpen, setCityOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [hallItems, setHallItems] = useState<HallCardData[]>([]);
  const [provItems, setProvItems] = useState<ProviderCardData[]>([]);
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
  const toggleFav = useFavoritesStore((s) => s.toggle);
  const toggleProviderFav = useFavoritesStore((s) => s.toggleProvider);
  const requireAuth = useRequireAuth();

  // Номер последнего запроса. Ответы приходят не по порядку: без сверки
  // медленный ответ по прошлой категории затирал бы счётчик и страницы новой.
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

  // Категории грузим отдельно от остальных справочников: если их нет, экран
  // всё равно остаётся поиском залов, а не пустым.
  const loadCategories = useCallback(async () => {
    try {
      const { items } = await dictsApi.categories();
      if (items.length === 0) return;
      setCategories(items);
      // Уже выбранную не трогаем: загрузка может быть повторной.
      setCategory((current) => current ?? items.find((x) => isVenueCategory(x)) ?? items[0]);
    } catch {
      // Остаёмся без категорий — category = null, ищем залы.
    }
  }, []);

  const loadCities = useCallback(async () => {
    if (citiesBusy.current) return;
    citiesBusy.current = true;
    try {
      const [citiesResp, amenitiesResp] = await Promise.all([
        dictsApi.cities(),
        dictsApi.amenities(),
      ]);
      setCities(citiesResp.items);
      setAmenities(amenitiesResp.items);

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
      // По очереди, а не разом: первый поиск должен знать и категорию, и город.
      await loadCategories();
      await loadCities();
      setCitySettled(true);
    })();
  }, [loadCategories, loadCities]);

  // Атрибуты исполнителя — свои у каждой категории, кроме ресторанов.
  useEffect(() => {
    // Сразу чистим: иначе в фильтрах до ответа висели бы теги прошлой категории.
    setAttrTypes([]);
    if (!providerCategoryCode) return;
    let stale = false;
    dictsApi
      .providerAttrTypes(providerCategoryCode)
      .then((resp) => {
        if (!stale) setAttrTypes(resp.items);
      })
      .catch(() => {
        // Без тегов фильтры просто короче — это не ошибка для человека.
      });
    return () => {
      stale = true;
    };
  }, [providerCategoryCode]);

  // Гости — фильтр только залов. Для исполнителей число в запрос не идёт,
  // поэтому и перезапускать их поиск из-за него незачем.
  const hallGuests = isRestaurant ? guests : null;
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
          city_id: cityId,
          date: date ?? undefined,
          price_max: priceMax ?? undefined,
          sort,
          page: pageToLoad,
          page_size: PAGE_SIZE,
        };
        if (providerCategoryId !== null) {
          const resp = await searchApi.providers({
            ...common,
            category_id: providerCategoryId,
            attr_ids: tagIds.length ? tagIds : undefined,
          });
          if (seq !== requestSeq.current) return;
          setProvItems((prev) => (replace ? resp.items : appendNew(prev, resp.items)));
          setTotal(resp.total);
          setPage(resp.page);
          setHasMore(resp.page * resp.page_size < resp.total);
        } else {
          const resp = await searchApi.halls({
            ...common,
            guests: hallGuests ?? undefined,
            amenity_ids: tagIds.length ? tagIds : undefined,
          });
          if (seq !== requestSeq.current) return;
          setHallItems((prev) => (replace ? resp.items : appendNew(prev, resp.items)));
          setTotal(resp.total);
          setPage(resp.page);
          setHasMore(resp.page * resp.page_size < resp.total);
        }
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
    [providerCategoryId, cityId, date, hallGuests, priceMax, tagIds, sort],
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

  const onSelectCategory = (next: Category) => {
    if (next.id === category?.id) return;
    // Ответ по прежней категории, если он ещё в пути, больше не нужен: успей
    // он до нового запроса — лёг бы в только что очищенный список.
    requestSeq.current += 1;
    setCategory(next);
    // Список один на все категории и не пересоздаётся, поэтому наверх
    // возвращаем его сами: на iOS положение прокрутки не всегда поправляется,
    // когда содержимое стало короче, и список остался бы сдвинутым.
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    setHallItems([]);
    setProvItems([]);
    setTotal(0);
    setPage(1);
    setHasMore(false);
    // У другой категории свои теги, цены и смысл сортировки — фильтры,
    // кроме города и даты, начинаются заново.
    setPriceMax(null);
    setTagIds([]);
    setGuests(null);
    setSort(DEFAULT_SORT);
    // Поиск стартует в эффекте, кадром позже: без этого между очисткой списка
    // и вертушкой мелькнуло бы «ничего не найдено».
    setLoading(true);
  };

  const onApplyFilters = (value: FiltersValue) => {
    setPriceMax(value.priceMax);
    // Шторка каждый раз отдаёт новый массив. Тот же набор тегов оставляем
    // прежним массивом, иначе «Применить» без изменений перезапускал бы поиск.
    setTagIds((prev) => (sameIds(prev, value.amenityIds) ? prev : value.amenityIds));
    setSort(value.sort);
  };

  const rows: Row[] = isRestaurant ? hallItems : provItems;
  const showAvailability = !!date;

  const renderItem: ListRenderItem<Row> = useCallback(
    ({ item }) => {
      // Состояние избранного для действия читаем в момент нажатия, а не из
      // замыкания: после входа через шторку действие выполняется позже, когда
      // избранное вошедшего уже могло загрузиться.
      const nowFav = (guid: string) => useFavoritesStore.getState().isFav(guid);
      if (isHall(item)) {
        const guid = item.hall.guid;
        return (
          <HallCard
            item={item}
            isFavorite={favGuids.has(guid)}
            showAvailability={showAvailability}
            onToggleFavorite={() => requireAuth('favorite', () => void toggleFav(guid, !nowFav(guid)))}
            onPress={() => pushOnce({ pathname: '/hall', params: { hallGuid: guid } })}
          />
        );
      }
      const guid = item.provider.guid;
      return (
        <ProviderCard
          item={item}
          isFavorite={favGuids.has(guid)}
          showAvailability={showAvailability}
          onToggleFavorite={() =>
            requireAuth('favorite', () => void toggleProviderFav(guid, !nowFav(guid)))
          }
          onPress={() => pushOnce({ pathname: '/provider', params: { providerGuid: guid } })}
        />
      );
    },
    [favGuids, showAvailability, requireAuth, toggleFav, toggleProviderFav],
  );

  const keyExtractor = useCallback((row: Row) => guidOf(row), []);

  const filtersValue: FiltersBarValue = {
    city,
    date,
    guests: hallGuests,
    priceMax,
    amenityCount: tagIds.length,
  };

  const firstName = userName?.trim().split(/\s+/)[0] || null;
  // Точка на кнопке — про то, что задано в шторке фильтров (цена и теги):
  // дата и гости и так видны залитыми чипами в ряду ниже.
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

      {/* Без категорий ряда нет, а пустая обёртка всё равно забрала бы зазор. */}
      {categories.length > 0 ? (
        <View style={styles.bleed}>
          <CategoryBar
            categories={categories}
            selectedId={category?.id ?? null}
            onSelect={onSelectCategory}
          />
        </View>
      ) : null}
      <View style={styles.bleed}>
        <FiltersBar
          value={filtersValue}
          onCityPress={() => setCityOpen(true)}
          onDatePress={() => setDateOpen(true)}
          onGuestsPress={() => setGuestsOpen(true)}
          onExtraFilters={() => setFiltersOpen(true)}
          showGuests={isRestaurant}
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
        // Ключа «залы / исполнители» у списка нет намеренно. С ним список
        // пересоздавался бы вместе с заголовком, а в заголовке — ряд
        // категорий: он терял прокрутку вбок, и после выбора плитки за краем
        // экрана ряд отскакивал к началу, пряча выбранную. Пересоздавать и
        // нечего: при смене категории строки очищаются, а ключи строк — guid.
        ref={listRef}
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={TAB_LIST_CONTENT}
        ListHeaderComponent={header}
        // Поиск не удался — «ничего не найдено» было бы неправдой, а жест
        // «потянуть» на пустом экране не очевиден: нужна кнопка. Повтор без
        // refreshing — на месте кнопки встаёт вертушка первой загрузки.
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
      <DatePickerSheet
        visible={dateOpen}
        value={date}
        onChange={setDate}
        onClose={() => setDateOpen(false)}
      />
      <GuestsPicker
        visible={guestsOpen}
        value={guests}
        onChange={setGuests}
        onClose={() => setGuestsOpen(false)}
      />
      <FiltersSheet
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        amenities={isRestaurant ? amenities : attrTypes}
        amenitiesLabel={isRestaurant ? undefined : t('provider.attrs_label')}
        value={{ priceMax, amenityIds: tagIds, sort }}
        onApply={onApplyFilters}
      />
    </Screen>
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
  });
