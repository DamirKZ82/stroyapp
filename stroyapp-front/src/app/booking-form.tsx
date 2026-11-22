import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  ApiError,
  bookingsApi,
  dictsApi,
  hallsApi,
  providersApi,
  type BookingCreateBody,
} from '@/api';
import type { CalendarDay, CategoryBrief, City, EventType } from '@/api/types';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip, ChipWrap } from '@/components/Chip';
import { DatePickerSheet } from '@/components/DatePickerSheet';
import { ErrorBanner, Loader } from '@/components/Feedback';
import { Field, Input, SelectField } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { space, text, type ThemeColors } from '@/theme';
import { useThemedStyles } from '@/theme/scheme';
import { formatDateHuman, formatPrice, monthOf } from '@/utils/format';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { useOnTop } from '@/utils/nav';
import { intOrNull, onlyDigits } from '@/utils/number';
import { serverToday } from '@/utils/serverTime';

/** Сервер отклоняет комментарий длиннее: лучше не дать набрать, чем вернуть ошибку. */
const COMMENT_MAX = 2000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** То, на что подаётся заявка: зал или исполнитель в одном виде. */
interface Subject {
  guid: string;
  name: string;
  isHall: boolean;
  /** Вторая строка карточки: у зала — заведение, у исполнителя — категория. */
  venueName: string | null;
  category: CategoryBrief | null;
  city: City;
  capacityMin: number | null;
  capacityMax: number | null;
  /** Цена, пока календарь не сказал точнее: будни зала или «от» исполнителя. */
  basePrice: number | null;
}

async function fetchSubject(hallGuid?: string, providerGuid?: string): Promise<Subject | null> {
  // Параметр должен быть один. Если пришли оба — берём исполнителя: так
  // решал и старый экран.
  if (providerGuid) {
    const { provider } = await providersApi.getPublic(providerGuid);
    return {
      guid: provider.guid,
      name: provider.name,
      isHall: false,
      venueName: null,
      category: provider.category,
      city: provider.city,
      capacityMin: null,
      capacityMax: null,
      basePrice: provider.price_from,
    };
  }
  if (hallGuid) {
    const { hall } = await hallsApi.getPublic(hallGuid);
    return {
      guid: hall.guid,
      name: hall.name,
      isHall: true,
      venueName: hall.venue.name,
      category: null,
      city: hall.city,
      capacityMin: hall.capacity_min,
      capacityMax: hall.capacity_max,
      basePrice: hall.price_weekday,
    };
  }
  return null;
}

/**
 * Новая заявка на зал или исполнителя.
 *
 * Открывается с карточки уже после входа. Заявка сама заводит чат с
 * владельцем, поэтому после отправки человек попадает на вкладку сообщений,
 * а не обратно на карточку.
 *
 * Гостя здесь не бывает: экран стоит под Stack.Protected, и если вход
 * слетит (выход, ответ 401), стек уберёт форму сам — шторка входа не нужна.
 */
export default function BookingFormScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const { hallGuid, providerGuid, initialDate } = useLocalSearchParams<{
    hallGuid?: string;
    providerGuid?: string;
    initialDate?: string;
  }>();

  const [subject, setSubject] = useState<Subject | null>(null);
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [loading, setLoading] = useState(true);
  // Пустая строка — причина неизвестна: общий текст подставляется при
  // отрисовке, чтобы t не попадал в зависимости загрузки.
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);

  // Дата из параметра — задел: карточки её пока не передают. Чужой адрес
  // может принести что угодно, поэтому мусор и прошедший день отбрасываем.
  // «Прошедший» — по поясу сервера: дату заявки проверяет он.
  const [date, setDate] = useState<string | null>(() =>
    initialDate && DATE_RE.test(initialDate) && initialDate >= serverToday() ? initialDate : null,
  );
  const [dateOpen, setDateOpen] = useState(false);
  const [guests, setGuests] = useState('');
  const [eventTypeId, setEventTypeId] = useState<number | null>(null);
  const [comment, setComment] = useState('');

  const [needDate, setNeedDate] = useState(false);
  const [needGuests, setNeedGuests] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Заявка ушла, а уйти с формы к сообщениям не вышло (см. send). */
  const [sent, setSent] = useState(false);
  // Замок, а не только состояние: два быстрых нажатия успевают пройти до
  // перерисовки кнопки, и второй запрос вернул бы «у вас уже есть заявка на
  // эту дату» поверх успешно отправленного первого.
  const locked = useRef(false);

  // Сверху ли ещё форма. Человек может уйти назад, не дождавшись ответа, или
  // поверх откроется другой экран, а router действует на тот экран, что
  // сейчас сверху: переход к сообщениям выдернул бы его с карточки, которую
  // он уже снова читает.
  const onTop = useOnTop();

  const [calCache, setCalCache] = useState<Record<string, CalendarDay[]>>({});
  // Месяцы, которые уже загружены или грузятся прямо сейчас. Отдельно от
  // calCache, потому что спрашивают о них из обработчиков, где состояние
  // может быть вчерашним, и потому что «в пути» в кэше ещё не видно.
  const requested = useRef(new Set<string>());

  useEffect(() => {
    let alive = true;
    // Занятость принадлежит конкретному залу: при смене параметров и при
    // повторе загрузки начинаем с чистого кэша.
    requested.current.clear();
    setCalCache({});
    setSubject(null);
    setLoadError('');
    setLoading(true);

    // Тип мероприятия в заявке необязателен, поэтому сбой справочника не
    // должен ронять всю форму — просто не будет чипов.
    const typesRequest = dictsApi
      .eventTypes()
      .then((resp) => resp.items)
      .catch(() => [] as EventType[]);

    (async () => {
      try {
        const [next, types] = await Promise.all([fetchSubject(hallGuid, providerGuid), typesRequest]);
        if (!alive) return;
        setEventTypes(types);
        setSubject(next);
      } catch (e) {
        if (!alive) return;
        setLoadError(e instanceof ApiError ? e.message : '');
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [hallGuid, providerGuid, attempt]);

  const loadMonth = useCallback(
    (month: string) => {
      if (!subject || requested.current.has(month)) return;
      requested.current.add(month);
      const request = subject.isHall
        ? hallsApi.calendar(subject.guid, month)
        : providersApi.calendar(subject.guid, month);
      request
        .then((resp) => setCalCache((prev) => ({ ...prev, [month]: resp.items })))
        .catch(() => {
          // Занятость — подсказка, а не условие: без неё форма работает, а
          // дату всё равно проверит сервер. Месяц снимаем с учёта, чтобы
          // следующий заход на него попробовал ещё раз.
          requested.current.delete(month);
        });
    },
    [subject],
  );

  // Цена в подсказке берётся из календаря, а он грузится по месяцам из
  // шторки. Этот вызов нужен для двух случаев, когда шторка не помогла: дата
  // пришла параметром, или запрос месяца не удался, а день в нём уже выбран.
  // Загруженный месяц loadMonth повторно не запрашивает.
  useEffect(() => {
    if (date) loadMonth(monthOf(date));
  }, [date, loadMonth]);

  const calendarAll = useMemo(() => Object.values(calCache).flat(), [calCache]);

  const priceOnDate = useMemo(() => {
    if (!subject || !date) return null;
    const day = calendarAll.find((d) => d.date === date);
    return day?.price ?? subject.basePrice;
  }, [subject, date, calendarAll]);

  const pickDate = (next: string | null) => {
    setDate(next);
    if (next) setNeedDate(false);
  };

  const openDate = () => {
    // Иначе шторка выезжает поверх открытой клавиатуры и прыгает вместе с ней.
    Keyboard.dismiss();
    setDateOpen(true);
  };

  const send = async (body: BookingCreateBody) => {
    if (locked.current) return;
    locked.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await bookingsApi.create(body);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      setSubmitting(false);
      locked.current = false;
      // Частая причина отказа — день заняли, пока форма была открыта. Месяц
      // остаётся на экране как есть, но при следующем открытии шторки
      // запросится заново.
      requested.current.delete(monthOf(body.event_date));
      return;
    }
    // Форму накрыли другим экраном, пока шёл запрос: уводить его к
    // сообщениям нельзя. Гасим вертушку, чтобы после возврата форма не
    // крутила её без конца, а кнопку и замок оставляем: заявка уже ушла, и
    // повторное нажатие дало бы вторую.
    if (!onTop.current) {
      setSubmitting(false);
      setSent(true);
      return;
    }
    // Замок и вертушку после успеха не снимаем: экран уже уходит, и второе
    // нажатие за эти мгновения дало бы вторую заявку.
    // Именно dismissTo: push положил бы поверх стека вторую копию вкладок.
    router.dismissTo('/messages');
  };

  const submit = () => {
    if (!subject || locked.current) return;
    // С открытой клавиатурой поля с ошибкой могут быть за краем экрана.
    Keyboard.dismiss();

    const count = intOrNull(guests);
    const noGuests = count == null || count <= 0;
    if (!date || noGuests) {
      setNeedDate(!date);
      setNeedGuests(noGuests);
      setError(null);
      return;
    }

    const body: BookingCreateBody = {
      hall_guid: subject.isHall ? subject.guid : undefined,
      provider_guid: subject.isHall ? undefined : subject.guid,
      event_date: date,
      guests_count: count,
      event_type_id: eventTypeId ?? undefined,
      comment: comment.trim() || undefined,
    };
    void send(body);
  };

  const header = <Stack.Screen options={{ headerShown: true, title: t('booking_form.title') }} />;

  if (loading) {
    return (
      <Screen>
        {header}
        <Loader />
      </Screen>
    );
  }

  if (!subject) {
    return (
      <Screen scroll>
        {header}
        <ErrorBanner message={loadError || t('common.error_generic')} />
        {/* Без guid повторять нечего: экран открыли по неполному адресу. */}
        {hallGuid || providerGuid ? (
          <Button
            label={t('common.retry')}
            variant="outline"
            onPress={() => setAttempt((n) => n + 1)}
          />
        ) : null}
      </Screen>
    );
  }

  const dateText = date ? formatDateHuman(date, lang) : null;
  const subjectMeta = [
    subject.isHall ? subject.venueName : subject.category ? dictName(subject.category, lang) : null,
    dictName(subject.city, lang),
  ]
    .filter(Boolean)
    .join(' · ');

  // Порядок как на экране: в полосе у кнопки — ошибка верхнего поля.
  const fieldError = needDate
    ? t('booking_form.need_date')
    : needGuests
      ? t('booking_form.need_guests')
      : null;

  return (
    <Screen
      scroll
      footer={
        // Ошибки стоят над кнопкой, а не вверху формы: заявку обычно
        // отправляют из поля комментария, когда верх прокручен, — без полосы
        // «Выберите дату» осталась бы за экраном и нажатие казалось бы
        // пропущенным. Отказы сервера здесь будничные — «дата занята»,
        // «зал рассчитан до 300».
        <View style={styles.footer}>
          {/* Ошибку поля диктору уже проговорил её Field — полоса лишь
              показывает её зрячим и второй раз не объявляет. */}
          <ErrorBanner message={error ?? fieldError} announce={!!error} />
          <Button
            label={t('booking_form.submit')}
            onPress={submit}
            busy={submitting}
            disabled={sent}
          />
        </View>
      }
    >
      {header}

      <Card style={styles.subject}>
        <Text style={styles.subjectName} numberOfLines={2}>
          {subject.name}
        </Text>
        {subjectMeta ? (
          <Text style={styles.subjectMeta} numberOfLines={2}>
            {subjectMeta}
          </Text>
        ) : null}
      </Card>

      <Card>
        <Field
          label={t('booking_form.date_label')}
          error={needDate ? t('booking_form.need_date') : null}
          hint={
            dateText && priceOnDate != null
              ? `${t('booking_form.price_on_date', { date: dateText })}: ${formatPrice(priceOnDate)}`
              : undefined
          }
        >
          <SelectField
            value={dateText}
            placeholder={t('booking_form.date_placeholder')}
            onPress={openDate}
            icon="calendar"
            invalid={needDate}
          />
        </Field>

        <Field
          label={t('booking_form.guests_label')}
          error={needGuests ? t('booking_form.need_guests') : null}
        >
          <Input
            value={guests}
            onChangeText={(value) => {
              setGuests(onlyDigits(value, 5));
              setNeedGuests(false);
            }}
            keyboardType="number-pad"
            placeholder={
              subject.capacityMax ? `${subject.capacityMin ?? 1}–${subject.capacityMax}` : '150'
            }
            invalid={needGuests}
            accessibilityLabel={t('booking_form.guests_label')}
          />
        </Field>

        {eventTypes.length > 0 ? (
          <Field label={t('booking_form.event_type_label')}>
            <ChipWrap>
              {eventTypes.map((type) => (
                <Chip
                  key={type.id}
                  label={dictName(type, lang)}
                  selected={eventTypeId === type.id}
                  // Повторное нажатие снимает выбор: тип необязателен.
                  onPress={() => setEventTypeId(eventTypeId === type.id ? null : type.id)}
                />
              ))}
            </ChipWrap>
          </Field>
        ) : null}

        <Field label={t('booking_form.comment_label')}>
          <Input
            value={comment}
            onChangeText={setComment}
            placeholder={t('booking_form.comment_placeholder')}
            multiline
            maxLength={COMMENT_MAX}
            accessibilityLabel={t('booking_form.comment_label')}
          />
        </Field>
      </Card>

      <DatePickerSheet
        visible={dateOpen}
        value={date}
        onChange={pickDate}
        onClose={() => setDateOpen(false)}
        calendar={calendarAll}
        title={t('booking_form.date_label')}
        // Шторка сообщает месяц и при открытии, и при листании: занятость
        // догружается для каждого показанного, а не только для текущего.
        onMonthChange={loadMonth}
      />
    </Screen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    subject: { gap: 4 },
    subjectName: { fontSize: text.subtitle, fontWeight: '600', color: colors.text },
    subjectMeta: { fontSize: text.caption, color: colors.muted },
    footer: { flex: 1, gap: space.gap },
  });
