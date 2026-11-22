import { create } from 'zustand';
import { secureDelete, secureGet, secureSet } from './secureStorage';
import { setAppLanguage } from '@/i18n';

const TOKEN_KEY = 'stroyapp.jwt';
const USER_KEY = 'stroyapp.user';

export interface User {
  id: number;
  guid: string;
  phone: string;
  full_name: string | null;
  language: 'ru' | 'kz';
  /**
   * Принял ли человек действующие Условия использования. false — вход ещё
   * не закончен: шторка входа покажет шаг согласия. Поля нет вовсе, если
   * сервер старше него, — тогда согласие не спрашиваем: принять его негде.
   */
  terms_accepted?: boolean;
  /**
   * Номер действующей версии условий. Возвращается серверу вместе с
   * согласием: так он знает, какой текст человек видел.
   */
  terms_version?: string;
}

export interface AuthState {
  /** null = идёт начальная загрузка из SecureStore; true/false — уже известно */
  isHydrated: boolean;
  token: string | null;
  user: User | null;

  hydrate: () => Promise<void>;
  setAuth: (token: string, user: User) => Promise<void>;
  /**
   * Записать пользователя, каким его прислал сервер. shown — каким он
   * остаётся в памяти до конца запуска, если не таким же: так вход, который
   * нельзя отнимать посреди дела, доживает до следующего запуска (см.
   * keptForSession), а в хранилище телефона уже лежит правда.
   */
  setUser: (user: User, shown?: User) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isHydrated: false,
  token: null,
  user: null,

  hydrate: async () => {
    // Хранилище телефона читается один раз за запуск: дальше правда — в
    // памяти. Корень приложения может смонтироваться заново в том же
    // запуске, и повторное чтение подменило бы объект пользователя: ответ
    // о профиле, запрошенный до этого, был бы отброшен как устаревший.
    if (get().isHydrated) return;
    const [token, userJson] = await Promise.all([
      secureGet(TOKEN_KEY),
      secureGet(USER_KEY),
    ]);
    const user = userJson ? (JSON.parse(userJson) as User) : null;

    if (user?.language) {
      setAppLanguage(user.language);
    }
    set({ isHydrated: true, token: token ?? null, user });
  },

  setAuth: async (token, user) => {
    await secureSet(TOKEN_KEY, token);
    await secureSet(USER_KEY, JSON.stringify(user));
    if (user.language) setAppLanguage(user.language);
    set({ token, user });
  },

  setUser: async (user, shown) => {
    await secureSet(USER_KEY, JSON.stringify(user));
    const current = shown ?? user;
    if (current.language) setAppLanguage(current.language);
    set({ user: current });
  },

  logout: async () => {
    await Promise.all([secureDelete(TOKEN_KEY), secureDelete(USER_KEY)]);
    set({ token: null, user: null });
  },
}));
