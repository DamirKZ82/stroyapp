import { apiClient } from './client';
import type { Booking, BookingStatus } from './types';

export interface BookingCreateBody {
  provider_guid: string;
  /** Желаемая дата доставки или начала работ. */
  event_date: string;
  /** Адрес объекта. */
  address?: string;
  comment?: string;
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

  async cancel(guid: string): Promise<{ booking: Booking }> {
    const { data } = await apiClient.post(`/bookings/${guid}/cancel`);
    return data;
  },
};
