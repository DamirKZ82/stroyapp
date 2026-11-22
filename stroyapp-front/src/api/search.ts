import { apiClient } from './client';
import type { ItemSearchResponse, ListingKind, ProviderSearchResponse } from './types';

type Sort = 'rating_desc' | 'price_asc' | 'price_desc';

export interface ProviderSearchParams {
  /** Вид: магазины или бригады. Нужен, если не задана категория. */
  kind?: ListingKind;
  category_id?: number;
  /** Текст: название, описание и позиции прайса. */
  q?: string;
  city_id?: number;
  price_max?: number;
  attr_ids?: number[];
  sort?: Sort;
  page?: number;
  page_size?: number;
}

export interface ItemSearchParams {
  q: string;
  kind?: ListingKind;
  category_id?: number;
  city_id?: number;
  price_max?: number;
  sort?: Sort;
  page?: number;
  page_size?: number;
}

function toQuery(params: object): Record<string, string | number> {
  const query: Record<string, string | number> = {};
  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null || val === '') continue;
    if (Array.isArray(val)) {
      if (val.length) query[key] = val.join(',');
    } else {
      query[key] = val as string | number;
    }
  }
  return query;
}

export const searchApi = {
  /** Магазины и бригады. */
  async providers(params: ProviderSearchParams): Promise<ProviderSearchResponse> {
    const { data } = await apiClient.get<ProviderSearchResponse>(
      '/search/providers',
      { params: toQuery(params) },
    );
    return data;
  },

  /** Позиции прайса — сравнить цену товара или работы. */
  async items(params: ItemSearchParams): Promise<ItemSearchResponse> {
    const { data } = await apiClient.get<ItemSearchResponse>(
      '/search/items',
      { params: toQuery(params) },
    );
    return data;
  },
};
