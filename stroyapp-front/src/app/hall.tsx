import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, chatsApi, hallsApi, reviewsApi } from '@/api';
import type { PublicHallDetails, Review, ReviewsResponse } from '@/api';
import { Button } from '@/components/Button';
import { Card, SectionLabel } from '@/components/Card';
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
import { capacityLabel } from '@/utils/capacity';
import { formatPrice } from '@/utils/format';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { openRouteIn2Gis, openSearchIn2Gis } from '@/utils/links';
import { pushOnce, useOnTop } from '@/utils/nav';

/**
 * Карточка зала для клиента: фото, цены, описание, удобства, адрес, отзывы
 * и две кнопки внизу — написать владельцу и подать заявку.
 *
 * Смотреть можно гостем; вход спрашиваем только на действии (избранное,
 * чат, заявка) — шторкой, после которой действие выполняется само.
 *
 * fromChat — guid чата, из которого открыли зал («Перейти к залу»).
 */
export default function HallScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  // hallGuid по типу необязателен: экран можно открыть и по неполному адресу
  // (ссылка stroyapp://hall), и тогда запрос ушёл бы на /search/halls/undefined.
  const { hallGuid, fromChat } = useLocalSearchParams<{ hallGuid?: string; fromChat?: string }>();

  const [hall, setHall] = useState<PublicHallDetails | null>(null);
  const [reviews, setReviews] = useState<ReviewsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Храним не готовый текст, а только сообщение сервера: общий текст ошибки
  // подставляется при отрисовке. Иначе t попадает в зависимости загрузки, и
  // смена языка (она есть в шторке входа) перезапрашивала бы зал с вертушкой.
  const [failure, setFailure] = useState<{ message: string | null } | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  // Номер последнего запроса: ответ более раннего (потянули обновить дважды,
  // сменился guid) не должен затирать более свежие данные.
  const requestId = useRef(0);
  // Замок, а не только состояние: два быстрых нажатия успевают пройти до
  // перерисовки кнопки, и чат открылся бы дважды.
  const chatLock = useRef(false);
  // Перед глазами ли экран. Чат открывается запросом, и пока он идёт, человек
  // может уйти назад или нажать «Забронировать»: без этой проверки чат (или
  // окно с ошибкой) выскочил бы уже поверх другого экрана. Шторка входа и
  // просмотр фото — не экраны, с ними фокус остаётся здесь.
  const onTop = useOnTop();

  const isFav = useFavoritesStore((s) => (hallGuid ? s.guids.has(hallGuid) : false));
  const toggleFav = useFavoritesStore((s) => s.toggle);
  const requireAuth = useRequireAuth();

  // Устроено как в карточке исполнителя: клиент держит зал открытым, пока
  // переписывается с владельцем о цене, и должен мочь обновить его жестом, а
  // не закрывать и открывать заново.
  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      const id = ++requestId.current;
      if (!hallGuid) {
        setFailure({ message: null });
        setLoading(false);
        return;
      }
      if (mode === 'refresh') {
        setRefreshing(true);
      } else {
        setLoading(true);
        setHall(null);
        setReviews(null);
      }
      setFailure(null);
      try {
        // Зал и отзывы — одним заходом: рейтинг стоит в шапке карточки, и
        // показывать её без него, а потом дорисовывать — дёрганье вёрстки.
        const [hallResp, reviewsResp] = await Promise.all([
          hallsApi.getPublic(hallGuid),
          reviewsApi.list(hallGuid),
        ]);
        if (id !== requestId.current) return;
        setHall(hallResp.hall);
        setReviews(reviewsResp);
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
    [hallGuid],
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

  // Только «зала нет», без проверки ошибки: если не удалось обновление, а
  // прежние данные есть, показываем их с полосой ошибки, а не пустой экран.
  if (!hall) {
    return (
      <Screen scroll>
        <Stack.Screen options={{ headerShown: true, title: '' }} />
        <ErrorBanner message={error ?? t('common.error_generic')} />
        {/* Без guid повторять нечего: экран открыли по неполному адресу. */}
        {hallGuid ? (
          <Button label={t('common.retry')} variant="outline" onPress={() => void load('initial')} />
        ) : null}
      </Screen>
    );
  }

  const openIn2Gis = () => {
    const { latitude, longitude, address } = hall.venue;
    // Владелец не поставил точку на карте — ищем по адресу в браузере.
    if (latitude && longitude) openRouteIn2Gis(latitude, longitude);
    else openSearchIn2Gis(address);
  };

  // «Стало избранным» считаем в момент нажатия, а не после входа: гость нажал
  // пустое сердце, чтобы добавить, — и после входа зал должен добавиться, даже
  // если избранное аккаунта к этому мигу уже подгрузилось.
  const onToggleFavorite = () => requireAuth('favorite', () => void toggleFav(hall.guid, !isFav));

  const openChat = async () => {
    if (chatLock.current) return;
    chatLock.current = true;
    setChatBusy(true);
    try {
      const { chat_guid: chatGuid } = await chatsApi.openWithHall(hall.guid);
      if (!onTop.current) return;
      if (fromChat && chatGuid === fromChat) {
        // Пришли из этого же чата: он лежит в стеке прямо под нами. Открывать
        // его ещё раз — значит растить стек при каждом круге «чат → зал → чат».
        router.back();
      } else {
        pushOnce({ pathname: '/chat', params: { chatGuid } });
      }
    } catch (e) {
      // Раньше ошибка глоталась, и кнопка «Написать» просто ничего не делала.
      if (onTop.current) Alert.alert(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      chatLock.current = false;
      setChatBusy(false);
    }
  };

  const onChat = () => requireAuth('message', () => void openChat());
  const onBook = () =>
    requireAuth('book', () => pushOnce({ pathname: '/booking-form', params: { hallGuid: hall.guid } }));

  // Жалоба — только от вошедшего: у неё должен быть автор. Название идёт
  // параметром, чтобы форма показала, на что она.
  const onReport = () =>
    requireAuth('generic', () =>
      pushOnce({
        pathname: '/report',
        params: { targetType: 'hall', targetGuid: hall.guid, subjectName: hall.name },
      }),
    );
  const onReportReview = (review: Review) =>
    requireAuth('generic', () =>
      pushOnce({
        pathname: '/report',
        params: { targetType: 'review', targetGuid: review.guid, subjectName: review.client_name },
      }),
    );

  const capacity = capacityLabel(t, hall.capacity_min, hall.capacity_max);
  const hasRating = !!reviews && reviews.reviews_count > 0;

  return (
    <Screen
      footer={
        <>
          <Button
            label={t('hall.chat_button')}
            variant="outline"
            busy={chatBusy}
            onPress={onChat}
            style={plain.chatButton}
          />
          <Button label={t('hall.book_button')} onPress={onBook} style={plain.bookButton} />
        </>
      }
    >
      <Stack.Screen options={{ headerShown: true, title: hall.name }} />

      {/* Свой ScrollView, а не <Screen scroll>: у того отступы по краям, а
          фото должны идти от края до края. */}
      <ScrollView
        style={plain.scroll}
        contentContainerStyle={plain.scrollContent}
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
          <PhotoGallery photos={hall.photos} />
          {/* Сердце — сосед галереи, а не её ребёнок: нажатие на него не
              должно открывать просмотр фото. */}
          <FavoriteHeart isFavorite={isFav} onPress={onToggleFavorite} />
        </View>

        <View style={styles.body}>
          {/* Обновление не удалось, но старые данные есть — показываем их,
              а не пустой экран с ошибкой. */}
          <ErrorBanner message={error} />

          <View style={styles.head}>
            <Text style={styles.name}>{hall.name}</Text>
            <Text style={styles.venue}>
              {hall.venue.name} · {dictName(hall.city, lang)}
            </Text>
            {hasRating ? (
              <RatingInline
                avg={reviews.avg_rating}
                count={reviews.reviews_count}
                style={styles.rating}
              />
            ) : null}
          </View>

          {capacity || hall.area_sqm != null ? (
            <ChipWrap>
              {capacity ? <Chip label={capacity} icon="account-group-outline" /> : null}
              {hall.area_sqm != null ? (
                <Chip label={t('hall.area_sqm', { n: hall.area_sqm })} icon="ruler-square" />
              ) : null}
            </ChipWrap>
          ) : null}

          <Card>
            <View style={styles.priceRow}>
              <Text style={styles.priceLabel}>{t('hall.price_weekday')}</Text>
              <Text style={styles.priceValue}>{formatPrice(hall.price_weekday)}</Text>
            </View>
            <View style={styles.priceRow}>
              <Text style={styles.priceLabel}>{t('hall.price_weekend')}</Text>
              <Text style={styles.priceValue}>{formatPrice(hall.price_weekend)}</Text>
            </View>
          </Card>

          {hall.description ? (
            <View style={styles.section}>
              <SectionLabel>{t('hall.description')}</SectionLabel>
              <Card>
                <Text style={styles.paragraph}>{hall.description}</Text>
              </Card>
            </View>
          ) : null}

          {hall.amenities.length > 0 ? (
            <View style={styles.section}>
              <SectionLabel>{t('hall.amenities')}</SectionLabel>
              <ChipWrap>
                {hall.amenities.map((a) => (
                  <Chip key={a.id} label={dictName(a, lang)} />
                ))}
              </ChipWrap>
            </View>
          ) : null}

          <View style={styles.section}>
            <SectionLabel>{t('hall.location')}</SectionLabel>
            <Card>
              <Text style={styles.paragraph}>{hall.venue.address}</Text>
              <Button
                label={t('hall.open_in_2gis')}
                variant="outline"
                icon="map"
                accessibilityRole="link"
                onPress={openIn2Gis}
              />
            </Card>
          </View>

          <View style={styles.section}>
            <SectionLabel>{t('hall.reviews')}</SectionLabel>
            <ReviewList
              reviews={reviews?.items ?? []}
              replyLabel={t('hall.owner_reply_label')}
              emptyText={t('hall.no_reviews')}
              onReport={onReportReview}
            />
          </View>

          {/* Последней строкой: действие редкое, а закреплённый низ занят главным. */}
          <Button
            label={t('report.link_listing')}
            variant="text"
            icon="flag-outline"
            small
            onPress={onReport}
            style={plain.report}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const plain = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 32 },
  // «Написать» без flex сжималась бы до вертушки на время запроса, и
  // «Забронировать» прыгала. Доли 2:3, а не поровну: на экране 360 pt в
  // половину ширины «Забронировать» целиком не влезает.
  chatButton: { flex: 2 },
  bookButton: { flex: 3 },
  report: { alignSelf: 'center' },
});

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: { padding: space.page, gap: space.gap },
    head: { gap: 4 },
    name: { fontSize: text.title, fontWeight: '700', color: colors.text },
    venue: { fontSize: text.caption, color: colors.muted },
    rating: { alignSelf: 'flex-start' },
    priceRow: { flexDirection: 'row', alignItems: 'center', gap: space.gap },
    priceLabel: { flex: 1, minWidth: 0, fontSize: text.body, color: colors.text },
    priceValue: { flexShrink: 0, fontSize: text.subtitle, fontWeight: '700', color: colors.primary },
    // Подпись раздела держится ближе к своему блоку, чем к предыдущему.
    section: { gap: 8, marginTop: 4 },
    paragraph: { fontSize: text.body, lineHeight: 22, color: colors.text },
  });
