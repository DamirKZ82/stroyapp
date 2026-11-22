import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, profileApi } from '@/api';
import { Button } from '@/components/Button';
import { Card, Row, RowGroup, SectionLabel } from '@/components/Card';
import { Screen, ScreenTitle } from '@/components/Screen';
import { Segment } from '@/components/Segment';
import { PRIVACY_URL, SUPPORT_EMAIL, TERMS_URL } from '@/config';
import { setAppLanguage, type AppLanguage } from '@/i18n';
import { useAuthGateStore } from '@/store/authGateStore';
import { useAuthStore } from '@/store/authStore';
import type { ThemeMode } from '@/store/themeStore';
import { keptForSession, useIsAuthed } from '@/store/useRequireAuth';
import { space, text, type ThemeColors } from '@/theme';
import { useColors, useScheme, useThemedStyles } from '@/theme/scheme';
import { confirmDestructive } from '@/utils/alert';
import { useLang } from '@/utils/lang';
import { openPage, writeEmail } from '@/utils/links';
import { formatKzPhoneDisplay } from '@/utils/phone';
import { pushOnce, useOnTop } from '@/utils/nav';

/**
 * Вкладка «Профиль»: кто вошёл, язык, тема, разделы владельца и клиента,
 * документы и связь с поддержкой.
 *
 * Гостю вкладка тоже нужна — язык и тема меняются без входа, а условия,
 * политика и адрес поддержки должны быть доступны каждому. Поэтому экран не
 * закрыт шторкой входа целиком, а показывает карточку «Войти».
 */
export default function ProfileScreen() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const lang = useLang();
  const { mode, setMode } = useScheme();

  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const logout = useAuthStore((s) => s.logout);
  const isAuthed = useIsAuthed();
  // Токен есть и у того, кто вход не закончил — не принял условия или не
  // назвал себя. Выйти и удалить аккаунт он должен мочь и так: условия
  // обещают удаление в любой момент, а несогласному больше некуда идти.
  const hasToken = useAuthStore((s) => !!s.token);
  const openAuthGate = useAuthGateStore((s) => s.open);

  const [savingLang, setSavingLang] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const onTop = useOnTop();

  const errorText = (e: unknown) => (e instanceof ApiError ? e.message : t('common.error_generic'));

  const changeLanguage = async (next: AppLanguage) => {
    if (!hasToken || !user) {
      // У гостя профиля на сервере нет — язык живёт только в приложении.
      setAppLanguage(next);
      return;
    }
    // Дальше — и тот, кто вход не закончил (не принял условия, не назвал
    // себя): профиль на сервере у него уже есть. Язык, сменённый только в
    // приложении, вернулся бы к прежнему с первым же ответом сервера —
    // например, в момент, когда он нажал «Принимаю условия».
    if (user.language === next) return;
    setSavingLang(true);
    try {
      // Сначала сервер, потом интерфейс: на языке из профиля приходят
      // уведомления, и разойтись с языком приложения он не должен.
      const answer = await profileApi.patch({ language: next });
      // Пока шёл запрос, человек мог выйти или удалить аккаунт: setUser
      // записал бы его данные обратно в хранилище телефона уже после выхода.
      const now = useAuthStore.getState();
      if (!now.token) return;
      // Вместе с языком сервер присылает и согласие с условиями. Если вход
      // держится до конца запуска на прежних данных (keptForSession), ответ
      // «условия не приняты» отнял бы его прямо здесь, без объяснений.
      await setUser(answer.user, keptForSession(now.user, answer.user) ?? undefined);
      setAppLanguage(next);
    } catch (e) {
      // Раньше ошибка глоталась молча: без сети переключатель «не нажимался»
      // и было непонятно почему.
      if (onTop.current) Alert.alert(t('profile.language'), errorText(e));
    } finally {
      setSavingLang(false);
    }
  };

  const openDocument = async (url: string, title: string) => {
    // false — на телефоне нет ни одного браузера.
    if (!(await openPage(url)) && onTop.current) Alert.alert(title, t('common.error_generic'));
  };

  const writeSupport = async () => {
    // Почтовой программы может не быть. Тогда показываем адрес словами:
    // он и так стоит в строке, но окно объясняет, почему ничего не открылось.
    if (!(await writeEmail(SUPPORT_EMAIL, t('profile.support_subject'))) && onTop.current) {
      Alert.alert(t('profile.support'), t('profile.support_failed', { email: SUPPORT_EMAIL }));
    }
  };

  // Не стрелка: строка уводит из приложения — в браузер или в почту. Значок
  // скрыт от диктора, как значки самой Row: Android собрал бы подпись
  // строки из детей и прочёл символ шрифта непонятным знаком, а iOS — тоже,
  // если скрыть только accessible={false}.
  const external = (
    <Icon
      name="open-in-new"
      size={18}
      color={colors.muted}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );

  // Через confirmDestructive, а не Alert.alert: в веб-просмотре Alert пуст,
  // и выйти или удалить аккаунт там было бы нельзя вовсе.
  const confirmLogout = () => {
    confirmDestructive(
      t('profile.logout_confirm_title'),
      undefined,
      () => void logout(),
      t('profile.logout'),
    );
  };

  const deleteAccount = async () => {
    setDeleting(true);
    try {
      await profileApi.remove();
    } catch (e) {
      setDeleting(false);
      if (onTop.current) Alert.alert(t('profile.delete_account'), errorText(e));
      return;
    }
    // Аккаунта на сервере уже нет. Сбой при очистке хранилища телефона не
    // должен превращаться в «не удалось удалить»: токен всё равно мёртвый,
    // первый же ответ 401 выкинет из аккаунта.
    await logout().catch(() => undefined);
    setDeleting(false);
    // Без проверки onTop: окно про аккаунт, а не про этот экран. Если за время
    // запроса перешли на другую вкладку, только оно и объяснит, почему вход
    // вдруг пропал. Сам выход вкладку не закрывает — она открыта и гостю.
    Alert.alert(t('profile.delete_account_done'));
  };

  const confirmDelete = () => {
    confirmDestructive(
      t('profile.delete_account_title'),
      t('profile.delete_account_text'),
      () => void deleteAccount(),
      t('profile.delete_account_confirm'),
    );
  };

  return (
    <Screen tab scroll>
      <ScreenTitle title={t('profile.title')} />

      {isAuthed && user ? (
        <Card style={styles.identity}>
          <Text style={styles.name} numberOfLines={2}>
            {user.full_name}
          </Text>
          <Text style={styles.phone} numberOfLines={1}>
            {formatKzPhoneDisplay(user.phone)}
          </Text>
        </Card>
      ) : (
        <Card title={t('auth_gate.title')}>
          <Text style={styles.guestText}>{t('profile.guest_subtitle')}</Text>
          <Button label={t('profile.login')} onPress={() => openAuthGate('generic')} />
        </Card>
      )}

      <View style={styles.setting}>
        <SectionLabel>{t('profile.language')}</SectionLabel>
        <Segment<AppLanguage>
          // У кого есть профиль на сервере, тому показываем язык профиля: он
          // меняется только после ответа сервера, и до него выбор не должен
          // перескакивать.
          value={hasToken && user ? user.language : lang}
          onChange={(next) => void changeLanguage(next)}
          disabled={savingLang}
          options={[
            { value: 'ru', label: t('auth.language_ru') },
            { value: 'kz', label: t('auth.language_kz') },
          ]}
        />
      </View>

      <View style={styles.setting}>
        <SectionLabel>{t('profile.theme')}</SectionLabel>
        <Segment<ThemeMode>
          value={mode}
          onChange={(next) => void setMode(next)}
          options={[
            { value: 'system', label: t('profile.theme_system') },
            { value: 'light', label: t('profile.theme_light') },
            { value: 'dark', label: t('profile.theme_dark') },
          ]}
        />
      </View>

      {isAuthed ? (
        <RowGroup>
          <Row
            first
            title={t('profile.my_listings')}
            icon="storefront-outline"
            onPress={() => pushOnce('/my-listings')}
          />
          <Row
            title={t('profile.incoming_bookings')}
            icon="inbox-arrow-down-outline"
            onPress={() => pushOnce('/incoming-bookings')}
          />
          <Row
            title={t('profile.my_bookings')}
            icon="calendar-check-outline"
            onPress={() => pushOnce('/my-bookings')}
          />
          <Row
            title={t('peer_block.list_title')}
            icon="account-cancel-outline"
            onPress={() => pushOnce('/blocked-users')}
          />
        </RowGroup>
      ) : null}

      <RowGroup>
        <Row
          first
          title={t('terms.title')}
          icon="file-document-outline"
          onPress={() => void openDocument(TERMS_URL, t('terms.title'))}
          accessibilityRole="link"
          right={external}
        />
        <Row
          title={t('profile.privacy')}
          icon="shield-lock-outline"
          onPress={() => void openDocument(PRIVACY_URL, t('profile.privacy'))}
          accessibilityRole="link"
          right={external}
        />
        {/* Адрес — в самой строке: его должно быть видно и тому, у кого на
            телефоне нет почтовой программы. */}
        <Row
          title={t('profile.support')}
          subtitle={SUPPORT_EMAIL}
          icon="email-outline"
          onPress={() => void writeSupport()}
          accessibilityRole="link"
          right={external}
        />
      </RowGroup>

      {hasToken ? (
        <View style={styles.account}>
          <Button
            label={t('profile.logout')}
            variant="outline"
            onPress={confirmLogout}
            disabled={deleting}
          />
          <Button
            label={t('profile.delete_account')}
            variant="text"
            tone="danger"
            onPress={confirmDelete}
            busy={deleting}
          />
        </View>
      ) : null}
    </Screen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    identity: { gap: 4 },
    name: { fontSize: text.section, fontWeight: '700', color: colors.text },
    phone: { fontSize: text.caption, color: colors.muted },
    guestText: { fontSize: text.caption, lineHeight: 20, color: colors.muted },
    // Подпись ближе к своему переключателю, чем к соседнему блоку.
    setting: { gap: 6 },
    account: { gap: 4, marginTop: space.gap },
  });
