import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';

import { profileApi } from '@/api';
import { AuthGateSheet } from '@/components/AuthGateSheet';
import { useAuthGateStore } from '@/store/authGateStore';
import { useAuthStore } from '@/store/authStore';
import { keptForSession, pendingLoginStep, useIsAuthed } from '@/store/useRequireAuth';
import { useFavoritesStore } from '@/store/favoritesStore';
import { useThemeStore } from '@/store/themeStore';
import { useScheme, useSyncNativeScheme } from '@/theme/scheme';
// Побочный эффект: настраивает i18next до первой отрисовки.
import '@/i18n';

// Экран, открытый по ссылке (stroyapp://provider?...), должен лежать поверх вкладок:
// иначе с него некуда вернуться.
export const unstable_settings = { anchor: '(tabs)' };

// Сколько заставка ждёт ответа сервера о профиле. Обычно он приходит за
// доли секунды; дольше держать нельзя — без сети заставка висела бы на
// каждом запуске.
const PROFILE_WAIT_MS = 1500;

// Заставка держится, пока из хранилища телефона не достали вход и тему:
// иначе первый кадр — светлый экран гостя, который через мгновение
// сменяется тёмным экраном вошедшего.
void SplashScreen.preventAutoHideAsync();

/**
 * Корень приложения.
 *
 * Здесь только обвязка: кто вошёл, избранное, тема и стек экранов. Вкладки
 * лежат в (tabs), всё остальное — экраны над ними: открытый экран закрывает
 * панель вкладок целиком, как в iduken.
 *
 * Входа отдельным экраном нет: смотреть каталог можно гостем, а вход —
 * шторка поверх любого экрана (AuthGateSheet), когда действие его требует.
 */
export default function RootLayout() {
  const hydrateAuth = useAuthStore((s) => s.hydrate);
  const authReady = useAuthStore((s) => s.isHydrated);
  const hydrateTheme = useThemeStore((s) => s.hydrate);
  const themeReady = useThemeStore((s) => s.hydrated);
  const favsLoaded = useFavoritesStore((s) => s.loaded);
  const loadFavs = useFavoritesStore((s) => s.load);
  const clearFavs = useFavoritesStore((s) => s.clear);

  const authed = useIsAuthed();

  const { dark, colors } = useScheme();
  useSyncNativeScheme();

  useEffect(() => {
    void hydrateAuth();
    void hydrateTheme();
  }, [hydrateAuth, hydrateTheme]);

  // Профиль с сервера — раз за запуск, если человек уже вошёл. В хранилище
  // телефона лежит то, что пришло при входе, а с тех пор могли измениться
  // имя (его сменили с другого телефона) и условия использования. Тому, кто
  // вошёл в прежней версии приложения, где согласия ещё не было, сервер
  // ответит terms_accepted: false — вход нужно закончить, приняв условия.
  //
  // Заставка этого ответа ждёт (недолго): так человек с порога видит шаг
  // согласия, а не экран, который через мгновение станет гостевым.
  const [profileChecked, setProfileChecked] = useState(false);
  useEffect(() => {
    if (!authReady) return;
    const { token: saved, user: before } = useAuthStore.getState();
    if (!saved) {
      setProfileChecked(true);
      return;
    }
    // Ждёт ли заставка ещё этого ответа.
    let waited = true;
    const release = () => {
      waited = false;
      setProfileChecked(true);
    };
    const timer = setTimeout(() => {
      release();
      // Ответа всё нет, а по тому, что лежит в телефоне, условия не приняты
      // (так записал прошлый запуск, когда ответ опоздал). Шаг согласия
      // показываем, не дожидаясь сети: иначе человек увидел бы себя гостем
      // и не понял почему.
      const now = useAuthStore.getState();
      const gate = useAuthGateStore.getState();
      const asked = !!before?.full_name && pendingLoginStep(before) === 'terms';
      if (asked && now.token === saved && now.user === before && !gate.visible) gate.open('generic');
    }, PROFILE_WAIT_MS);
    profileApi
      .get()
      .then(async ({ user }) => {
        // Пока шёл запрос, человек мог выйти, войти другим номером, принять
        // условия или сменить язык: ответ собран до этого и затёр бы
        // свежее — снова спросил бы согласие, вернул бы прежний язык.
        const now = useAuthStore.getState();
        if (now.token !== saved || now.user !== before) return;
        // Успел ли ответ к заставке — решаем один раз, здесь: запись в
        // хранилище телефона ниже занимает время, и заставка может уйти,
        // пока она идёт.
        const inTime = waited;
        // Ответ опоздал: заставки уже нет, и человек пользуется приложением
        // как вошедший. Шторку поверх чужого дела мы не открываем, а отнять
        // вход молча нельзя — он остаётся до конца запуска (keptForSession).
        // Согласие спросится при следующем запуске.
        const kept = inTime ? null : keptForSession(before, user);
        if (kept) {
          await now.setUser(user, kept);
          return;
        }
        await now.setUser(user);
        // Имя есть, а согласия нет: шторка входа открывается сразу на шаге
        // согласия — иначе человек увидел бы себя гостем и не понял почему.
        // Только пока на экране заставка: если ответ опоздал, человек уже
        // чем-то занят, и шторка выскочила бы посреди его дела (а поверх
        // другой шторки на iOS не показалась бы вовсе). Тогда шаг согласия
        // он увидит, когда нажмёт «Войти» или то, что требует входа.
        const gate = useAuthGateStore.getState();
        if (inTime && !gate.visible && user.full_name && user.terms_accepted === false) {
          gate.open('generic');
        }
      })
      // Нет связи — остаётся то, что лежит в хранилище, до следующего запуска.
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        release();
      });
    return () => clearTimeout(timer);
  }, [authReady]);

  // Избранное есть только у вошедшего: грузим, когда вход закончен, и
  // чистим, когда он пропал (выход, ответ 401 или не принятые условия).
  // Чистим и то, что загрузилось уже после: запрос избранного мог уйти,
  // пока человек ещё считался вошедшим, а ответить — когда уже нет. Без
  // этого у гостя горели бы чужие сердечки, а отметка «загружено» не дала
  // бы загрузить избранное следующему вошедшему.
  const wasAuthed = useRef(false);
  useEffect(() => {
    if (authed && !favsLoaded) void loadFavs();
    if (!authed && (wasAuthed.current || favsLoaded)) clearFavs();
    wasAuthed.current = authed;
  }, [authed, favsLoaded, loadFavs, clearFavs]);

  const ready = authReady && themeReady && profileChecked;
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  // Тема навигации нужна не для красоты: фон вкладок и шапок система берёт
  // отсюда. Без неё при смене вкладки в тёмной теме мигает белый фон.
  const navTheme = useMemo(() => {
    const base = dark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: colors.primary,
        background: colors.background,
        card: colors.card,
        text: colors.text,
        border: colors.border,
        notification: colors.accent,
      },
    };
  }, [dark, colors]);

  if (!ready) return null;

  return (
    <ThemeProvider value={navTheme}>
      {/* Значки шторки — наоборот к фону, иначе время и заряд сливаются с ним. */}
      <StatusBar style={dark ? 'light' : 'dark'} />
      {/* Шапка по умолчанию скрыта: вкладки рисуют заголовок сами, а экран,
          которому шапка нужна, включает её у себя через <Stack.Screen>.
          Кнопка «Назад» — одна стрелка: иначе iOS подписывает её названием
          предыдущего экрана, а у вкладок это служебное «(tabs)». */}
      <Stack
        screenOptions={{
          headerShown: false,
          headerBackButtonDisplayMode: 'minimal',
          headerStyle: { backgroundColor: colors.card },
          headerTitleStyle: { color: colors.text },
          headerTintColor: colors.primary,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="(tabs)" />
        {/* Каталог открыт и гостю. */}
        <Stack.Screen name="provider" />
        {/* Личные экраны. Сюда попадают только после входа, но токен может
            пропасть и посреди работы: сервер ответил 401, человек вышел или
            удалил аккаунт. Тогда стек сам убирает эти экраны из истории, и
            человек оказывается на вкладках, а не перед формой, где любой
            запрос отвечает отказом. */}
        <Stack.Protected guard={authed}>
          <Stack.Screen name="booking-form" />
          <Stack.Screen name="chat" />
          <Stack.Screen name="my-bookings" />
          <Stack.Screen name="review-form" />
          <Stack.Screen name="report" />
          <Stack.Screen name="blocked-users" />
          <Stack.Screen name="my-listings" />
          <Stack.Screen name="incoming-bookings" />
          <Stack.Screen name="booking" />
          <Stack.Screen name="provider-form" />
          <Stack.Screen name="subscription" />
          <Stack.Screen name="masters" />
          <Stack.Screen name="ordered-bookings" />
        </Stack.Protected>
        {/* Витрина компонентов — только в разработке. */}
        <Stack.Protected guard={__DEV__}>
          <Stack.Screen name="kit" />
        </Stack.Protected>
      </Stack>
      <AuthGateSheet />
    </ThemeProvider>
  );
}
