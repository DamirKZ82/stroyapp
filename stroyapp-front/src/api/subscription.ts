import { apiClient } from './client';
import type { PlanOffer, PlanPayment, ProviderVerification, SellerPlan } from './types';

/** Тариф продавца: Pro, пробный период, оплата картой, «Проверенный». */
export const subscriptionApi = {
  async get(): Promise<{ plan: SellerPlan; offer: PlanOffer }> {
    const { data } = await apiClient.get<{ plan: SellerPlan; offer: PlanOffer }>('/subscription');
    return data;
  },

  /** Начать оплату: адрес страницы оплаты, её открывают в браузере. */
  async checkout(months: number): Promise<{ payment_guid: string; url: string }> {
    const { data } = await apiClient.post<{ payment_guid: string; url: string }>(
      '/subscription/checkout',
      { months },
    );
    return data;
  },

  async payments(): Promise<{ items: PlanPayment[] }> {
    const { data } = await apiClient.get<{ items: PlanPayment[] }>('/subscription/payments');
    return data;
  },

  /** Прислать БИН или ИИН объявления на проверку. */
  async requestVerification(
    providerGuid: string,
    bin: string,
  ): Promise<{ verification: ProviderVerification }> {
    const { data } = await apiClient.post<{ verification: ProviderVerification }>(
      `/providers/${providerGuid}/verification`,
      { bin },
    );
    return data;
  },
};
