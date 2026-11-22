import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';

import { API_BASE_URL } from '@/config';
import i18n from '@/i18n';
import { useAuthStore } from '@/store/authStore';
import type { ApiErrorBody } from './types';

/**
 * Централизованный axios-клиент.
 *
 * Что делает:
 *  1) Подставляет Authorization: Bearer <token>, если есть в authStore,
 *     и Accept-Language — язык интерфейса.
 *  2) На 401 — выкидывает пользователя (logout), дальше навигация сама
 *     переключится на AuthStack, так как useAuthStore.token станет null.
 *  3) На 5xx — отправляет POST /front-error для записи в errors_front.
 *  4) Выпрямляет ошибки: бросает ApiError с message, который можно
 *     показать человеку как есть — на языке интерфейса, где это зависит
 *     от клиента (нет сети, сбой сервера).
 */

export class ApiError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

// ---- request interceptor: подставляем токен и язык ----
apiClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  config.headers = config.headers ?? {};
  const headers = config.headers as Record<string, string>;
  const token = useAuthStore.getState().token;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  // Язык интерфейса, а не профиля: гость тоже видит ошибки сервера. Сервер
  // пока отвечает только по-русски и заголовок не читает; шлём заранее,
  // чтобы перевод его текстов не потребовал новой сборки приложения.
  // 'kk' — код казахского по ISO, в приложении он исторически 'kz'.
  headers['Accept-Language'] = i18n.language === 'kz' ? 'kk' : 'ru';
  return config;
});

// ---- response interceptor: 401 -> logout, 5xx -> /front-error ----
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorBody>) => {
    const status = error.response?.status;
    const serverMessage = error.response?.data?.message;
    // Для журнала — как было: текст сервера или техническое описание axios.
    const rawMessage = serverMessage || error.message || 'Network error';

    // Что увидит человек. Экраны показывают message как есть, поэтому
    // английских текстов axios («Network Error», «timeout of 20000ms
    // exceeded», «Request failed with status code 502») здесь быть не должно.
    let message: string;
    if (!error.response) {
      // Ответа нет вовсе: нет сети или вышло время ожидания.
      message = i18n.t('common.network_error');
    } else if (!serverMessage || (status !== undefined && status >= 500)) {
      // Текст сбоя сервера один и только по-русски — под казахским
      // интерфейсом он чужой. А ответ без message (прокси, 502/504) — это
      // вообще не наш сервер.
      message = i18n.t('common.error_generic');
    } else {
      message = serverMessage;
    }

    if (status === 401) {
      // Токен невалиден — чистим. Но только если он был.
      // Если токена не было вовсе (юзер — гость), 401 — нормальная реакция
      // бэка на защищённый эндпоинт, не надо ничего "логаутить" и дёргать state.
      const hadToken = !!useAuthStore.getState().token;
      if (hadToken) {
        await useAuthStore.getState().logout();
      }
    }

    if (status && status >= 500) {
      // Тихо отправляем на бэк (не через apiClient, чтобы не уйти в рекурсию).
      const path = (error.config?.url ?? '') as string;
      const method = (error.config?.method ?? '').toUpperCase();
      axios
        .post(`${API_BASE_URL}/front-error`, {
          message: `[${status}] ${method} ${path}: ${rawMessage}`,
          stack: null,
          screen: 'api',
        })
        .catch(() => { /* swallow */ });
    }

    throw new ApiError(message, status);
  }
);
