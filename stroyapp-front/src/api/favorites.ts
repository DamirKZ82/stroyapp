import { apiClient } from './client';
import type { FavoriteItem } from './types';

export const favoritesApi = {
  async list(): Promise<{ items: FavoriteItem[] }> {
    const { data } = await apiClient.get<{ items: FavoriteItem[] }>('/favorites');
    return data;
  },

  async addProvider(providerGuid: string): Promise<{ ok: true }> {
    const { data } = await apiClient.post(`/favorites/provider/${providerGuid}`);
    return data;
  },

  async removeProvider(providerGuid: string): Promise<{ ok: true }> {
    const { data } = await apiClient.delete(`/favorites/provider/${providerGuid}`);
    return data;
  },
};
