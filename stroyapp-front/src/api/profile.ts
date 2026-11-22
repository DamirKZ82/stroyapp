import { apiClient } from './client';
import type { User } from './types';

export const profileApi = {
  async get(): Promise<{ user: User }> {
    const { data } = await apiClient.get('/profile');
    return data;
  },

  async patch(patch: Partial<Pick<User, 'full_name' | 'language'>>): Promise<{ user: User }> {
    const { data } = await apiClient.patch('/profile', patch);
    return data;
  },

  /**
   * Принять Условия использования. version — версия, которую человек видел
   * (user.terms_version): если на сервере уже другая, он ответит 409 и
   * согласие не запишет. В ответе тот же пользователь уже с
   * terms_accepted: true.
   */
  async acceptTerms(version?: string): Promise<{ user: User }> {
    const { data } = await apiClient.post('/profile/terms', version ? { version } : undefined);
    return data;
  },

  /**
   * Удалить аккаунт и все его данные: объявления, заявки, чаты, отзывы,
   * избранное. Необратимо — спрашивать подтверждение до вызова.
   */
  async remove(): Promise<{ deleted: boolean }> {
    const { data } = await apiClient.delete('/profile');
    return data;
  },
};
