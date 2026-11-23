import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, subscriptionApi } from '@/api';
import type { PlanOffer, PlanPayment, SellerPlan } from '@/api/types';
import { Button } from '@/components/Button';
import { Card, SectionLabel } from '@/components/Card';
import { Badge, ErrorBanner, Loader } from '@/components/Feedback';
import { Screen } from '@/components/Screen';
import { Segment } from '@/components/Segment';
import { SUPPORT_EMAIL } from '@/config';
import { space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { formatDateHuman, formatPrice } from '@/utils/format';
import { useLang } from '@/utils/lang';
import { openPage, writeEmail } from '@/utils/links';
import { useOnTop } from '@/utils/nav';
import { PAY_IN_APP } from '@/utils/payments';

/** Таблица ключей, а не склейка: так их находит поиск по проекту. */
const TIER_KEY = {
  none: 'subscription.tier_none',
  trial: 'subscription.tier_trial',
  free: 'subscription.tier_free',
  pro: 'subscription.tier_pro',
} as const;

const PERIOD_KEY: Record<number, string> = {
  1: 'subscription.period_1',
  3: 'subscription.period_3',
  12: 'subscription.period_12',
};

/**
 * Тариф продавца: что действует сейчас, что даёт Pro и оплата картой.
 *
 * Оплата идёт на странице платёжного сервиса в браузере. Результат сервер
 * узнаёт от самого сервиса, а не от приложения, поэтому экран просто
 * перечитывает тариф, когда человек возвращается из браузера.
 *
 * На iOS оплаты здесь нет вовсе (см. PAY_IN_APP): экран только показывает
 * тариф, а оплачивают его в веб-кабинете продавца.
 */
export default function SubscriptionScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const onTop = useOnTop();

  const [plan, setPlan] = useState<SellerPlan | null>(null);
  const [offer, setOffer] = useState<PlanOffer | null>(null);
  const [payments, setPayments] = useState<PlanPayment[]>([]);
  const [months, setMonths] = useState(12);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lastRequest = useRef(0);

  const load = useCallback(async () => {
    const request = ++lastRequest.current;
    try {
      const [sub, history] = await Promise.all([
        subscriptionApi.get(),
        // История — справка: её сбой не должен прятать сам тариф.
        subscriptionApi
          .payments()
          .then((r) => r.items)
          .catch(() => null),
      ]);
      if (request !== lastRequest.current) return;
      setPlan(sub.plan);
      setOffer(sub.offer);
      if (history) setPayments(history);
      setError(null);
    } catch (e) {
      if (request !== lastRequest.current) return;
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      if (request === lastRequest.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [t]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Из браузера с оплатой возвращаются без смены экрана — фокус не
  // срабатывает. Перечитываем, когда приложение снова на переднем плане.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && onTop.current) void load();
    });
    return () => sub.remove();
  }, [load, onTop]);

  const pay = async () => {
    setPaying(true);
    try {
      const { url } = await subscriptionApi.checkout(months);
      if (!(await openPage(url)) && onTop.current) {
        Alert.alert(t('subscription.pay'), t('common.error_generic'));
      }
    } catch (e) {
      if (onTop.current) {
        Alert.alert(
          t('subscription.pay'),
          e instanceof ApiError ? e.message : t('common.error_generic'),
        );
      }
    } finally {
      setPaying(false);
    }
  };

  const writeSupport = async () => {
    if (!(await writeEmail(SUPPORT_EMAIL, t('subscription.support_subject'))) && onTop.current) {
      Alert.alert(t('profile.support'), t('profile.support_failed', { email: SUPPORT_EMAIL }));
    }
  };

  const screenOptions = {
    headerShown: true,
    title: PAY_IN_APP ? t('subscription.title') : t('subscription.title_plan'),
  };

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={screenOptions} />
        <Loader />
      </Screen>
    );
  }

  const date = (ts: string | null) => (ts ? formatDateHuman(ts.slice(0, 10), lang) : '');

  let status = '';
  if (plan?.tier === 'pro') status = t('subscription.until', { date: date(plan.paid_until) });
  else if (plan?.tier === 'trial')
    status = t('subscription.trial_until', { date: date(plan.trial_ends_at) });
  else if (plan?.tier === 'free')
    status = t('subscription.free_hint', { count: offer?.free_items ?? 0 });
  else if (plan && offer) status = t('subscription.none_hint', { count: offer.trial_days });

  const period = offer?.periods.find((p) => p.months === months) ?? offer?.periods[0];
  const perMonth = period ? Math.floor(period.amount / period.months / 100) * 100 : 0;

  return (
    <Screen
      scroll
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void load();
      }}
      footer={
        offer && PAY_IN_APP ? (
          <View style={styles.footer}>
            {offer.can_pay ? (
              <Button
                label={plan?.tier === 'pro' ? t('subscription.extend') : t('subscription.pay')}
                icon="credit-card-outline"
                onPress={() => void pay()}
                busy={paying}
                disabled={!period}
              />
            ) : (
              <Button
                label={t('subscription.write_support')}
                variant="outline"
                icon="email-outline"
                onPress={() => void writeSupport()}
              />
            )}
          </View>
        ) : null
      }
    >
      <Stack.Screen options={screenOptions} />
      <ErrorBanner message={error} />

      {plan ? (
        <Card style={styles.current}>
          <View style={styles.tierRow}>
            <Text style={styles.tier}>{t(TIER_KEY[plan.tier])}</Text>
            {plan.promoted ? <Badge label={t('subscription.promoted')} tone="success" /> : null}
          </View>
          {status ? <Text style={styles.muted}>{status}</Text> : null}
          <Text style={styles.muted}>
            {t('subscription.items_visible', { count: plan.items_limit })}
          </Text>
        </Card>
      ) : null}

      {offer ? (
        <>
          <SectionLabel>{t('subscription.pro_label')}</SectionLabel>
          <Card style={styles.benefits}>
            <Benefit
              icon="format-list-numbered"
              label={t('subscription.benefit_items', { count: offer.pro_items })}
            />
            <Benefit
              icon="arrow-up-bold-circle-outline"
              label={t('subscription.benefit_promoted')}
            />
            <Benefit icon="check-decagram" label={t('subscription.benefit_verified')} />
          </Card>

          {!PAY_IN_APP ? (
            <Card>
              <Text style={styles.muted}>{t('subscription.pay_in_cabinet')}</Text>
            </Card>
          ) : offer.can_pay && period ? (
            <>
              <SectionLabel>{t('subscription.period_label')}</SectionLabel>
              <Segment<string>
                value={String(period.months)}
                onChange={(v) => setMonths(Number(v))}
                disabled={paying}
                options={offer.periods.map((p) => ({
                  value: String(p.months),
                  label: t(PERIOD_KEY[p.months] ?? 'subscription.period_1'),
                }))}
              />
              <Card style={styles.priceCard}>
                <Text style={styles.price}>{formatPrice(period.amount)}</Text>
                {period.months > 1 ? (
                  <Text style={styles.muted}>
                    {t('subscription.per_month', { price: formatPrice(perMonth) })}
                  </Text>
                ) : null}
                <Text style={styles.muted}>{t('subscription.pay_hint')}</Text>
              </Card>
            </>
          ) : (
            <Card>
              <Text style={styles.muted}>
                {t('subscription.pay_unavailable', { email: SUPPORT_EMAIL })}
              </Text>
            </Card>
          )}
        </>
      ) : null}

      {payments.length > 0 ? (
        <>
          <SectionLabel>{t('subscription.history_label')}</SectionLabel>
          <Card style={styles.history}>
            {payments.map((p) => (
              <View key={p.guid} style={styles.payment}>
                <View style={styles.paymentText}>
                  <Text style={styles.paymentTitle} numberOfLines={1}>
                    {t(PERIOD_KEY[p.months] ?? 'subscription.period_1')}
                    {p.gateway === 'admin' ? ` · ${t('subscription.gift')}` : ''}
                  </Text>
                  <Text style={styles.muted}>{date(p.paid_at ?? p.created_at)}</Text>
                </View>
                {p.status === 'paid' ? (
                  <Text style={styles.paymentAmount}>{formatPrice(p.amount)}</Text>
                ) : (
                  <Badge label={t('subscription.payment_failed')} tone="danger" />
                )}
              </View>
            ))}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

function Benefit({ icon, label }: { icon: keyof typeof Icon.glyphMap; label: string }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.benefit}>
      <Icon
        name={icon}
        size={22}
        color={colors.primary}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      <Text style={styles.benefitText}>{label}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    footer: { flex: 1 },
    current: { gap: 4 },
    tierRow: { flexDirection: 'row', alignItems: 'center', gap: space.gap },
    tier: { flexShrink: 1, fontSize: text.section, fontWeight: '700', color: colors.text },
    muted: { fontSize: text.caption, lineHeight: 20, color: colors.muted },
    benefits: { gap: space.gap },
    benefit: { flexDirection: 'row', alignItems: 'center', gap: space.gap },
    benefitText: { flex: 1, minWidth: 0, fontSize: text.body, color: colors.text },
    priceCard: { gap: 2 },
    price: { fontSize: text.metric, fontWeight: '700', color: colors.primary },
    history: { gap: space.gap },
    payment: { flexDirection: 'row', alignItems: 'center', gap: space.gap },
    paymentText: { flex: 1, minWidth: 0 },
    paymentTitle: { fontSize: text.body, fontWeight: '500', color: colors.text },
    paymentAmount: { flexShrink: 0, fontSize: text.body, fontWeight: '600', color: colors.text },
  });
