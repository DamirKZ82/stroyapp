import { Stack, useFocusEffect } from 'expo-router';
import { memo, useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, bookingsApi } from '@/api';
import type { Booking, BookingStatus } from '@/api/types';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ChipRow, TouchChip } from '@/components/Chip';
import { Badge, EmptyState, ErrorBanner, Loader } from '@/components/Feedback';
import { LIST_CONTENT_FILL, Screen } from '@/components/Screen';
import { space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { bookingStatusTone } from '@/utils/bookingStatus';
import { formatDateHuman } from '@/utils/format';
import { useLang } from '@/utils/lang';
import { formatKzPhoneDisplay } from '@/utils/phone';
import { pushOnce } from '@/utils/nav';

// Отдельного фильтра «Отменённые» нет, как и раньше: заявки, отменённые
// клиентом, видны только в общем списке. Заявки мастеров, которые клиент ещё
// не подтвердил (или не подтвердил вовсе), владельцу сервер не отдаёт.
type Filter =
  | 'all'
  | Exclude<BookingStatus, 'cancelled' | 'awaiting_client' | 'declined' | 'withdrawn'>;

const FILTERS: Filter[] = ['all', 'pending', 'confirmed', 'rejected'];

/** Ключи целиком: новый фильтр без подписи не соберётся, а не покажет на чипе сам ключ. */
const FILTER_KEY: Record<Filter, string> = {
  all: 'owner.incoming_filter_all',
  pending: 'owner.incoming_filter_pending',
  confirmed: 'owner.incoming_filter_confirmed',
  rejected: 'owner.incoming_filter_rejected',
};

/** Заявки клиентов на залы и услуги владельца. */
export default function IncomingBookingsScreen() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  const [items, setItems] = useState<Booking[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** Идёт запрос после смены фильтра: список уже очищен, новый ещё не пришёл. */
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Пришёл ли список выбранного фильтра хоть раз. Одной ошибки для пустого
  // места мало: на время повтора она гасится, и под вертушкой мелькнуло бы
  // «заявок нет», а кнопка повтора пропала бы прямо под пальцем.
  const [known, setKnown] = useState(false);

  // Фильтры переключают быстрее, чем отвечает сервер, а возврат с экрана
  // заявки запускает ещё один запрос. Без номера запроса опоздавший ответ
  // прошлого фильтра лёг бы под уже выбранный другой.
  const lastRequest = useRef(0);

  const load = useCallback(async () => {
    const request = ++lastRequest.current;
    setError(null);
    try {
      const resp = await bookingsApi.incoming(filter === 'all' ? undefined : filter);
      if (request === lastRequest.current) {
        setItems(resp.items);
        setKnown(true);
      }
    } catch (e) {
      if (request === lastRequest.current) {
        setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      }
    } finally {
      // Вертушки снимает только последний запрос: за устаревшим ещё идёт свежий.
      if (request === lastRequest.current) {
        setLoading(false);
        setRefreshing(false);
        setSwitching(false);
      }
    }
  }, [filter, t]);

  // Один эффект на открытие, возврат с экрана заявки (её могли подтвердить
  // или отклонить) и смену фильтра: от фильтра зависит сам load.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const selectFilter = (next: Filter) => {
    if (next === filter) return;
    // Список чистим сразу: иначе до ответа под чипом «Отклонённые» висели бы
    // заявки прошлого фильтра, а при ошибке сети остались бы там насовсем.
    setItems([]);
    setKnown(false);
    setSwitching(true);
    setFilter(next);
  };

  const open = useCallback(
    (bookingGuid: string) => pushOnce({ pathname: '/booking', params: { bookingGuid } }),
    [],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Booking>) => <BookingCard booking={item} onOpen={open} />,
    [open],
  );
  const keyExtractor = useCallback((item: Booking) => item.guid, []);

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: true, title: t('owner.incoming_title') }} />
        <Loader />
      </Screen>
    );
  }

  const header = (
    <View style={styles.header}>
      <ChipRow>
        {FILTERS.map((f) => (
          <TouchChip
            key={f}
            label={t(FILTER_KEY[f])}
            selected={filter === f}
            onPress={() => selectFilter(f)}
          />
        ))}
      </ChipRow>
      <ErrorBanner message={error} />
    </View>
  );

  // Пока список не пришёл, «пока нет заявок» было бы неправдой: мы не знаем,
  // есть ли они. Вместо него — кнопка: жест «потянуть» на пустом экране не
  // очевиден.
  const empty = switching ? (
    <View style={styles.switching}>
      <ActivityIndicator color={colors.primary} />
    </View>
  ) : error || !known ? (
    <Button label={t('common.retry')} variant="outline" busy={refreshing} onPress={onRefresh} />
  ) : (
    <EmptyState title={t('owner.incoming_empty_title')} subtitle={t('owner.incoming_empty_hint')} />
  );

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: t('owner.incoming_title') }} />
      <FlatList
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={LIST_CONTENT_FILL}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      />
    </Screen>
  );
}

interface BookingCardProps {
  booking: Booking;
  onOpen: (bookingGuid: string) => void;
}

/**
 * Карточка входящей заявки.
 *
 * Заголовок — клиент, а не объявление: у продавца с одним магазином его
 * название стояло бы в каждой карточке, и заявки различались бы только
 * мелким текстом. Что нужно — первой строкой комментария.
 */
const BookingCard = memo(function BookingCard({ booking, onOpen }: BookingCardProps) {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);

  const subject = booking.provider?.name ?? t('bookings.subject_deleted');
  const name = booking.client?.name || null;
  const phone = booking.client?.phone ? formatKzPhoneDisplay(booking.client.phone) : null;
  // Имя клиент мог и не указать — тогда его представляет телефон, а если нет
  // и телефона, заголовком остаётся сам объект заявки.
  const who = name ?? phone;

  return (
    <Pressable
      onPress={() => onOpen(booking.guid)}
      accessibilityRole="button"
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Card style={styles.card}>
        <Text style={styles.title} numberOfLines={1}>
          {who ?? subject}
        </Text>
        {name && phone ? (
          <Text style={styles.meta} numberOfLines={1}>
            {phone}
          </Text>
        ) : null}
        {who ? (
          <Text style={styles.subject} numberOfLines={1}>
            {subject}
          </Text>
        ) : null}
        {booking.comment ? (
          <Text style={styles.what} numberOfLines={2}>
            {booking.comment}
          </Text>
        ) : null}
        <View style={styles.foot}>
          <Text style={styles.meta} numberOfLines={1}>
            {t('bookings.wanted_by', { date: formatDateHuman(booking.event_date, lang) })}
          </Text>
          <View style={styles.status}>
            <Badge label={t(`bookings.status_${booking.status}`)} tone={bookingStatusTone(booking.status)} />
          </View>
        </View>
      </Card>
    </Pressable>
  );
});

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    header: { gap: space.gap },
    switching: { paddingVertical: 48, alignItems: 'center' },
    pressed: { opacity: 0.7 },
    card: { gap: 4 },
    title: { fontSize: text.subtitle, fontWeight: '600', color: colors.text },
    subject: { fontSize: text.body, color: colors.text },
    meta: { fontSize: text.caption, color: colors.muted },
    // Перенос — на случай крупного системного шрифта: длинное «Ожидает
    // подтверждения» уходит на свою строку, а не сжимает цену до многоточия.
    foot: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      columnGap: space.gap,
      rowGap: 4,
      marginTop: 4,
    },
    what: { fontSize: text.body, color: colors.text },
    // Статус всегда справа — и когда цены нет, и когда он перенёсся на новую строку.
    status: { marginLeft: 'auto' },
  });
