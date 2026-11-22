import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, authApi, profileApi } from '@/api';
import { PRIVACY_URL, TERMS_URL } from '@/config';
import { useAuthGateStore, type AuthGateReason } from '@/store/authGateStore';
import { useAuthStore, type User } from '@/store/authStore';
import { space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { pendingLoginStep } from '@/store/useRequireAuth';
import { confirmDestructive } from '@/utils/alert';
import { useLang } from '@/utils/lang';
import { openPage } from '@/utils/links';
import { onlyDigits } from '@/utils/number';
import { formatKzPhoneDisplay, maskPhoneInput, normalizeKzPhone } from '@/utils/phone';
import { Button } from './Button';
import { Row } from './Card';
import { ErrorBanner, useAnnounce } from './Feedback';
import { Field, Input } from './Field';
import { Sheet } from './Sheet';

type Step = 'phone' | 'otp' | 'terms' | 'profile';

const PHONE_START = '+7 ';
const OTP_LENGTH = 4;
const RESEND_SEC = 60;
const OTP_SPACING = 12;

// Ключи выписаны целиком, а не склеены из `reason_${reason}`: так их находит
// поиск по проекту, а новая причина без перевода не соберётся.
const REASON_KEY: Record<AuthGateReason, string> = {
  book: 'auth_gate.reason_book',
  favorite: 'auth_gate.reason_favorite',
  message: 'auth_gate.reason_message',
  generic: 'auth_gate.reason_generic',
};

/**
 * Вход — единственный на всё приложение: шторка поверх любого экрана.
 *
 * Открывает её authGateStore (через useRequireAuth), монтируется она один
 * раз в корневом макете. Шаги в одной шторке: телефон → код → согласие с
 * Условиями использования → имя. Согласие и имя спрашиваются, только если
 * их ещё нет: вернувшийся человек после кода сразу внутри.
 *
 * Шторка не закрывается сама, когда в authStore появился токен: fireSuccess
 * зовётся явно — после последнего нужного шага. Иначе она закрывалась бы
 * посреди регистрации: токен уже выдан, а условия не приняты и имя ещё не
 * введено.
 */
export function AuthGateSheet() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const lang = useLang();

  const visible = useAuthGateStore((s) => s.visible);
  const reason = useAuthGateStore((s) => s.reason);
  const close = useAuthGateStore((s) => s.close);
  const fireSuccess = useAuthGateStore((s) => s.fireSuccess);

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState(PHONE_START);
  const [otp, setOtp] = useState('');
  const [fullName, setFullName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  // Каждое открытие начинается с чистого шага. Сброс — прямо в рендере, а
  // не в useEffect: эффект срабатывает после отрисовки, и шторка на кадр
  // показывала бы прошлый шаг и ставила фокус в его поле.
  //
  // Обычно первый шаг — телефон. Но если человек уже подтвердил номер и
  // закрыл шторку на согласии или на вопросе об имени, токен у него есть,
  // и начинать с телефона — значит слать ему второе СМС ради того же
  // самого. Сюда же попадает тот, кто вошёл в прежней версии приложения,
  // где согласия ещё не было: ему осталось только принять условия.
  const [shown, setShown] = useState(false);
  if (visible !== shown) {
    setShown(visible);
    if (visible) {
      const auth = useAuthStore.getState();
      setStep((auth.token ? pendingLoginStep(auth.user) : null) ?? 'phone');
      setPhone(PHONE_START);
      setOtp('');
      setFullName('');
      setLoading(false);
      setError(null);
      setResendIn(0);
    }
  }

  // Остаток считается от момента отправки по часам, а не убавлением на
  // единицу: за кодом уходят в приложение СМС, а в фоне таймеры стоят —
  // по возвращении отсчёт продолжался бы с того же места.
  const resendUntil = useRef(0);
  const waiting = resendIn > 0;
  // Только пока шторка открыта: она смонтирована в корне всегда, и после
  // закрытия на шаге с кодом отсчёт ещё минуту перерисовывал бы её впустую.
  const ticking = visible && waiting;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => {
      setResendIn(Math.max(0, Math.ceil((resendUntil.current - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const fail = (e: unknown) => {
    setError(e instanceof ApiError ? e.message : t('common.error_generic'));
  };

  // После каждого шага: что ещё осталось — туда и идём, ничего — вход
  // закончен. Один путь для кода, согласия и имени: шаг, пропущенный в одном
  // из трёх мест, закрыл бы шторку раньше времени, и человек остался бы
  // гостем, так и не увидев, чего от него ждали.
  const advance = (user: User) => {
    const next = pendingLoginStep(user);
    if (next) {
      setStep(next);
    } else {
      fireSuccess();
    }
  };

  const onPhoneChange = (value: string) => {
    let digits = value.replace(/\D/g, '');
    // Номер вставили целиком в поле, где уже стоит «+7»: код страны задвоился,
    // и маска молча обрезала бы хвост — код ушёл бы на чужой номер.
    if (value.length - phone.length > 1 && digits.length > 11 && digits.startsWith('7')) {
      digits = digits.slice(1);
    }
    // Поле заменили целиком (вставка поверх, автозаполнение) номером без кода
    // страны: маска приняла бы его первую семёрку за «+7» и сдвинула цифры.
    if (!value.trimStart().startsWith('+') && digits.length === 10) digits = `7${digits}`;
    // По привычке набирают «8 701 …» после нашей «+7». Мобильных кодов на 8 в
    // Казахстане нет (normalizeKzPhone ждёт +77…), так что восьмёрка лишняя.
    if (digits.startsWith('78')) digits = `7${digits.slice(2)}`;
    const masked = maskPhoneInput(digits);
    // Стёрли скобку или пробел: цифры те же, и маска вернула бы символ на
    // место — номер нельзя было бы стереть дальше «)». Убираем цифру сами.
    if (value.length < phone.length && masked === phone) {
      setPhone(maskPhoneInput(phone.replace(/\D/g, '').slice(0, -1)));
      return;
    }
    setPhone(masked);
  };

  const sendOtp = async () => {
    const normalized = normalizeKzPhone(phone);
    if (!normalized) {
      setError(t('auth.phone_invalid'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await authApi.requestOtp(normalized);
      // Прежний код после новой отправки не подойдёт — поле начинаем заново.
      setOtp('');
      setStep('otp');
      resendUntil.current = Date.now() + RESEND_SEC * 1000;
      setResendIn(RESEND_SEC);
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  };

  const verifyOtp = async () => {
    if (otp.length !== OTP_LENGTH) {
      setError(t('auth.otp_invalid'));
      return;
    }
    const normalized = normalizeKzPhone(phone);
    if (!normalized) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authApi.verifyOtp(normalized, otp);
      let user = res.user;
      // Тому, кто ещё не закончил регистрацию, сервер ставит русский язык, а
      // человек мог гостем переключить приложение на казахский. Оставляем
      // его выбор: setAuth переключает язык на язык профиля, и следующие
      // шаги — согласие с условиями и имя — показались бы не на том языке.
      // У вернувшегося человека, наоборот, главный язык — из профиля.
      const keepLanguage = !user.full_name && user.language !== lang;
      if (keepLanguage) user = { ...user, language: lang };
      await useAuthStore.getState().setAuth(res.token, user);
      if (keepLanguage) {
        // Записываем выбор в профиль сразу и дожидаемся ответа: следующие
        // запросы возвращают пользователя целиком, и язык из прежнего
        // ответа переключил бы приложение обратно. Не получилось — вход от
        // этого не срывается: приложение останется на языке профиля, а
        // сменить его можно на вкладке «Профиль».
        try {
          user = (await profileApi.patch({ language: lang })).user;
          await useAuthStore.getState().setUser(user);
        } catch {
          // Вход уже состоялся — сбой этого запроса его не отменяет.
        }
      }
      advance(user);
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  };

  const acceptTerms = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await profileApi.acceptTerms(useAuthStore.getState().user?.terms_version);
      await useAuthStore.getState().setUser(res.user);
      advance(res.user);
    } catch (e) {
      fail(e);
      // 409 — условия сменились, пока шторка была открыта. Берём новую
      // версию: человек откроет условия ещё раз и нажмёт «Принимаю» уже под
      // ними. Не вышло — останется сообщение, а версия придёт при запуске.
      if (e instanceof ApiError && e.status === 409) {
        try {
          const fresh = await profileApi.get();
          await useAuthStore.getState().setUser(fresh.user);
        } catch {
          // сообщение об ошибке уже показано
        }
      }
      // На 401 клиент API сам стирает токен: принимать условия уже не под
      // кем — возвращаем к телефону, как и на шаге с именем.
      if (!useAuthStore.getState().token) setStep('phone');
    } finally {
      setLoading(false);
    }
  };

  // Не согласен — значит, и аккаунтом не пользуется: выходим. С
  // подтверждением: кнопка стоит прямо под главной, а промах стоил бы
  // выхода и нового СМС.
  const declineTerms = () => {
    confirmDestructive(
      t('terms.decline_title'),
      t('terms.decline_text'),
      () => {
        void useAuthStore.getState().logout();
        close();
      },
      t('profile.logout'),
    );
  };

  // Не стрелка: строка уводит из приложения в браузер. Значок скрыт от
  // диктора, как значки самой Row, — иначе в подписи строки прочёлся бы
  // символ шрифта.
  const external = (
    <Icon
      name="open-in-new"
      size={18}
      color={colors.muted}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );

  const openDocument = async (url: string) => {
    // Открыть нечем — на телефоне нет браузера. Молчать нельзя: человек
    // нажал, и ничего не произошло.
    if (!(await openPage(url))) setError(t('common.error_generic'));
  };

  const saveProfile = async () => {
    // Сюда приходят и с клавиши «Готово», а её, в отличие от кнопки, на время
    // запроса не выключить — второе нажатие слало бы запрос повторно.
    if (loading) return;
    const name = fullName.trim();
    if (!name) {
      setError(t('auth.fullname_required'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await profileApi.patch({ full_name: name });
      await useAuthStore.getState().setUser(res.user);
      // Не fireSuccess напрямую: у вошедшего в прежней версии приложения имя
      // могло быть не введено, а согласия ещё не было — после имени ему
      // нужен шаг согласия.
      advance(res.user);
    } catch (e) {
      fail(e);
      // На 401 клиент API сам стирает токен. Сохранять имя уже не под кем —
      // возвращаем к телефону, иначе человек упирался бы в ошибку без выхода.
      if (!useAuthStore.getState().token) setStep('phone');
    } finally {
      setLoading(false);
    }
  };

  const backToPhone = () => {
    setError(null);
    setOtp('');
    setStep('phone');
  };

  const title =
    step === 'phone'
      ? t('auth_gate.title')
      : step === 'otp'
        ? t('auth.otp_title')
        : step === 'terms'
          ? t('terms.title')
          : t('auth.profile_title');

  const subtitle =
    step === 'phone'
      ? t(REASON_KEY[reason] ?? REASON_KEY.generic)
      : step === 'otp'
        ? t('auth.otp_subtitle', {
            phone: formatKzPhoneDisplay(normalizeKzPhone(phone) ?? ''),
          })
        : step === 'terms'
          ? t('terms.intro')
          : t('auth.profile_subtitle');

  // На шаге согласия полей нет. Поле кода, с которого сюда приходят, при
  // размонтировании снимает фокус само, но клавиатуру убираем и явно: над
  // ней остались бы кнопки, под ней — текст условий.
  useEffect(() => {
    if (visible && step === 'terms') Keyboard.dismiss();
  }, [visible, step]);

  // Зрячему смену шага видно: сменились заголовок и содержимое. Диктор же
  // остаётся на исчезнувшей кнопке, и без слов человек не узнал бы, что
  // теперь от него ждут согласия или имени. Первый шаг не объявляем: шторка
  // только что открылась, и её заголовок диктор читает сам.
  useAnnounce(visible && step !== 'phone' ? title : null);

  return (
    // Пока идёт запрос, закрыть нельзя: ответ пришёл бы в закрытую шторку,
    // а человек остался бы с токеном, не зная, вошёл он или нет.
    <Sheet visible={visible} onClose={close} title={title} dismissable={!loading}>
      {/* Своя прокрутка: на маленьком экране шаг с кодом вместе с цифровой
          клавиатурой не помещается, а сама шторка содержимое не прокручивает. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        // На шаге согласия полоса прокрутки нужна: при крупном шрифте текст
        // не помещается, и без неё не видно, что ниже есть ещё.
        showsVerticalScrollIndicator={step === 'terms'}
        alwaysBounceVertical={false}
      >
        <Text style={styles.subtitle}>{subtitle}</Text>
        {/* У шага согласия ошибка стоит внизу, рядом с кнопками. */}
        {step === 'terms' ? null : <ErrorBanner message={error} />}

        {step === 'phone' ? (
          <>
            <Input
              value={phone}
              onChangeText={onPhoneChange}
              placeholder={t('auth.phone_placeholder')}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoComplete="tel"
              autoFocus
              accessibilityLabel={t('auth.phone_subtitle')}
            />
            <Button label={t('auth.phone_button')} onPress={sendOtp} busy={loading} />
          </>
        ) : null}

        {step === 'otp' ? (
          <>
            <Field hint={__DEV__ ? t('auth.otp_hint') : undefined}>
              <Input
                value={otp}
                // Код остаётся строкой: число потеряло бы ведущий ноль у «0427».
                onChangeText={(v) => setOtp(onlyDigits(v, OTP_LENGTH))}
                placeholder={t('auth.otp_placeholder')}
                keyboardType="number-pad"
                maxLength={OTP_LENGTH}
                textContentType="oneTimeCode"
                autoComplete="sms-otp"
                autoFocus
                style={styles.otp}
                accessibilityLabel={t('auth.otp_title')}
              />
            </Field>
            <Button
              label={t('auth.otp_button')}
              onPress={verifyOtp}
              busy={loading}
              disabled={otp.length !== OTP_LENGTH}
            />
            {waiting ? (
              // Той же высоты, что кнопка-ссылка: когда отсчёт кончается,
              // строки ниже не прыгают.
              <View style={styles.wait}>
                <Text style={styles.waitText}>{t('auth.otp_resend_in', { sec: resendIn })}</Text>
              </View>
            ) : (
              <Button
                label={t('auth.otp_resend')}
                variant="text"
                onPress={sendOtp}
                disabled={loading}
              />
            )}
            <Button
              label={t('common.back')}
              variant="text"
              onPress={backToPhone}
              disabled={loading}
            />
          </>
        ) : null}

        {step === 'terms' ? (
          <>
            {/* Главное из условий — прямо здесь, а не только по ссылке: что
                запрещено и что за это будет, человек должен увидеть до того,
                как согласится. */}
            <Text style={styles.rules}>{t('terms.rules')}</Text>
            {/* У строки свои поля по бокам; отрицательный отступ их гасит,
                чтобы текст строк стоял на одной линии с текстом шторки. */}
            <View style={styles.documents}>
              <Row
                first
                title={t('terms.title')}
                icon="file-document-outline"
                accessibilityRole="link"
                onPress={() => void openDocument(TERMS_URL)}
                right={external}
              />
              <Row
                title={t('profile.privacy')}
                icon="shield-lock-outline"
                accessibilityRole="link"
                onPress={() => void openDocument(PRIVACY_URL)}
                right={external}
              />
            </View>
          </>
        ) : null}

        {step === 'profile' ? (
          <>
            <Input
              value={fullName}
              onChangeText={setFullName}
              placeholder={t('auth.full_name_placeholder')}
              textContentType="name"
              autoComplete="name"
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={saveProfile}
              autoFocus
              accessibilityLabel={t('auth.full_name_placeholder')}
            />
            <Button
              label={t('auth.profile_save')}
              onPress={saveProfile}
              busy={loading}
              disabled={!fullName.trim()}
            />
          </>
        ) : null}
      </ScrollView>
      {/* Кнопки шага согласия — под прокруткой, а не в ней: на маленьком
          экране с крупным шрифтом текст не помещается, и главная кнопка
          ушла бы за край без всякого намёка. Ошибка — тут же, рядом с
          кнопкой, которую нажали. */}
      {step === 'terms' ? (
        <View style={styles.footer}>
          <ErrorBanner message={error} />
          <Button label={t('terms.accept')} onPress={acceptTerms} busy={loading} />
          <Button
            label={t('terms.decline')}
            variant="text"
            onPress={declineTerms}
            disabled={loading}
          />
        </View>
      ) : null}
    </Sheet>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Без flexGrow: 0 прокрутка растягивает шторку на всю разрешённую высоту.
    scroll: { flexGrow: 0 },
    body: { gap: space.gap },
    subtitle: { fontSize: text.body, color: colors.muted },
    rules: { fontSize: text.body, lineHeight: 22, color: colors.text },
    documents: { marginHorizontal: -space.page },
    footer: { gap: space.gap },
    otp: {
      fontSize: text.metric,
      fontWeight: '600',
      textAlign: 'center',
      letterSpacing: OTP_SPACING,
      fontVariant: ['tabular-nums'],
      // iOS добавляет разрядку и после последней цифры, из-за чего код стоит
      // левее центра на половину разрядки. Сдвигаем обратно отступом слева.
      // Android делит разрядку поровну по обе стороны цифры — там не нужно.
      ...(Platform.OS === 'ios' ? { paddingLeft: OTP_SPACING, paddingRight: 0 } : null),
    },
    wait: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    waitText: { fontSize: text.caption, color: colors.muted, textAlign: 'center' },
  });
