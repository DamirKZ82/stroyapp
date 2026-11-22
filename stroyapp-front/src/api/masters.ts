import { apiClient } from './client';
import type { MastersOverview } from './types';

export const mastersApi = {
  async list(): Promise<MastersOverview> {
    const { data } = await apiClient.get<MastersOverview>('/masters');
    return data;
  },

  async invite(phone: string, label?: string): Promise<MastersOverview> {
    const { data } = await apiClient.post<MastersOverview>('/masters', { phone, label });
    return data;
  },

  async accept(guid: string): Promise<MastersOverview> {
    const { data } = await apiClient.post<MastersOverview>(`/masters/${guid}/accept`);
    return data;
  },

  async decline(guid: string): Promise<MastersOverview> {
    const { data } = await apiClient.post<MastersOverview>(`/masters/${guid}/decline`);
    return data;
  },

  /** Клиент убирает мастера или мастер отказывается от клиента. */
  async remove(guid: string): Promise<MastersOverview> {
    const { data } = await apiClient.delete<MastersOverview>(`/masters/${guid}`);
    return data;
  },
};
