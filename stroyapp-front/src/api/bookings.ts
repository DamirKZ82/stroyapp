import { apiClient } from './client';
import type { Booking, BookingStatus } from './types';

export interface BookingCreateBody {
  provider_guid: string;
  /** Желаемая дата доставки или начала работ. */
  event_date: string;
  /** Адрес объекта. */
  address?: string;
  comment?: string;
  /** Оформить от имени клиента: guid связи из mastersApi.list().clients. */
  master_link_guid?: string;
}

export const bookingsApi = {
  async create(body: BookingCreateBody): Promise<{ booking: Booking }> {
    const { data } = await apiClient.post<{ booking: Booking }>('/bookings', body);
    return data;
  },

  async get(guid: string): Promise<{ booking: Booking }> {
    const { data } = await apiClient.get<{ booking: Booking }>(`/bookings/${guid}`);
    return data;
  },

  async my(status?: BookingStatus): Promise<{ items: Booking[] }> {
    const { data } = await apiClient.get<{ items: Booking[] }>(
      '/bookings/my',
      { params: status ? { status } : {} },
    );
    return data;
  },

  async incoming(status?: BookingStatus): Promise<{ items: Booking[] }> {
    const { data } = await apiClient.get<{ items: Booking[] }>(
      '/bookings/incoming',
      { params: status ? { status } : {} },
    );
    return data;
  },

  async confirm(guid: string): Promise<{ booking: Booking }> {
    const { data } = await apiClient.post(`/bookings/${guid}/confirm`);
    return data;
  },

  async reject(guid: string, reason: string): Promise<{ booking: Booking }> {
    const { data } = await apiClient.post(`/bookings/${guid}/reject`, { reason });
    return data;
  },

  /** Клиент подтверждает заявку мастера: она уходит продавцу. */
  async approve(guid: string): Promise<{ booking: Booking }> {
    const { data } = await apiClient.post(`/bookings/${guid}/approve`);
    return data;
  },

  /** Клиент не подтверждает заявку мастера. */
  async decline(guid: string): Promise<{ booking: Booking }> {
    const { data } = await apiClient.post(`/bookings/${guid}/decline`);
    return data;
  },

  /** Заявки, которые я оформил как мастер. */
  async ordered(): Promise<{ items: Booking[] }> {
    const { data } = await apiClient.get<{ items: Booking[] }>('/bookings/ordered');
    return data;
  },

  async cancel(guid: string): Promise<{ booking: Booking }> {
    const { data } = await apiClient.post(`/bookings/${guid}/cancel`);
    return data;
  },
};
