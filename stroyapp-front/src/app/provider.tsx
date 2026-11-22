import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, chatsApi, providersApi, reviewsApi } from '@/api';
import type { PriceItem, PublicProviderDetails, Review, ReviewsResponse } from '@/api/types';
import { Button } from '@/components/Button';
import { Card, Row, RowGroup, SectionLabel } from '@/components/Card';
import { Chip, ChipWrap } from '@/components/Chip';
import { FavoriteHeart } from '@/components/FavoriteHeart';
import { ErrorBanner, Loader } from '@/components/Feedback';
import { PhotoGallery } from '@/components/PhotoGallery';
import { RatingInline } from '@/components/RatingInline';
import { ReviewList } from '@/components/ReviewList';
import { Screen } from '@/components/Screen';
import { useFavoritesStore } from '@/store/favoritesStore';
import { useRequireAuth } from '@/store/useRequireAuth';
import { space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { formatPrice } from '@/utils/format';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { callPhone, openRouteIn2Gis } from '@/utils/links';
import { formatKzPhoneDisplay } from '@/utils/phone';
import { pushOnce, useOnTop } from '@/utils/nav';
import { unitLabel } from '@/utils/priceUnit';

/** Столько позиций прайса видно сразу, остальные — по кнопке. */
const ITEMS_PREVIEW = 15;

/**
 * Карточка магазина или бригады — то, что видит клиент: прайс, описание,
 * контакты, отзывы.
 *
 * Прокрутка своя, а не <Screen scroll>: у того отступы по краям, а фото
 * здесь идут от края до края экрана.
 */
export default function ProviderScreen() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const lang = useLang();
  const { providerGuid, fromChat } = useLocalSearchParams<{ providerGuid?: string; fromChat?: string }>();

  const [provider, setProvider] = useState<PublicProviderDetails | null>(null);
  const [reviews, setReviews] = useState<ReviewsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Храним не готовый текст, а только сообщение сервера (null — причина
  // неизвестна): общий текст подставляется при отрисовке. Иначе t попадает в
  // зависимости загрузки, а язык меняется при входе (шторка входа ставит язык
  // из профиля) — и карточка перезапрашивалась бы с вертушкой прямо под ней.
  const [failure, setFailure] = useState<{ message: string | null } | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [allItems, setAllItems] = useState(false);

  const isFav = useFavoritesStore((s) => (providerGuid ? s.guids.has(providerGuid) : false));
  const toggleProviderFav = useFavoritesStore((s) => s.toggleProvider);
  const requireAuth = useRequireAuth();

  // Номер последнего запроса: ответ более раннего (потянули обновить дважды,
  // сменился guid) не должен затирать более свежие данные.
  const requestId = useRef(0);
  // Замок, а не только chatBusy: состояние доходит до кнопки со следующей
  // отрисовкой, и быстрое двойное нажатие открыло бы чат дважды.
  const chatLock = useRef(false);
  // Перед глазами ли экран. Чат открывается запросом, и пока он идёт, человек
  // может уйти назад или нажать «Забронировать»: без этой проверки чат (или
  // окно с ошибкой) выскочил бы уже поверх другого экрана. Шторка входа и
  // просмотр фото — не экраны, с ними фокус остаётся здесь.
  const onTop = useOnTop();

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      const id = ++requestId.current;
      if (!providerGuid) {
        setFailure({ message: null });
        setLoading(false);
        return;
      }
      if (mode === 'refresh') {
        setRefreshing(true);
      } else {
        setLoading(true);
        setProvider(null);
        setReviews(null);
      }
      setFailure(null);
      try {
        const [providerAnswer, reviewsAnswer] = await Promise.all([
          providersApi.getPublic(providerGuid),
          reviewsApi.listProvider(providerGuid),
        ]);
        if (id !== requestId.current) return;
        setProvider(providerAnswer.provider);
        setReviews(reviewsAnswer);
      } catch (e) {
        if (id !== requestId.current) return;
        setFailure({ message: e instanceof ApiError ? e.message : null });
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [providerGuid],
  );

  useEffect(() => {
    void load('initial');
    // Экран закрыли раньше ответа: сдвигаем номер, и ответ отбрасывается как
    // устаревший.
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  const error = failure ? (failure.message ?? t('common.error_generic')) : null;

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: true, title: '' }} />
        <Loader />
      </Screen>
    );
  }

  if (!provider) {
    return (
      <Screen scroll>
        <Stack.Screen options={{ headerShown: true, title: '' }} />
        <ErrorBanner message={error ?? t('common.error_generic')} />
        {/* Без guid повторять нечего: экран открыли по неполному адресу. */}
        {providerGuid ? (
          <Button label={t('common.retry')} variant="outline" onPress={() => void load('initial')} />
        ) : null}
      </Screen>
    );
  }

  const guid = provider.guid;

  // !isFav берём в момент нажатия, а не после входа: гость нажал пустое
  // сердце, чтобы добавить, — и после входа объявление должно добавиться,
  // даже если избранное аккаунта к этому мигу уже подгрузилось.
  const toggleFavorite = () =>
    requireAuth('favorite', () => {
      void toggleProviderFav(guid, !isFav);
    });

  const openChat = () =>
    requireAuth('message', async () => {
      if (chatLock.current) return;
      chatLock.current = true;
      setChatBusy(true);
      try {
        const answer = await chatsApi.openWithProvider(guid);
        if (!onTop.current) return;
        // Карточку открыли из этого же чата: класть его второй копией поверх
        // не нужно — он уже лежит под карточкой, достаточно вернуться.
        if (fromChat && answer.chat_guid === fromChat) {
          router.back();
        } else {
          pushOnce({ pathname: '/chat', params: { chatGuid: answer.chat_guid } });
        }
      } catch (e) {
        // Раньше ошибка глоталась, и кнопка «Написать» просто ничего не делала.
        if (onTop.current) Alert.alert(e instanceof ApiError ? e.message : t('common.error_generic'));
      } finally {
        chatLock.current = false;
        setChatBusy(false);
      }
    });

  // С позиции прайса — заявка уже с её названием: остаётся дописать количество.
  const book = (item?: PriceItem) =>
    requireAuth('book', () => {
      pushOnce({
        pathname: '/booking-form',
        params: item ? { providerGuid: guid, initialComment: `${item.name} — ` } : { providerGuid: guid },
      });
    });

  // Жалоба — только от вошедшего: у неё должен быть автор. Название идёт
  // параметром, чтобы форма показала, на что она.
  const report = () =>
    requireAuth('generic', () => {
      pushOnce({
        pathname: '/report',
        params: { targetType: 'provider', targetGuid: guid, subjectName: provider.name },
      });
    });
  const reportReview = (review: Review) =>
    requireAuth('generic', () => {
      pushOnce({
        pathname: '/report',
        params: { targetType: 'review', targetGuid: review.guid, subjectName: review.client_name },
      });
    });

  // «Цена от» — как в поиске: самая дешёвая позиция прайса, а без прайса —
  // цена, которую продавец указал сам. Иначе карточка с ценами в прайсе
  // писала бы «Цена договорная», а поиск — «от 120 ₸».
  const cheapest = provider.items.reduce<PriceItem | null>(
    (best, it) => (it.price != null && (best?.price == null || it.price < best.price) ? it : best),
    null,
  );
  const priceFrom = cheapest?.price ?? provider.price_from;
  const unit = unitLabel(t, cheapest ? cheapest.unit : provider.price_unit);
  // Длинный прайс целиком растянул бы карточку на десятки экранов: сначала
  // начало, остальное по кнопке.
  const shownItems = allItems ? provider.items : provider.items.slice(0, ITEMS_PREVIEW);
  const { phone, latitude, longitude } = provider;
  // Проверка на истинность, а не на null: ноль тоже считаем «координат
  // нет» — точки 0,0 в Казахстане не бывает, а маршрут в океан не нужен.
  const coords = latitude && longitude ? { latitude, longitude } : null;

  return (
    <Screen
      footer={
        <>
          <Button
            label={t('listing.chat_button')}
            variant="outline"
            busy={chatBusy}
            onPress={openChat}
            style={styles.chatButton}
          />
          <Button label={t('listing.book_button')} onPress={() => book()} style={styles.bookButton} />
        </>
      }
    >
      <Stack.Screen options={{ headerShown: true, title: provider.name }} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      >
        <View>
          <PhotoGallery photos={provider.photos} />
          {/* Сердце — сосед галереи, а не её ребёнок: нажатие на него не
              должно открывать фото на весь экран. */}
          <FavoriteHeart isFavorite={isFav} onPress={toggleFavorite} />
        </View>

        <View style={styles.body}>
          {/* Обновление не удалось, но старые данные есть — показываем их,
              а не пустой экран с ошибкой. */}
          <ErrorBanner message={error} />

          <View style={styles.head}>
            <Text style={styles.name}>{provider.name}</Text>
            {provider.verified ? (
              // Значок скрыт от диктора: подпись рядом говорит то же словами.
              <View style={styles.verified}>
                <Icon
                  name="check-decagram"
                  size={18}
                  color={colors.success}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                />
                <Text style={styles.verifiedText}>{t('provider.verified_long')}</Text>
              </View>
            ) : null}
            <Text style={styles.sub}>
              {`${dictName(provider.category, lang)} · ${dictName(provider.city, lang)}`}
            </Text>
            {provider.address ? (
              <Text style={styles.sub} selectable>
                {provider.address}
              </Text>
            ) : null}
            {reviews && reviews.reviews_count > 0 ? (
              <RatingInline
                avg={reviews.avg_rating}
                count={reviews.reviews_count}
                style={styles.rating}
              />
            ) : null}
          </View>

          <Card style={styles.priceCard}>
            {priceFrom != null ? (
              <>
                <Text style={styles.price}>{formatPrice(priceFrom)}</Text>
                {/* «от» стоит под ценой, а не перед ней: в казахском оно идёт
                    после числа («50 000 ₸ бастап»), и одной строкой на оба
                    языка это не склеить. */}
                <Text style={styles.priceHint}>
                  {[t('provider.price_from_prefix'), unit].filter(Boolean).join(' · ')}
                </Text>
              </>
            ) : (
              <Text style={styles.noPrice}>
                {[t('provider.price_negotiable'), unit].filter(Boolean).join(' · ')}
              </Text>
            )}
          </Card>

          {provider.items.length > 0 ? (
            <View style={styles.section}>
              <SectionLabel>{t('provider.items_label')}</SectionLabel>
              <RowGroup>
                {shownItems.map((item, index) => {
                  const price =
                    item.price != null
                      ? [formatPrice(item.price), unitLabel(t, item.unit)].filter(Boolean).join(' ')
                      : t('provider.price_negotiable');
                  return (
                    <Row
                      key={item.guid ?? `${index}`}
                      first={index === 0}
                      title={item.name}
                      value={price}
                      // Нажатие — заявка с этой позицией: так быстрее, чем
                      // переписывать название руками.
                      onPress={() => book(item)}
                      accessibilityLabel={`${item.name}, ${price}`}
                    />
                  );
                })}
              </RowGroup>
              {provider.items.length > shownItems.length ? (
                <Button
                  label={t('provider.items_show_all', { count: provider.items.length })}
                  variant="text"
                  small
                  onPress={() => setAllItems(true)}
                />
              ) : null}
            </View>
          ) : null}

          {provider.description ? (
            <View style={styles.section}>
              <SectionLabel>{t('listing.description')}</SectionLabel>
              <Card>
                <Text style={styles.paragraph}>{provider.description}</Text>
              </Card>
            </View>
          ) : null}

          {provider.attrs.length > 0 ? (
            <View style={styles.section}>
              <SectionLabel>{t('provider.attrs_label')}</SectionLabel>
              <ChipWrap>
                {provider.attrs.map((attr) => (
                  <Chip key={attr.id} label={dictName(attr, lang)} />
                ))}
              </ChipWrap>
            </View>
          ) : null}

          {phone || coords ? (
            <View style={styles.section}>
              <SectionLabel>{t('provider.contact_label')}</SectionLabel>
              {phone ? (
                <Button
                  label={formatKzPhoneDisplay(phone)}
                  variant="outline"
                  icon="phone"
                  accessibilityRole="link"
                  // Подпись — одни цифры: диктор не сказал бы, что это телефон.
                  accessibilityLabel={`${t('owner.booking_phone')}: ${formatKzPhoneDisplay(phone)}`}
                  onPress={() => callPhone(phone)}
                />
              ) : null}
              {coords ? (
                <Button
                  label={t('listing.open_in_2gis')}
                  variant="outline"
                  icon="map"
                  accessibilityRole="link"
                  onPress={() => openRouteIn2Gis(coords.latitude, coords.longitude)}
                />
              ) : null}
            </View>
          ) : null}

          <View style={styles.section}>
            <SectionLabel>{t('listing.reviews')}</SectionLabel>
            <ReviewList
              reviews={reviews?.items ?? []}
              replyLabel={t('provider.owner_reply_label')}
              emptyText={t('listing.no_reviews')}
              onReport={reportReview}
            />
          </View>

          {/* Последней строкой: действие редкое, а закреплённый низ занят главным. */}
          <Button
            label={t('report.link_listing')}
            variant="text"
            icon="flag-outline"
            small
            onPress={report}
            style={styles.report}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    scroll: { flex: 1 },
    content: { paddingBottom: 32 },
    body: { padding: space.page, gap: space.gap },
    head: { gap: 4 },
    name:{ fontSize: text.title, fontWeight: '700', color: colors.text },
    sub: { fontSize: text.caption, color: colors.muted },
    verified: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    verifiedText: { flexShrink: 1, fontSize: text.caption, fontWeight: '600', color: colors.success },
    rating: { alignSelf: 'flex-start' },
    priceCard: { gap: 2 },
    price: { fontSize: text.metric, fontWeight: '700', color: colors.primary },
    priceHint: { fontSize: text.caption, color: colors.muted },
    noPrice: { fontSize: text.subtitle, fontWeight: '600', color: colors.text },
    section: { gap: 8, marginTop: 4 },
    paragraph: { fontSize: text.body, lineHeight: 22, color: colors.text },
    // «Написать» без flex сжималась бы до вертушки на время запроса, и
    // «Забронировать» прыгала; доли 2:3 — обе подписи целиком на 320 pt.
    chatButton: { flex: 2 },
    bookButton: { flex: 3 },
    report: { alignSelf: 'center' },
  });
