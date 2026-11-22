import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, bookingsApi, mastersApi, providersApi, type BookingCreateBody } from '@/api';
import type { MasterLink, PublicProviderDetails } from '@/api/types';
import { Button } from '@/components/Button';
import { Card, Row, RowGroup, SectionLabel } from '@/components/Card';
import { DatePickerSheet } from '@/components/DatePickerSheet';
import { ErrorBanner, Loader } from '@/components/Feedback';
import { Field, Input, SelectField } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { formatDateHuman } from '@/utils/format';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { formatKzPhoneDisplay } from '@/utils/phone';
import { useOnTop } from '@/utils/nav';
import { serverToday } from '@/utils/serverTime';

/** Сервер отклоняет текст длиннее: лучше не дать набрать, чем вернуть ошибку. */
const COMMENT_MAX = 2000;
const ADDRESS_MAX = 500;
/** Короче «что нужно» продавцу не по чему посчитать заявку. */
const COMMENT_MIN = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Новая заявка в магазин или бригаде: что нужно, куда и к какому сроку.
 *
 * Открывается с карточки уже после входа. Заявка сама заводит чат с
 * продавцом, поэтому после отправки человек попадает на вкладку сообщений,
 * а не обратно на карточку.
 *
 * Гостя здесь не бывает: экран стоит под Stack.Protected, и если вход
 * слетит (выход, ответ 401), стек уберёт форму сам — шторка входа не нужна.
 */
export default function BookingFormScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { providerGuid, initialDate, initialComment } = useLocalSearchParams<{
    providerGuid?: string;
    initialDate?: string;
    /** Текст заявки заранее — например, позиция прайса, с которой пришли. */
    initialComment?: string;
  }>();

  const [subject, setSubject] = useState<PublicProviderDetails | null>(null);
  const [loading, setLoading] = useState(true);
  // Пустая строка — причина неизвестна: общий текст подставляется при
  // отрисовке, чтобы t не попадал в зависимости загрузки.
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);

  // Чужой адрес может принести что угодно, поэтому мусор и прошедший день
  // отбрасываем. «Прошедший» — по поясу сервера: дату заявки проверяет он.
  const [date, setDate] = useState<string | null>(() =>
    initialDate && DATE_RE.test(initialDate) && initialDate >= serverToday() ? initialDate : null,
  );
  const [dateOpen, setDateOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [comment, setComment] = useState(() => (initialComment ?? '').slice(0, COMMENT_MAX));

  // Клиенты, для которых я заказываю как мастер. Пусто — выбора «для кого»
  // нет вовсе: у большинства людей клиентов нет.
  const [clients, setClients] = useState<MasterLink[]>([]);
  /** guid связи с клиентом; null — заявка для себя. */
  const [forLink, setForLink] = useState<string | null>(null);

  const [needDate, setNeedDate] = useState(false);
  const [needComment, setNeedComment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Заявка ушла, а уйти с формы к сообщениям не вышло (см. send). */
  const [sent, setSent] = useState(false);
  // Замок, а не только состояние: два быстрых нажатия успевают пройти до
  // перерисовки кнопки, и второй запрос вернул бы «заявка уже есть» поверх
  // успешно отправленной первой.
  const locked = useRef(false);

  // Сверху ли ещё форма: переход к сообщениям после ответа выдернул бы
  // человека с экрана, который он уже открыл поверх.
  const onTop = useOnTop();

  useEffect(() => {
    let alive = true;
    setSubject(null);
    setLoadError('');
    setLoading(true);
    (async () => {
      try {
        if (!providerGuid) return;
        const { provider } = await providersApi.getPublic(providerGuid);
        if (alive) setSubject(provider);
      } catch (e) {
        if (alive) setLoadError(e instanceof ApiError ? e.message : '');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [providerGuid, attempt]);

  // Молча: без списка клиентов форма остаётся обычной заявкой для себя.
  useEffect(() => {
    let alive = true;
    mastersApi
      .list()
      .then((r) => {
        if (alive) setClients(r.clients);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const isService = subject?.category.kind === 'service';

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
      return;
    }
    // Форму накрыли другим экраном, пока шёл запрос: уводить его к
    // сообщениям нельзя. Кнопку и замок оставляем: заявка уже ушла.
    if (!onTop.current) {
      setSubmitting(false);
      setSent(true);
      return;
    }
    // Заявка мастера ждёт клиента, чата с продавцом ещё нет: ведём к своим
    // оформленным заявкам вместо сообщений.
    if (body.master_link_guid) {
      router.replace('/ordered-bookings');
      return;
    }
    // Именно dismissTo: push положил бы поверх стека вторую копию вкладок.
    router.dismissTo('/messages');
  };

  const submit = () => {
    if (!subject || locked.current) return;
    // С открытой клавиатурой поля с ошибкой могут быть за краем экрана.
    Keyboard.dismiss();
    const what = comment.trim();
    const noComment = what.length < COMMENT_MIN;
    if (!date || noComment) {
      setNeedDate(!date);
      setNeedComment(noComment);
      setError(null);
      return;
    }
    void send({
      provider_guid: subject.guid,
      event_date: date,
      address: address.trim() || undefined,
      comment: what,
      master_link_guid: forLink ?? undefined,
    });
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
        {providerGuid ? (
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
  const subjectMeta = [dictName(subject.category, lang), dictName(subject.city, lang)].join(' · ');

  // Порядок как на экране: в полосе у кнопки — ошибка верхнего поля.
  const fieldError = needComment
    ? t('booking_form.need_comment')
    : needDate
      ? t('booking_form.need_date')
      : null;

  return (
    <Screen
      scroll
      footer={
        // Ошибки стоят над кнопкой, а не вверху формы: заявку обычно
        // отправляют из нижнего поля, когда верх прокручен.
        <View style={styles.footer}>
          <ErrorBanner message={error ?? fieldError} announce={!!error} />
          <Button
            label={forLink ? t('booking_form.submit_for_client') : t('booking_form.submit')}
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
        <Text style={styles.subjectMeta} numberOfLines={2}>
          {subjectMeta}
        </Text>
      </Card>

      {clients.length > 0 ? (
        <View style={styles.forWhom}>
          <SectionLabel>{t('booking_form.for_whom')}</SectionLabel>
          <RowGroup>
            {[null, ...clients].map((c, i) => {
              const guid = c?.guid ?? null;
              const selected = forLink === guid;
              const title = c
                ? c.name || formatKzPhoneDisplay(c.phone ?? '')
                : t('booking_form.for_me');
              return (
                <Row
                  key={guid ?? 'me'}
                  first={i === 0}
                  title={title}
                  icon={c ? 'account-hard-hat-outline' : 'account-outline'}
                  onPress={() => setForLink(guid)}
                  // Своей роли «переключатель из нескольких» у Row нет: выбор
                  // проговариваем словами.
                  accessibilityLabel={selected ? t('booking_form.for_selected', { name: title }) : title}
                  right={
                    <Icon
                      name={selected ? 'radiobox-marked' : 'radiobox-blank'}
                      size={22}
                      color={selected ? colors.primary : colors.muted}
                    />
                  }
                />
              );
            })}
          </RowGroup>
          {forLink ? <Text style={styles.subjectMeta}>{t('booking_form.for_client_hint')}</Text> : null}
        </View>
      ) : null}

      <Card>
        <Field
          label={isService ? t('booking_form.comment_label_service') : t('booking_form.comment_label_material')}
          error={needComment ? t('booking_form.need_comment') : null}
        >
          <Input
            value={comment}
            onChangeText={(value) => {
              setComment(value);
              setNeedComment(false);
            }}
            placeholder={
              isService
                ? t('booking_form.comment_placeholder_service')
                : t('booking_form.comment_placeholder_material')
            }
            multiline
            maxLength={COMMENT_MAX}
            invalid={needComment}
            accessibilityLabel={
              isService ? t('booking_form.comment_label_service') : t('booking_form.comment_label_material')
            }
          />
        </Field>

        <Field
          label={isService ? t('booking_form.date_label_service') : t('booking_form.date_label_material')}
          error={needDate ? t('booking_form.need_date') : null}
        >
          <SelectField
            value={dateText}
            placeholder={t('booking_form.date_placeholder')}
            onPress={openDate}
            icon="calendar"
            invalid={needDate}
          />
        </Field>

        <Field label={t('booking_form.address_label')} hint={t('booking_form.address_hint')}>
          <Input
            value={address}
            onChangeText={setAddress}
            placeholder={t('booking_form.address_placeholder')}
            maxLength={ADDRESS_MAX}
            accessibilityLabel={t('booking_form.address_label')}
          />
        </Field>
      </Card>

      <DatePickerSheet
        visible={dateOpen}
        value={date}
        onChange={pickDate}
        onClose={() => setDateOpen(false)}
        title={isService ? t('booking_form.date_label_service') : t('booking_form.date_label_material')}
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
    forWhom: { gap: 8 },
  });
