import { apiClient } from './client';
import type { Category, City, ProviderAttrType, Unit } from './types';

export const dictsApi = {
  async categories(): Promise<{ items: Category[] }> {
    const { data } = await apiClient.get('/dicts/categories');
    return data;
  },
  async providerAttrTypes(category?: string): Promise<{ items: ProviderAttrType[] }> {
    const { data } = await apiClient.get('/dicts/provider-attr-types', {
      params: category ? { category } : {},
    });
    return data;
  },
  async cities(): Promise<{ items: City[] }> {
    const { data } = await apiClient.get('/dicts/cities');
    return data;
  },
  async units(): Promise<{ items: Unit[] }> {
    const { data } = await apiClient.get('/dicts/units');
    return data;
  },
};
