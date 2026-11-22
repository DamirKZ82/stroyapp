import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Stack, useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type ListRenderItem,
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
import { confirmDestructive } from '@/utils/alert';
import { bookingStatusTone } from '@/utils/bookingStatus';
import { formatDateHuman } from '@/utils/format';
import { useLang } from '@/utils/lang';
import { pushOnce, useOnTop } from '@/utils/nav';
import { serverToday } from '@/utils/serverTime';

// Отменённые и закрытые без продавца отдельным фильтром не показываем: их
// видно только во «Все».
type Filter = 'all' | Exclude<BookingStatus, 'cancelled' | 'declined' | 'withdrawn'>;

const NONE: ReadonlySet<string> = new Set();

const FILTERS: Filter[] = ['all', 'awaiting_client', 'pending', 'confirmed', 'rejected'];

/** Ключи целиком: новый фильтр без подписи не соберётся, а не покажет на чипе сам ключ. */
const FILTER_KEY: Record<Filter, string> = {
  all: 'bookings.filter_all',
  awaiting_client: 'bookings.filter_awaiting_client',
  pending: 'bookings.filter_pending',
  confirmed: 'bookings.filter_confirmed',
  rejected: 'bookings.filter_rejected',
};

/**
 * Заявки клиента: что он подал, в каком они состоянии и что с ними можно
 * сделать — отменить, пока заявка жива, или оставить отзыв после события.
 */
export default function MyBookingsScreen() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const onTop = useOnTop();

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
  // Набор, а не одна заявка: пока идёт отмена первой, человек успевает
  // подтвердить отмену второй, и вертушка должна остаться на обеих.
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(NONE);

  // Номер последнего запроса. Фильтр переключают быстрее, чем отвечает
  // сервер, и ответ на прежний фильтр, придя позже, подменил бы список.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setError(null);
    try {
      const resp = await bookingsApi.my(filter === 'all' ? undefined : filter);
      if (request === requestRef.current) {
        setItems(resp.items);
        setKnown(true);
      }
    } catch (e) {
      if (request === requestRef.current) {
        setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      }
    } finally {
      if (request === requestRef.current) {
        setLoading(false);
        setRefreshing(false);
        setSwitching(false);
      }
    }
  }, [filter, t]);

  // Отмена заявки длится дольше, чем нажатие на другой фильтр. Перечитать
  // список после неё надо по фильтру, выбранному к тому времени, а не по
  // тому, при котором человек нажал «Отменить»: иначе под новым чипом
  // оказались бы заявки прежнего.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // Единственное место загрузки: срабатывает при открытии, при возврате на
  // экран (после отзыва, из карточки объявления) и при смене фильтра — load тогда
  // новый. Отдельный useEffect рядом слал бы второй запрос при открытии.
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
    // заявки прошлого фильтра с рабочей кнопкой отмены, а при ошибке сети
    // остались бы там насовсем.
    setItems([]);
    setKnown(false);
    setSwitching(true);
    setFilter(next);
  };

  const cancelBooking = useCallback(
    async (booking: Booking) => {
      setCancelling((prev) => new Set(prev).add(booking.guid));
      try {
        await bookingsApi.cancel(booking.guid);
      } catch (e) {
        // Полоса ошибки стоит над списком, а заявка может быть далеко внизу —
        // там отказ остался бы незамеченным. Поэтому отдельное окно.
        if (onTop.current) {
          Alert.alert(
            t('bookings.cancel_failed'),
            e instanceof ApiError ? e.message : t('common.error_generic'),
          );
        }
      } finally {
        setCancelling((prev) => {
          const next = new Set(prev);
          next.delete(booking.guid);
          return next;
        });
        // Перечитываем и после отказа: чаще всего он значит, что владелец
        // успел ответить и статус на экране уже устарел.
        void loadRef.current();
      }
    },
    [onTop, t],
  );

  // Решение по заявке мастера: «подтвердить» уводит её продавцу, «не
  // подтверждать» закрывает. Вертушка — в том же наборе, что у отмены:
  // на карточке за раз идёт только одно действие.
  const decide = useCallback(
    async (booking: Booking, approve: boolean) => {
      setCancelling((prev) => new Set(prev).add(booking.guid));
      try {
        if (approve) await bookingsApi.approve(booking.guid);
        else await bookingsApi.decline(booking.guid);
      } catch (e) {
        if (onTop.current) {
          Alert.alert(
            approve ? t('bookings.approve_failed') : t('bookings.decline_failed'),
            e instanceof ApiError ? e.message : t('common.error_generic'),
          );
        }
      } finally {
        setCancelling((prev) => {
          const next = new Set(prev);
          next.delete(booking.guid);
          return next;
        });
        void loadRef.current();
      }
    },
    [onTop, t],
  );

  const onApprove = useCallback((booking: Booking) => void decide(booking, true), [decide]);

  const confirmDecline = useCallback(
    (booking: Booking) => {
      confirmDestructive(
        t('bookings.decline_confirm_title'),
        t('bookings.decline_confirm_text'),
        () => void decide(booking, false),
        t('bookings.decline_yes'),
        t('common.no'),
      );
    },
    [decide, t],
  );

  const confirmCancel = useCallback(
    (booking: Booking) => {
      confirmDestructive(
        t('bookings.cancel_confirm_title'),
        t('bookings.cancel_confirm_text'),
        () => void cancelBooking(booking),
        t('bookings.cancel_yes'),
        // «Нет», а не общее «Отмена»: под вопросом «Отменить заявку?» кнопку
        // «Отмена» читают как согласие, а она как раз ничего не отменяет.
        t('common.no'),
      );
    },
    [cancelBooking, t],
  );

  // Не в useMemo: экран может пережить полночь, и «событие прошло» должно
  // считаться от сегодняшнего дня. Строка сравнивается по значению, так что
  // renderItem от этого заново не создаётся. День — по поясу сервера: отзыв
  // проверяет он, и по часам телефона кнопка появлялась бы раньше, чем
  // сервер готов отзыв принять.
  const today = serverToday();

  const renderItem = useCallback<ListRenderItem<Booking>>(
    ({ item }) => (
      <BookingCard
        booking={item}
        today={today}
        cancelling={cancelling.has(item.guid)}
        onCancel={confirmCancel}
        onApprove={onApprove}
        onDecline={confirmDecline}
      />
    ),
    [today, cancelling, confirmCancel, onApprove, confirmDecline],
  );

  const keyExtractor = useCallback((item: Booking) => item.guid, []);

  const header = <Stack.Screen options={{ headerShown: true, title: t('profile.my_bookings') }} />;

  if (loading) {
    return (
      <Screen>
        {header}
        <Loader />
      </Screen>
    );
  }

  return (
    <Screen>
      {header}
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
        ListHeaderComponent={
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
            {/* Под чипами, а не над ними: иначе ряд фильтров прыгал бы вниз
                всякий раз, когда появляется ошибка. */}
            <ErrorBanner message={error} />
          </View>
        }
        // Пока список не пришёл, «заявок нет» было бы неправдой: мы не знаем.
        // Вместо него — кнопка: жест «потянуть» на пустом экране не очевиден.
        ListEmptyComponent={
          switching ? (
            <View style={styles.switching}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : error || !known ? (
            <Button
              label={t('common.retry')}
              variant="outline"
              busy={refreshing}
              onPress={onRefresh}
            />
          ) : (
            <EmptyState title={t('bookings.empty_title')} subtitle={t('bookings.empty_hint')} />
          )
        }
      />
    </Screen>
  );
}

interface BookingCardProps {
  booking: Booking;
  /** Сегодня по поясу сервера, YYYY-MM-DD: от него считается «событие уже прошло». */
  today: string;
  /** Идёт запрос отмены именно этой заявки. */
  cancelling: boolean;
  onCancel: (booking: Booking) => void;
  onApprove: (booking: Booking) => void;
  onDecline: (booking: Booking) => void;
}

const BookingCard = memo(function BookingCard({
  booking,
  today,
  cancelling,
  onCancel,
  onApprove,
  onDecline,
}: BookingCardProps) {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  const subject = booking.provider;
  const deleted = booking.provider_deleted || !subject;
  // Заявка переживает своё объявление: у удалённого сервер ставит
  // provider_deleted и не отдаёт guid. Имя проверяем отдельно.
  const subjectGuid = deleted ? null : (subject?.guid ?? null);
  const subjectName = deleted || !subject?.name ? null : subject.name;

  const awaiting = booking.status === 'awaiting_client';
  const canCancel = booking.status === 'pending' || booking.status === 'confirmed';
  // Отзыв — с наступлением срока заявки (раньше сервер его отклонит) и
  // только пока объявление существует: отзыв об удалённом никто не увидит.
  const canReview = booking.status === 'confirmed' && booking.event_date <= today && !deleted;

  const openSubject = () => {
    if (!subjectGuid) return;
    pushOnce({ pathname: '/provider', params: { providerGuid: subjectGuid } });
  };

  const openReview = () =>
    pushOnce({
      pathname: '/review-form',
      params: { bookingGuid: booking.guid, subjectName: subjectName ?? '' },
    });

  const summary = (
    <View style={styles.subjectText}>
      <Text style={[styles.name, !subjectName && styles.nameGone]} numberOfLines={1}>
        {subjectName ?? t('bookings.subject_deleted')}
      </Text>
      {booking.comment ? (
        <Text style={styles.what} numberOfLines={2}>
          {booking.comment}
        </Text>
      ) : null}
      <Text style={styles.meta} numberOfLines={1}>
        {t('bookings.wanted_by', { date: formatDateHuman(booking.event_date, lang) })}
      </Text>
      {booking.ordered_by ? (
        <Text style={styles.meta} numberOfLines={1}>
          {t('bookings.ordered_by', { name: booking.ordered_by.name || booking.ordered_by.phone || '' })}
        </Text>
      ) : null}
    </View>
  );

  return (
    <Card>
      {subjectGuid ? (
        <Pressable
          onPress={openSubject}
          accessibilityRole="button"
          style={({ pressed }) => [styles.subject, pressed && styles.pressed]}
        >
          {summary}
          {/* Стрелка — украшение, как у Row: подпись кнопки Android собирает
              из детей, и символ шрифта прочёлся бы в ней непонятным знаком.
              На iOS сборщик подписи пропускает только accessibilityElementsHidden,
              accessible={false} там не помогает. */}
          <Icon
            name="chevron-right"
            size={20}
            color={colors.muted}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        </Pressable>
      ) : (
        // Открывать нечего — и кнопкой блок не делаем: иначе экранный диктор
        // объявлял бы кнопку, которая ничего не делает.
        <View style={styles.subject}>{summary}</View>
      )}

      <Badge label={t(`bookings.status_${booking.status}`)} tone={bookingStatusTone(booking.status)} />

      {booking.status === 'rejected' && booking.rejected_reason ? (
        <Text style={styles.reason}>
          {t('bookings.rejected_reason', { reason: booking.rejected_reason })}
        </Text>
      ) : null}

      {awaiting ? (
        <>
          <Text style={styles.reason}>{t('bookings.awaiting_hint')}</Text>
          <View style={styles.actions}>
            <Button
              label={t('bookings.decline_button')}
              variant="text"
              tone="danger"
              disabled={cancelling}
              onPress={() => onDecline(booking)}
            />
            <Button
              label={t('bookings.approve_button')}
              small
              busy={cancelling}
              onPress={() => onApprove(booking)}
            />
          </View>
        </>
      ) : null}

      {canCancel || canReview ? (
        <View style={styles.actions}>
          {canCancel ? (
            <Button
              label={t('bookings.cancel_button')}
              variant="text"
              tone="danger"
              busy={cancelling}
              onPress={() => onCancel(booking)}
            />
          ) : null}
          {canReview ? (
            <Button
              label={t('bookings.leave_review')}
              variant="outline"
              small
              onPress={openReview}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
});

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    header: { gap: space.gap },
    switching: { paddingVertical: 48, alignItems: 'center' },
    subject: { flexDirection: 'row', alignItems: 'center', gap: space.gap, minHeight: 44 },
    subjectText: { flex: 1, minWidth: 0, gap: 4 },
    pressed: { opacity: 0.7 },
    name: { fontSize: text.subtitle, fontWeight: '600', color: colors.text },
    nameGone: { color: colors.muted },
    meta: { fontSize: text.caption, color: colors.muted },
    what: { fontSize: text.body, color: colors.text },
    reason: { fontSize: text.caption, color: colors.muted },
    // Перенос — на случай узкого экрана и крупного шрифта: две кнопки с
    // казахскими подписями в одну строку могут не поместиться.
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 8,
    },
  });
