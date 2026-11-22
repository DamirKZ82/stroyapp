import { apiClient } from './client';
import type { PriceUnit } from './types';

/** Объявление, о котором переписка. */
export interface ChatSubject {
  type: 'provider';
  guid: string | null;
  name: string | null;
  main_thumb: string | null;
  main_photo: string | null;
  category_code?: string | null;
}

export interface ChatListItem {
  guid: string;
  /** Унифицированный subject (есть всегда). */
  subject: ChatSubject;
  /** Объявление (магазин или бригада); null, если удалено. */
  provider: {
    guid: string;
    name: string;
    main_thumb: string | null;
    main_photo: string | null;
    price_from: number | null;
    price_unit: PriceUnit | null;
    category_code: string | null;
  } | null;
  /** Заявка — опционально. null если юзер ещё не подал заявку */
  booking: {
    guid: string;
    event_date: string;
    status: 'pending' | 'confirmed' | 'rejected' | 'cancelled';
  } | null;
  other_user: { name: string | null; phone: string | null };
  last_message_at: string | null;
  last_message_preview: string | null;
  /** true — последнее сообщение отправил текущий юзер; null если сообщений ещё нет */
  last_message_is_mine: boolean | null;
  /** true — последнее сообщение прочитано получателем (имеет смысл только если last_message_is_mine=true) */
  last_message_read: boolean | null;
  unread_count: number;
  /** true — я владелец объявления в этом чате, false — я клиент */
  is_owner: boolean;
  /**
   * true — этого собеседника заблокировал я сам. Сервер старше блокировок
   * поля не шлёт, поэтому сравнивать только `=== true`: нет поля — не блокировал.
   */
  peer_block_by_me?: boolean;
  /**
   * false — писать в этот чат сейчас нельзя. Пока причина одна — блокировка
   * с любой из сторон; кто из двоих заблокировал, сервер намеренно не говорит
   * (про себя — peer_block_by_me, про собеседника — ничего). Сравнивать
   * только `=== false`: нет поля — писать можно.
   */
  can_write?: boolean;
}

export interface ChatMessage {
  guid: string;
  text: string;
  sender_id: number;
  is_mine: boolean;
  created_at: string;
  read_at: string | null;
}

export interface ChatDetails {
  chat: ChatListItem;
  messages: ChatMessage[];
}

export const chatsApi = {
  async list(): Promise<{ items: ChatListItem[] }> {
    const { data } = await apiClient.get<{ items: ChatListItem[] }>('/chats');
    return data;
  },

  async unreadCount(): Promise<{ unread_count: number }> {
    const { data } = await apiClient.get<{ unread_count: number }>('/chats/unread-count');
    return data;
  },

  async get(guid: string): Promise<ChatDetails> {
    const { data } = await apiClient.get<ChatDetails>(`/chats/${guid}`);
    return data;
  },

  async send(guid: string, text: string): Promise<{ message: ChatMessage }> {
    const { data } = await apiClient.post<{ message: ChatMessage }>(
      `/chats/${guid}/messages`,
      { text },
    );
    return data;
  },

  async markRead(guid: string): Promise<{ marked: true }> {
    const { data } = await apiClient.post<{ marked: true }>(`/chats/${guid}/mark-read`);
    return data;
  },

  /** Создать (или получить) чат по объявлению. Кнопка «Написать» на карточке. */
  async openWithProvider(providerGuid: string): Promise<{ chat_guid: string }> {
    const { data } = await apiClient.post<{ chat_guid: string }>(
      `/providers/${providerGuid}/chat`,
    );
    return data;
  },
};
