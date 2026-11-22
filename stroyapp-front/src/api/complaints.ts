import { apiClient } from './client';

/** На что можно пожаловаться. */
export type ComplaintTarget = 'provider' | 'review' | 'chat';

/** Причина жалобы. Набор допустимых причин у каждого вида жалобы свой — см. экран report. */
export type ComplaintReason = 'false_info' | 'photos' | 'fraud' | 'offensive' | 'spam' | 'other';

export interface ComplaintBody {
  target_type: ComplaintTarget;
  /** guid зала, исполнителя, отзыва или чата. */
  target_guid: string;
  reason: ComplaintReason;
  comment?: string;
}

export const complaintsApi = {
  /**
   * already — такая жалоба от этого человека уже лежит неразобранной;
   * вторую сервер не завёл.
   */
  async create(body: ComplaintBody): Promise<{ ok: true; already: boolean }> {
    const { data } = await apiClient.post<{ ok: true; already: boolean }>('/complaints', body);
    return data;
  },
};
