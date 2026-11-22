import { apiClient } from './client';
import type {
  CategoryBrief, City, Photo, PriceItem, PriceUnit,
  ProviderAttr, PublicProviderDetails,
} from './types';

/** Время на загрузку пачки фото: две минуты вместо общих двадцати секунд. */
const UPLOAD_TIMEOUT_MS = 120000;

export interface ProviderBody {
  category_id: number;
  city_id: number;
  name: string;
  description?: string | null;
  phone?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  price_from?: number | null;
  price_unit?: PriceUnit | null;
  attr_ids?: number[];
}

export type ProviderPatchBody = Partial<ProviderBody> & { is_active?: boolean };

export interface OwnerProviderFull {
  id: number;
  guid: string;
  category_id: number;
  city_id: number;
  name: string;
  description: string | null;
  phone: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  price_from: number | null;
  price_unit: PriceUnit | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  photos: Photo[];
  attrs: ProviderAttr[];
  items: PriceItem[];
}

export interface MyProvider extends Omit<OwnerProviderFull, 'photos' | 'attrs' | 'items'> {
  category: CategoryBrief;
  main_thumb: string | null;
  /** Позиций в прайсе. */
  items_count: number;
}

export interface UploadedPhoto {
  id: number;
  file_path: string;
  thumb_path: string;
  sort_order: number;
}

/** CRUD объявления владельцем + публичные детали для карточки. */
export const providersApi = {
  async my(): Promise<{ items: MyProvider[] }> {
    const { data } = await apiClient.get<{ items: MyProvider[] }>('/providers/my');
    return data;
  },

  async create(body: ProviderBody): Promise<{ provider: OwnerProviderFull }> {
    const { data } = await apiClient.post<{ provider: OwnerProviderFull }>('/providers', body);
    return data;
  },

  async get(guid: string): Promise<{ provider: OwnerProviderFull }> {
    const { data } = await apiClient.get<{ provider: OwnerProviderFull }>(`/providers/${guid}`);
    return data;
  },

  async patch(guid: string, body: ProviderPatchBody): Promise<{ provider: OwnerProviderFull }> {
    const { data } = await apiClient.patch<{ provider: OwnerProviderFull }>(
      `/providers/${guid}`, body,
    );
    return data;
  },

  async remove(guid: string): Promise<{ deleted: true }> {
    const { data } = await apiClient.delete<{ deleted: true }>(`/providers/${guid}`);
    return data;
  },

  async uploadPhotos(
    providerGuid: string,
    files: { uri: string; name: string; type: string }[],
  ): Promise<{ items: UploadedPhoto[] }> {
    const form = new FormData();
    for (const f of files) {
      // @ts-expect-error React Native FormData file shape
      form.append('files', { uri: f.uri, name: f.name, type: f.type });
    }
    const { data } = await apiClient.post<{ items: UploadedPhoto[] }>(
      `/providers/${providerGuid}/photos`,
      form,
      // Общий таймаут клиента — 20 с: пачка из двадцати снимков по мобильной
      // сети в него не укладывается, а сервер при этом успевал их сохранить.
      { headers: { 'Content-Type': 'multipart/form-data' }, timeout: UPLOAD_TIMEOUT_MS },
    );
    return data;
  },

  async deletePhoto(photoId: number): Promise<{ deleted: true }> {
    const { data } = await apiClient.delete<{ deleted: true }>(`/providers/photos/${photoId}`);
    return data;
  },

  async reorderPhotos(providerGuid: string, photoIds: number[]): Promise<{ items: Photo[] }> {
    const { data } = await apiClient.patch<{ items: Photo[] }>(
      `/providers/${providerGuid}/photos/order`,
      { photo_ids: photoIds },
    );
    return data;
  },

  /** Заменить прайс целиком: порядок в списке — порядок показа. */
  async saveItems(guid: string, items: PriceItem[]): Promise<{ items: PriceItem[] }> {
    const { data } = await apiClient.put<{ items: PriceItem[] }>(
      `/providers/${guid}/items`,
      { items: items.map(({ name, unit, price }) => ({ name, unit, price })) },
    );
    return data;
  },

  /** Публичные детали объявления (карточка магазина или бригады). */
  async getPublic(guid: string): Promise<{ provider: PublicProviderDetails & { city: City } }> {
    const { data } = await apiClient.get<{ provider: PublicProviderDetails & { city: City } }>(
      `/search/providers/${guid}`,
    );
    return data;
  },
};
