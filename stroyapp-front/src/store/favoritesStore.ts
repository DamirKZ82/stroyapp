import { create } from 'zustand';
import { favoritesApi } from '@/api';
import { useAuthStore } from './authStore';

interface FavoritesState {
  /** Множество guid'ов избранных объявлений (магазины и бригады). */
  guids: Set<string>;
  loaded: boolean;
  load: () => Promise<void>;
  toggleProvider: (providerGuid: string, isNowFav: boolean) => Promise<void>;
  isFav: (guid: string) => boolean;
  clear: () => void;
}

// Что человек успел поставить или снять, пока шла загрузка списка: ответ
// собран сервером до этого и затёр бы только что нажатое сердечко. Так
// бывает сразу после входа: список запрошен в момент входа, а сердечко, из-за
// которого человек и входил, ставится через мгновение.
let loading = 0;
const touched = new Map<string, boolean>();
const touch = (guid: string, isFav: boolean) => {
  if (loading) touched.set(guid, isFav);
};

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  guids: new Set<string>(),
  loaded: false,

  load: async () => {
    // Чьё избранное просили. Пока шёл запрос, человек мог выйти и войти
    // другим номером: ответ на старый запрос — уже не его избранное.
    const token = useAuthStore.getState().token;
    const stale = () => useAuthStore.getState().token !== token;
    if (!loading) touched.clear();
    loading += 1;
    try {
      const { items } = await favoritesApi.list();
      if (stale()) return;
      const guids = new Set<string>();
      for (const i of items) {
        if (i.provider?.guid) guids.add(i.provider.guid);
      }
      for (const [guid, isFav] of touched) {
        if (isFav) guids.add(guid);
        else guids.delete(guid);
      }
      set({ guids, loaded: true });
    } catch {
      if (stale()) return;
      set({ loaded: true });
    } finally {
      loading -= 1;
    }
  },

  toggleProvider: async (providerGuid, isNowFav) => {
    const next = new Set(get().guids);
    if (isNowFav) next.add(providerGuid); else next.delete(providerGuid);
    set({ guids: next });
    touch(providerGuid, isNowFav);
    try {
      if (isNowFav) await favoritesApi.addProvider(providerGuid);
      else await favoritesApi.removeProvider(providerGuid);
    } catch {
      touch(providerGuid, !isNowFav);
      const rollback = new Set(get().guids);
      if (isNowFav) rollback.delete(providerGuid); else rollback.add(providerGuid);
      set({ guids: rollback });
    }
  },

  isFav: (guid) => get().guids.has(guid),

  clear: () => {
    // Нажатое прежним человеком к следующему вошедшему не относится.
    touched.clear();
    set({ guids: new Set(), loaded: false });
  },
}));
