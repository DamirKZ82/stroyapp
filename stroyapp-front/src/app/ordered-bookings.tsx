import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View, type ListRenderItem } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, bookingsApi } from '@/api';
import type { Booking } from '@/api/types';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Badge, EmptyState, ErrorBanner, Loader } from '@/components/Feedback';
import { LIST_CONTENT_FILL, Screen } from '@/components/Screen';
import { text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { confirmDestructive } from '@/utils/alert';
import { bookingStatusTone } from '@/utils/bookingStatus';
import { formatDateHuman } from '@/utils/format';
import { useLang } from '@/utils/lang';
import { useOnTop } from '@/utils/nav';
import { formatKzPhoneDisplay } from '@/utils/phone';

/**
 * Заявки, которые я оформил как мастер для своих клиентов. Пока клиент не
 * подтвердил, заявку можно отозвать; дальше она клиентская.
 */
export default function OrderedBookingsScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const onTop = useOnTop();

  const [items, setItems] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [known, setKnown] = useState(false);
  const [withdrawing, setWithdrawing] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems((await bookingsApi.ordered()).items);
      setKnown(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const withdraw = useCallback(
    async (booking: Booking) => {
      setWithdrawing((prev) => new Set(prev).add(booking.guid));
      try {
        await bookingsApi.cancel(booking.guid);
      } catch (e) {
        if (onTop.current) {
          Alert.alert(
            t('ordered.withdraw_failed'),
            e instanceof ApiError ? e.message : t('common.error_generic'),
          );
        }
      } finally {
        setWithdrawing((prev) => {
          const next = new Set(prev);
          next.delete(booking.guid);
          return next;
        });
        // И после отказа: обычно он значит, что клиент уже ответил.
        void load();
      }
    },
    [load, onTop, t],
  );

  const confirmWithdraw = useCallback(
    (booking: Booking) =>
      confirmDestructive(
        t('ordered.withdraw_title'),
        t('ordered.withdraw_text'),
        () => void withdraw(booking),
        t('ordered.withdraw_yes'),
        t('common.no'),
      ),
    [t, withdraw],
  );

  const renderItem = useCallback<ListRenderItem<Booking>>(
    ({ item }) => {
      const client = item.client?.name || formatKzPhoneDisplay(item.client?.phone ?? '');
      return (
        <Card>
          <Text style={styles.name} numberOfLines={1}>
            {item.provider_deleted || !item.provider?.name
              ? t('bookings.subject_deleted')
              : item.provider.name}
          </Text>
          {item.comment ? (
            <Text style={styles.what} numberOfLines={2}>
              {item.comment}
            </Text>
          ) : null}
          <Text style={styles.meta} numberOfLines={1}>
            {t('ordered.for_client', { name: client })}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {t('bookings.wanted_by', { date: formatDateHuman(item.event_date, lang) })}
          </Text>
          {/* «Ждёт вашего подтверждения» — слова для клиента; мастеру ждать клиента. */}
          <Badge
            label={
              item.status === 'awaiting_client'
                ? t('ordered.status_awaiting_client')
                : t(`bookings.status_${item.status}`)
            }
            tone={bookingStatusTone(item.status)}
          />
          {item.status === 'rejected' && item.rejected_reason ? (
            <Text style={styles.meta}>
              {t('bookings.rejected_reason', { reason: item.rejected_reason })}
            </Text>
          ) : null}
          {item.status === 'awaiting_client' ? (
            <View style={styles.actions}>
              <Button
                label={t('ordered.withdraw')}
                variant="text"
                tone="danger"
                busy={withdrawing.has(item.guid)}
                onPress={() => confirmWithdraw(item)}
              />
            </View>
          ) : null}
        </Card>
      );
    },
    [confirmWithdraw, lang, styles, t, withdrawing],
  );

  const keyExtractor = useCallback((item: Booking) => item.guid, []);

  const header = <Stack.Screen options={{ headerShown: true, title: t('ordered.title') }} />;

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
            onRefresh={() => {
              setRefreshing(true);
              void load();
            }}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        ListHeaderComponent={<ErrorBanner message={error} />}
        ListEmptyComponent={
          error || !known ? (
            <Button label={t('common.retry')} variant="outline" onPress={() => void load()} />
          ) : (
            <EmptyState title={t('ordered.empty_title')} subtitle={t('ordered.empty_hint')} />
          )
        }
      />
    </Screen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    name: { fontSize: text.subtitle, fontWeight: '600', color: colors.text },
    what: { fontSize: text.body, color: colors.text },
    meta: { fontSize: text.caption, color: colors.muted },
    actions: { flexDirection: 'row', justifyContent: 'flex-end' },
  });
