import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, bookingsApi, dictsApi } from '@/api';
import type { Booking, EventType } from '@/api/types';
import { Button } from '@/components/Button';
import { Card, Row, RowGroup, SectionLabel } from '@/components/Card';
import { Badge, ErrorBanner, Loader } from '@/components/Feedback';
import { Input } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { showThen } from '@/utils/alert';
import { bookingStatusTone } from '@/utils/bookingStatus';
import { formatDateHuman, formatPrice } from '@/utils/format';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { callPhone } from '@/utils/links';
import { useOnTop } from '@/utils/nav';
import { formatKzPhoneDisplay } from '@/utils/phone';

// Столько принимает сервер; длиннее — отказ уже после нажатия «Отклонить».
const REASON_MAX = 1000;

/**
 * Заявка глазами владельца: кто, когда, на сколько гостей — и ответ на неё,
 * подтвердить или отклонить с причиной.
 *
 * Отвечать можно только на ожидающую заявку: у остальных кнопок внизу нет,
 * экран просто показывает, чем дело кончилось.
 */
export default function BookingScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { bookingGuid } = useLocalSearchParams<{ bookingGuid: string }>();

  const [booking, setBooking] = useState<Booking | null>(null);
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState<string | null>(null);
  // Какой из двух запросов идёт. Одного флага «занято» мало: вертушка нужна
  // на той кнопке, которую нажали, а не на обеих.
  const [action, setAction] = useState<'confirm' | 'reject' | null>(null);

  const typesLoaded = useRef(false);
  // Фокус и «потянуть вниз» могут запустить два запроса сразу, а ответ на
  // запрос, ушедший до подтверждения, вернул бы заявке статус «ожидает».
  // Показываем ответ только последнего.
  const lastRequest = useRef(0);
  // router.back() закрывает верхний экран, каким бы он ни был. Если, пока шёл
  // запрос, с экрана ушли кнопкой «Назад», закрывать уже нечего — иначе вслед
  // за заявкой закрылся бы и список, из которого её открыли.
  const onTop = useOnTop();

  const load = useCallback(async () => {
    const request = ++lastRequest.current;
    try {
      if (!bookingGuid) throw new Error('bookingGuid');
      const [res, types] = await Promise.all([
        bookingsApi.get(bookingGuid),
        // Справочник не меняется — берём один раз, а не на каждый фокус.
        // Без него экран работает, просто без строки «Тип мероприятия»,
        // поэтому его ошибку глотаем: заявка важнее.
        typesLoaded.current
          ? null
          : dictsApi
              .eventTypes()
              .then((r) => r.items)
              .catch(() => null),
      ]);
      if (request !== lastRequest.current) return;
      setBooking(res.booking);
      if (types) {
        typesLoaded.current = true;
        setEventTypes(types);
      }
      // Ошибку снимаем после удачного ответа, а не перед запросом: иначе при
      // повторе полоса ошибки мигает.
      setError(null);
    } catch (e) {
      if (request !== lastRequest.current) return;
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      if (request === lastRequest.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [bookingGuid, t]);

  // Только на фокус: он срабатывает и при первом открытии, отдельный
  // useEffect дал бы второй такой же запрос.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const leave = () => {
    if (onTop.current) router.back();
  };

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const retry = () => {
    setLoading(true);
    void load();
  };

  const confirm = async () => {
    if (!booking || action) return;
    setAction('confirm');
    try {
      const resp = await bookingsApi.confirm(booking.guid);
      // Запрос, ушедший до подтверждения, больше не нужен: его ответ вернул
      // бы под окно «Подтверждено» прежний статус и кнопки ответа.
      lastRequest.current += 1;
      setRefreshing(false);
      // Берём только статус: в ответе сервера на подтверждение нет клиента,
      // и вся заявка из ответа оставила бы строки «Клиент» и «Телефон» пустыми.
      setBooking((prev) => (prev ? { ...prev, status: 'confirmed' } : prev));
      // С экрана ушли — окно «Подтверждено» всплыло бы над чужим экраном, а
      // его OK увёл бы назад уже оттуда. Новый статус и так виден при возврате.
      if (!onTop.current) return;
      const rejectedCount = resp.auto_rejected_count;
      showThen(
        t('owner.confirm_success'),
        rejectedCount > 0 ? t('owner.confirm_auto_rejected', { count: rejectedCount }) : undefined,
        leave,
      );
    } catch (e) {
      // Окно, а не полоса вверху: при длинном комментарии экран прокручен, и
      // отказ над содержимым остался бы незамеченным.
      if (onTop.current) {
        Alert.alert(
          t('owner.confirm_failed'),
          e instanceof ApiError ? e.message : t('common.error_generic'),
        );
      }
      // Чаще всего отказ значит, что клиент успел отменить заявку, — тогда
      // статус на экране устарел и кнопки ответа пора убрать.
      void load();
    } finally {
      setAction(null);
    }
  };

  const openReject = () => {
    setRejectError(null);
    setRejectOpen(true);
  };

  const reject = async () => {
    const reason = rejectReason.trim();
    if (!booking || action || !reason) return;
    setAction('reject');
    setRejectError(null);
    try {
      await bookingsApi.reject(booking.guid, reason);
      setRejectOpen(false);
      leave();
    } catch (e) {
      // Ошибка — в самой шторке: полоса на экране была бы закрыта ею.
      setRejectError(e instanceof ApiError ? e.message : t('common.error_generic'));
      void load();
    } finally {
      setAction(null);
    }
  };

  const header = <Stack.Screen options={{ headerShown: true, title: t('owner.booking_details_title') }} />;

  if (loading) {
    return (
      <Screen>
        {header}
        <Loader />
      </Screen>
    );
  }

  if (!booking) {
    return (
      <Screen scroll>
        {header}
        <ErrorBanner message={error ?? t('common.error_generic')} />
        <Button label={t('common.retry')} variant="outline" onPress={retry} />
      </Screen>
    );
  }

  const eventType = booking.event_type_id
    ? eventTypes.find((e) => e.id === booking.event_type_id)
    : null;
  const phone = booking.client?.phone || null;
  const pending = booking.status === 'pending';

  return (
    <Screen
      scroll
      refreshing={refreshing}
      onRefresh={refresh}
      footer={
        pending ? (
          <>
            <Button
              label={t('owner.reject_button')}
              variant="outline"
              tone="danger"
              onPress={openReject}
              disabled={action !== null}
              style={styles.action}
            />
            <Button
              label={t('owner.confirm_button')}
              onPress={() => void confirm()}
              busy={action === 'confirm'}
              disabled={action !== null}
              style={styles.action}
            />
          </>
        ) : undefined
      }
    >
      {header}
      <ErrorBanner message={error} />

      <Card style={styles.head}>
        <Badge label={t(`bookings.status_${booking.status}`)} tone={bookingStatusTone(booking.status)} />
        <Text style={styles.subject}>{booking.subject.name ?? t('bookings.subject_deleted')}</Text>
        {booking.subject.parent_name ? (
          <Text style={styles.parent}>{booking.subject.parent_name}</Text>
        ) : null}
      </Card>

      <RowGroup>
        <Fact first label={t('owner.booking_client')} value={booking.client?.name || '—'} />
        {phone ? (
          <Row
            title={t('owner.booking_phone')}
            onPress={() => callPhone(phone)}
            accessibilityRole="link"
            // Своя подпись: собранную из детей Android дополнил бы значком
            // трубки — символом шрифта, который он читает как непонятный знак.
            accessibilityLabel={`${t('owner.booking_phone')}: ${formatKzPhoneDisplay(phone)}`}
            // Не стрелка: строка уводит из приложения в звонилку.
            right={
              <View style={styles.phone}>
                <Text style={styles.phoneText} numberOfLines={1}>
                  {formatKzPhoneDisplay(phone)}
                </Text>
                <Icon name="phone" size={20} color={colors.primary} />
              </View>
            }
          />
        ) : (
          <Fact label={t('owner.booking_phone')} value="—" />
        )}
        <Fact label={t('owner.booking_date')} value={formatDateHuman(booking.event_date, lang)} />
        <Fact label={t('owner.booking_guests')} value={String(booking.guests_count)} />
        {eventType ? (
          <Fact label={t('owner.booking_event_type')} value={dictName(eventType, lang)} />
        ) : null}
        {booking.price_at_booking != null ? (
          <Fact label={t('owner.booking_price')} value={formatPrice(booking.price_at_booking)} />
        ) : null}
      </RowGroup>

      {booking.comment ? (
        <>
          <SectionLabel>{t('owner.booking_comment')}</SectionLabel>
          <Card>
            <Text style={styles.note} selectable>
              {booking.comment}
            </Text>
          </Card>
        </>
      ) : null}

      {booking.status === 'rejected' && booking.rejected_reason ? (
        <>
          <SectionLabel>{t('owner.reject_reason_title')}</SectionLabel>
          <Card>
            <Text style={styles.note}>{booking.rejected_reason}</Text>
          </Card>
        </>
      ) : null}

      {/* Пока идёт запрос, шторку не закрыть: иначе отказ сервера пришёл бы
          в уже закрытую шторку и владелец решил бы, что заявка отклонена. */}
      <Sheet
        visible={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title={t('owner.reject_reason_title')}
        dismissable={action !== 'reject'}
      >
        <ErrorBanner message={rejectError} />
        <Input
          value={rejectReason}
          onChangeText={setRejectReason}
          placeholder={t('owner.reject_reason_placeholder')}
          accessibilityLabel={t('owner.reject_reason_title')}
          multiline
          maxLength={REASON_MAX}
          editable={action !== 'reject'}
          style={styles.reason}
        />
        <Button
          label={t('owner.reject_confirm')}
          tone="danger"
          onPress={() => void reject()}
          busy={action === 'reject'}
          disabled={!rejectReason.trim()}
        />
      </Sheet>
    </Screen>
  );
}

interface FactProps {
  label: string;
  value: string;
  first?: boolean;
}

/**
 * Строка «подпись — значение».
 *
 * Значение идёт через right, а не через value у Row: тому отведено 45%
 * ширины и одна строка, и имя клиента или дата на узком экране обрезались
 * бы многоточием — а здесь значение и есть то, ради чего открыли экран.
 */
function Fact({ label, value, first }: FactProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Row
      first={first}
      title={label}
      accessibilityLabel={`${label}: ${value}`}
      right={
        <Text style={styles.factValue} numberOfLines={2}>
          {value}
        </Text>
      }
    />
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    head: { gap: 6 },
    subject: { fontSize: text.section, fontWeight: '700', color: colors.text },
    parent: { fontSize: text.caption, color: colors.muted },
    // Ширина ограничена, чтобы длинное значение не выдавило подпись совсем.
    factValue: {
      fontSize: text.body,
      color: colors.muted,
      textAlign: 'right',
      flexShrink: 0,
      maxWidth: '62%',
    },
    phone: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0, maxWidth: '72%' },
    phoneText: { fontSize: text.body, fontWeight: '500', color: colors.primary, flexShrink: 1 },
    note: { fontSize: text.body, lineHeight: 22, color: colors.text },
    action: { flex: 1 },
    // Причина растёт вместе с текстом; без потолка длинная вытолкнула бы
    // кнопку «Отклонить» за край шторки — прокрутки у шторки нет.
    reason: { maxHeight: 160 },
  });
