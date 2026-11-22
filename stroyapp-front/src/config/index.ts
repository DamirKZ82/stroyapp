import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Базовый URL API.
 *
 * Приоритет:
 * 1) EXPO_PUBLIC_API_URL — только в разработке (`expo start`)
 * 2) extra.apiBaseUrl из app.json (если задан)
 * 3) умолчание: Android эмулятор -> 10.0.2.2, iOS симулятор / web -> localhost
 *
 * Для локального бэка (в том числе с реального устройства по Wi-Fi) задай
 * EXPO_PUBLIC_API_URL, например "http://192.168.0.42:4000"; app.json не
 * править.
 *
 * Переменную читаем только под __DEV__: `eas update` собирает пакет на
 * машине разработчика и вшивает EXPO_PUBLIC_* из текущей консоли. Забытый
 * там локальный адрес иначе уехал бы обновлением всем установленным
 * приложениям, и они перестали бы видеть сервер.
 */
const extra = (Constants.expoConfig?.extra ?? {}) as {
  apiBaseUrl?: string;
  eas?: { projectId?: string };
};

const defaultBaseUrl = Platform.select({
  android: 'http://10.0.2.2:4000',
  ios: 'http://localhost:4000',
  default: 'http://localhost:4000',
});

export const API_BASE_URL =
  (__DEV__ && process.env.EXPO_PUBLIC_API_URL) || extra.apiBaseUrl || defaultBaseUrl!;

/**
 * Страницы с документами и почта поддержки. Адреса постоянные, а не от
 * API_BASE_URL: в разработке тот смотрит на локальный сервер, а открыть
 * нужно те же страницы, что указаны в магазинах приложений.
 */
export const PRIVACY_URL = 'https://api.toiapp.kz/privacy';
export const TERMS_URL = 'https://api.toiapp.kz/terms';
export const SUPPORT_EMAIL = 'supporttoiapp@gmail.com';

/**
 * EAS project ID.
 *
 * Нужен expo-notifications в standalone-сборке (TestFlight / Play):
 * там, в отличие от Expo Go, он не выводится автоматически.
 */
export const EAS_PROJECT_ID =
  extra.eas?.projectId ?? Constants.easConfig?.projectId;
