import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, bookingsApi, hallsApi } from '@/api';
import type { Booking, CalendarDay } from '@/api/types';
import { Card } from '@/components/Card';
import { ErrorBanner, Loader } from '@/components/Feedback';
import { CalendarLegend, MonthCalendar } from '@/components/MonthCalendar';
import { Screen } from '@/components/Screen';
import { space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { monthOf } from '@/utils/format';
import { pushOnce, useOnTop } from '@/utils/nav';
import { serverToday } from '@/utils/serverTime';

type ActiveStatus = 'pending' | 'confirmed';

/**
 * Владелец листает и прошлые месяцы: история зала ему нужна так же, как
 * будущее. У календаря нет режима «без нижней границы», поэтому граница
 * просто отодвинута туда, куда никто не долистает.
 */
const NO_MIN_DATE = '2000-01-01';

/** Нажимаются только дни с заявкой: на свободном дне открывать нечего. */
const isDayDisabled = (_date: string, status: CalendarDay['status'] | undefined) =>
  status !== 'pending' && status !== 'confirmed';

/**
 * Дни зала с действующими заявками. Подтверждённая заявка важнее ожидающих —
 * так же считает сервер, когда собирает календарь.
 */
function activeByDate(items: Booking[], hallGuid: string): Record<string, ActiveStatus> {
  const map: Record<string, ActiveStatus> = {};
  for (const booking of items) {
    if (booking.hall?.guid !== hallGuid) continue;
    if (booking.status === 'confirmed') map[booking.event_date] = 'confirmed';
    else if (booking.status === 'pending' && !map[booking.event_date]) map[booking.event_date] = 'pending';
  }
  return map;
}

/** Календарь занятости зала глазами владельца: день с заявкой открывает её. */
export default function HallCalendarScreen() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { hallGuid, hallName } = useLocalSearchParams<{ hallGuid: string; hallName: string }>();

  // «Сегодня» — по поясу сервера, как и у MonthCalendar: иначе на стыке
  // месяцев телефон в другом поясе показал бы один месяц, а грузил другой.
  const [month, setMonth] = useState(() => monthOf(serverToday()));
  // Занятость по месяцам: вернувшись на уже виденный месяц, показываем его
  // сразу, а свежий ответ подменяет дни без мигания.
  const [cache, setCache] = useState<Record<string, CalendarDay[]>>({});
  const [history, setHistory] = useState<Record<string, ActiveStatus>>({});
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** День, заявку которого сейчас ищем. */
  const [searching, setSearching] = useState<string | null>(null);

  // Листать можно быстрее, чем отвечает сервер: вертушку и ошибку снимает
  // только последний запрос, иначе ответ за прошлый месяц погасил бы
  // вертушку текущего.
  const lastRequest = useRef(0);
  // Состояние обновится лишь к следующему рендеру, а два нажатия подряд
  // приходят в одном — от второго запроса защищает ref.
  const searchLock = useRef(false);
  const onTop = useOnTop();

  const load = useCallback(
    async (target: string) => {
      if (!hallGuid) {
        setError(t('common.error_generic'));
        setLoading(false);
        return;
      }
      const request = ++lastRequest.current;
      setError(null);
      setFetching(true);
      try {
        const resp = await hallsApi.calendar(hallGuid, target);
        // Ответ кладём под свой месяц, даже если уже показан другой: он
        // пригодится, когда к этому месяцу вернутся.
        setCache((prev) => ({ ...prev, [target]: resp.items }));
      } catch (e) {
        if (request === lastRequest.current) {
          setError(e instanceof ApiError ? e.message : t('common.error_generic'));
        }
      } finally {
        setLoading(false);
        if (request === lastRequest.current) setFetching(false);
      }
    },
    [hallGuid, t],
  );

  /**
   * Сервер отдаёт все дни раньше сегодняшнего как «past», не глядя на заявки,
   * и прошедшее мероприятие в календаре было бы не отличить от пустого дня.
   * Заявки владельца всё равно понадобятся при нажатии на день — берём их
   * заранее и сами отмечаем прошедшие дни.
   */
  const loadHistory = useCallback(async () => {
    if (!hallGuid) return;
    try {
      const resp = await bookingsApi.incoming();
      setHistory(activeByDate(resp.items, hallGuid));
    } catch {
      // Не повод для ошибки на экране: без этого списка прошедшие дни просто
      // останутся серыми, а сам календарь пришёл своим запросом.
    }
  }, [hallGuid]);

  // Один эффект на всё: открытие экрана, перелистывание месяца и возврат с
  // экрана заявки (её могли подтвердить или отклонить — день сменит цвет).
  useFocusEffect(
    useCallback(() => {
      void load(month);
    }, [load, month]),
  );

  // Отдельно от месяца: список заявок один на все месяцы, перечитывать его
  // при каждом перелистывании незачем.
  useFocusEffect(
    useCallback(() => {
      void loadHistory();
    }, [loadHistory]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([load(month), loadHistory()]);
    setRefreshing(false);
  };

  const days = useMemo(() => {
    const base = cache[month] ?? [];
    return base.map((day) => {
      const booked = day.status === 'past' ? history[day.date] : undefined;
      return booked ? { ...day, status: booked } : day;
    });
  }, [cache, month, history]);

  const openDay = async (date: string) => {
    if (searchLock.current || !hallGuid) return;
    searchLock.current = true;
    setSearching(date);
    try {
      // Календарь знает только цвет дня, а не саму заявку, и отдельного
      // запроса «заявки зала на дату» у сервера нет — ищем во входящих.
      const resp = await bookingsApi.incoming();
      setHistory(activeByDate(resp.items, hallGuid));
      const matches = resp.items.filter(
        (b) =>
          b.event_date === date &&
          b.hall?.guid === hallGuid &&
          (b.status === 'pending' || b.status === 'confirmed'),
      );
      // На подтверждённом дне открываем именно подтверждённую заявку, а не
      // ту, что оказалась первой в списке.
      const match = matches.find((b) => b.status === 'confirmed') ?? matches[0];
      // Пока шёл запрос, с экрана могли уйти: открывать заявку поверх
      // другого экрана или показывать там сообщение уже нельзя.
      if (!onTop.current) return;
      if (match) {
        pushOnce({ pathname: '/booking', params: { bookingGuid: match.guid } });
      } else {
        Alert.alert(t('owner.calendar_booking_not_found'));
        // Заявки уже нет (клиент отменил) — значит, и цвет дня устарел.
        void load(month);
      }
    } catch (e) {
      if (onTop.current) {
        Alert.alert(e instanceof ApiError ? e.message : t('common.error_generic'));
      }
    } finally {
      searchLock.current = false;
      setSearching(null);
    }
  };

  // Без названия зала (экран открыли без параметра) заголовок оборвался бы
  // на тире.
  const title = hallName ? t('owner.calendar_title', { hall: hallName }) : t('owner.calendar_button');
  const header = <Stack.Screen options={{ headerShown: true, title }} />;

  if (loading) {
    return (
      <Screen>
        {header}
        <Loader />
      </Screen>
    );
  }

  // При обновлении жестом вертушку уже показывает сама прокрутка.
  const busy = searching !== null || (fetching && !refreshing);

  return (
    <Screen scroll refreshing={refreshing} onRefresh={onRefresh}>
      {header}
      <ErrorBanner message={error} />

      {/* Календарь не прячем за вертушкой при смене месяца: он сам помнит,
          какой месяц показан, и после размонтирования вернулся бы на текущий. */}
      <Card>
        <MonthCalendar
          // Выделение — отклик на нажатие: пока ищем заявку, видно, какой
          // день открывается.
          value={searching}
          onSelect={openDay}
          days={days}
          onMonthChange={setMonth}
          minDate={NO_MIN_DATE}
          isDisabled={isDayDisabled}
          // Диктор должен называть день теми же словами, что стоят в легенде
          // ниже, а не клиентскими «Занято» / «Ждёт ответа».
          statusLabels={{ busy: t('owner.legend_confirmed'), waiting: t('owner.legend_pending') }}
        />
        <View style={styles.foot}>
          <View style={styles.legend}>
            <CalendarLegend
              items={[
                { tone: 'waiting', label: t('owner.legend_pending') },
                { tone: 'busy', label: t('owner.legend_confirmed') },
              ]}
            />
          </View>
          {busy ? (
            <ActivityIndicator size="small" color={colors.primary} accessibilityLabel={t('common.loading')} />
          ) : null}
        </View>
        <Text style={styles.hint}>{t('owner.calendar_hint')}</Text>
      </Card>
    </Screen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Высота задана заранее: вертушка появляется и пропадает, и без запаса
    // строка с подписями дёргалась бы вместе с ней.
    foot: { flexDirection: 'row', alignItems: 'center', gap: space.gap, minHeight: 24 },
    legend: { flex: 1, minWidth: 0 },
    hint: { fontSize: text.caption, color: colors.muted },
  });
