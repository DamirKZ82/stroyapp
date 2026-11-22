import { apiClient } from './client';

/**
 * Запись чёрного списка: «я закрыл для себя переписку с этим человеком».
 *
 * Это не блокировка аккаунта админом (та закрывает человеку вход) — поэтому
 * здесь везде слово peer, «собеседник».
 *
 * Идентификаторов пользователей в переписке сервер не отдаёт, только имя.
 * Поэтому блокировку ставят и снимают по guid чата, а в списке — по guid
 * самой записи.
 */
export interface PeerBlock {
  /** guid записи блокировки, а не человека: по нему её снимают из списка. */
  guid: string;
  name: string | null;
  /** Объявление из последней переписки с этим человеком; null, если его уже нет. */
  subject_name: string | null;
  /**
   * Сама эта переписка: по ней из списка открывают историю — в «Сообщениях»
   * чатов с заблокированным нет. null, если переписки не осталось (зал
   * удалили вместе с ней); поля нет вовсе, если сервер старше него.
   */
  chat_guid?: string | null;
  created_at: string;
}

export const peerBlocksApi = {
  /**
   * Блокировка действует на человека, а не на чат: закрываются все переписки
   * с ним. already — он уже был заблокирован; для экрана это тот же успех.
   */
  async block(chatGuid: string): Promise<{ ok: true; already: boolean }> {
    const { data } = await apiClient.post<{ ok: true; already: boolean }>(
      `/chats/${chatGuid}/peer-block`,
    );
    return data;
  },

  /** Снять блокировку, не было её — тоже успех. */
  async unblock(chatGuid: string): Promise<{ ok: true }> {
    const { data } = await apiClient.delete<{ ok: true }>(`/chats/${chatGuid}/peer-block`);
    return data;
  },

  async list(): Promise<{ items: PeerBlock[] }> {
    const { data } = await apiClient.get<{ items: PeerBlock[] }>('/peer-blocks');
    return data;
  },

  /**
   * Снять блокировку из списка — по guid записи: чат к этому времени мог
   * исчезнуть вместе с удалённым объявлением.
   */
  async remove(guid: string): Promise<{ ok: true }> {
    const { data } = await apiClient.delete<{ ok: true }>(`/peer-blocks/${guid}`);
    return data;
  },
};
