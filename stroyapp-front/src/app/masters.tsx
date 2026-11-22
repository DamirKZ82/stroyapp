import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, mastersApi } from '@/api';
import type { MasterLink, MastersOverview } from '@/api/types';
import { Button } from '@/components/Button';
import { Card, Row, RowGroup, SectionLabel } from '@/components/Card';
import { Badge, ErrorBanner, Loader } from '@/components/Feedback';
import { Field, Input } from '@/components/Field';
import { LIST_CONTENT, Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { confirmDestructive } from '@/utils/alert';
import { pushOnce, useOnTop } from '@/utils/nav';
import { formatKzPhoneDisplay, maskPhoneInput, normalizeKzPhone } from '@/utils/phone';

const LABEL_MAX = 60;

/**
 * Мастера клиента и клиенты мастера на одном экране: один и тот же человек
 * бывает и тем и другим, а связь между ними одна.
 *
 * Клиент добавляет мастера по номеру. Мастер, войдя с этим номером, видит
 * приглашение и принимает его — после этого может оформлять заявки от имени
 * клиента. Каждую такую заявку клиент подтверждает сам, до этого продавец
 * её не видит.
 */
export default function MastersScreen() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const onTop = useOnTop();

  const [data, setData] = useState<MastersOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Связи, по которым идёт запрос: кнопки на них заняты.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const [addOpen, setAddOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addLocked = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await mastersApi.list());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const run = useCallback(
    async (guid: string, action: () => Promise<MastersOverview>, failTitle: string) => {
      setBusy((prev) => new Set(prev).add(guid));
      try {
        setData(await action());
      } catch (e) {
        if (onTop.current) {
          Alert.alert(failTitle, e instanceof ApiError ? e.message : t('common.error_generic'));
        }
        void load();
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(guid);
          return next;
        });
      }
    },
    [load, onTop, t],
  );

  const openAdd = () => {
    setPhone('');
    setLabel('');
    setAddError(null);
    setAddOpen(true);
  };

  const submitAdd = async () => {
    if (addLocked.current) return;
    const normalized = normalizeKzPhone(phone);
    if (!normalized) {
      setAddError(t('masters.phone_invalid'));
      return;
    }
    addLocked.current = true;
    setAdding(true);
    setAddError(null);
    try {
      setData(await mastersApi.invite(normalized, label.trim() || undefined));
      setAddOpen(false);
    } catch (e) {
      setAddError(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      setAdding(false);
      addLocked.current = false;
    }
  };

  const removeMaster = (link: MasterLink) =>
    confirmDestructive(
      t('masters.remove_title'),
      t('masters.remove_text'),
      () => void run(link.guid, () => mastersApi.remove(link.guid), t('masters.action_failed')),
      t('masters.remove_yes'),
      t('common.no'),
    );

  const leaveClient = (link: MasterLink) =>
    confirmDestructive(
      t('masters.leave_title'),
      t('masters.leave_text'),
      () => void run(link.guid, () => mastersApi.remove(link.guid), t('masters.action_failed')),
      t('masters.leave_yes'),
      t('common.no'),
    );

  const header = <Stack.Screen options={{ headerShown: true, title: t('masters.title') }} />;

  if (loading) {
    return (
      <Screen>
        {header}
        <Loader />
      </Screen>
    );
  }

  const masters = data?.masters ?? [];
  const clients = data?.clients ?? [];
  const invites = data?.invites ?? [];

  return (
    <Screen>
      {header}
      <ScrollView
        contentContainerStyle={LIST_CONTENT}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load();
            }}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      >
        <ErrorBanner message={error} />
        {!data && error ? (
          <Button label={t('common.retry')} variant="outline" onPress={() => void load()} />
        ) : null}

        {invites.length > 0 ? (
          <View style={styles.section}>
            <SectionLabel>{t('masters.invites_section')}</SectionLabel>
            {invites.map((inv) => (
              <Card key={inv.guid}>
                <Text style={styles.name} numberOfLines={1}>
                  {inv.name || formatKzPhoneDisplay(inv.phone ?? '')}
                </Text>
                <Text style={styles.hint}>{t('masters.invite_text')}</Text>
                <View style={styles.actions}>
                  <Button
                    label={t('masters.decline')}
                    variant="text"
                    tone="danger"
                    disabled={busy.has(inv.guid)}
                    onPress={() =>
                      void run(inv.guid, () => mastersApi.decline(inv.guid), t('masters.action_failed'))
                    }
                  />
                  <Button
                    label={t('masters.accept')}
                    small
                    busy={busy.has(inv.guid)}
                    onPress={() =>
                      void run(inv.guid, () => mastersApi.accept(inv.guid), t('masters.action_failed'))
                    }
                  />
                </View>
              </Card>
            ))}
          </View>
        ) : null}

        {/* Мастеру важнее его клиенты: у кого они есть, видит их первыми. */}
        {clients.length > 0 ? (
          <View style={styles.section}>
            <SectionLabel>{t('masters.my_clients')}</SectionLabel>
            <Text style={styles.hint}>{t('masters.my_clients_hint')}</Text>
            {clients.map((c) => (
              <Card key={c.guid}>
                <Text style={styles.name} numberOfLines={1}>
                  {c.name || formatKzPhoneDisplay(c.phone ?? '')}
                </Text>
                {c.phone ? (
                  <Text style={styles.meta} numberOfLines={1}>
                    {formatKzPhoneDisplay(c.phone)}
                  </Text>
                ) : null}
                <View style={styles.actions}>
                  <Button
                    label={t('masters.leave')}
                    variant="text"
                    tone="danger"
                    busy={busy.has(c.guid)}
                    onPress={() => leaveClient(c)}
                  />
                </View>
              </Card>
            ))}
            <RowGroup>
              <Row
                first
                title={t('masters.ordered_bookings')}
                icon="clipboard-list-outline"
                onPress={() => pushOnce('/ordered-bookings')}
              />
            </RowGroup>
          </View>
        ) : null}
        <View style={styles.section}>
          <SectionLabel>{t('masters.my_masters')}</SectionLabel>
          <Text style={styles.hint}>{t('masters.my_masters_hint')}</Text>
          {masters.map((m) => (
            <Card key={m.guid}>
              <View style={styles.line}>
                <View style={styles.lineText}>
                  <Text style={styles.name} numberOfLines={1}>
                    {m.name || formatKzPhoneDisplay(m.phone ?? '')}
                  </Text>
                  {m.name && m.phone ? (
                    <Text style={styles.meta} numberOfLines={1}>
                      {formatKzPhoneDisplay(m.phone)}
                    </Text>
                  ) : null}
                </View>
                <Badge
                  label={m.status === 'active' ? t('masters.status_active') : t('masters.status_invited')}
                  tone={m.status === 'active' ? 'success' : 'warning'}
                />
              </View>
              {m.status === 'invited' ? (
                <Text style={styles.hint}>{t('masters.invited_hint')}</Text>
              ) : null}
              <View style={styles.actions}>
                <Button
                  label={t('masters.remove')}
                  variant="text"
                  tone="danger"
                  busy={busy.has(m.guid)}
                  onPress={() => removeMaster(m)}
                />
              </View>
            </Card>
          ))}
          <Button label={t('masters.add')} variant="outline" icon="account-plus-outline" onPress={openAdd} />
        </View>

      </ScrollView>

      <Sheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        title={t('masters.add_title')}
        dismissable={!adding}
      >
        <View style={styles.sheetBody}>
          <Text style={styles.hint}>{t('masters.add_hint')}</Text>
          <Field label={t('masters.phone_label')} error={addError}>
            <Input
              value={phone}
              onChangeText={(v) => {
                setPhone(maskPhoneInput(v));
                setAddError(null);
              }}
              onFocus={() => {
                if (!phone) setPhone('+7');
              }}
              placeholder="+7 (701) 123 45 67"
              keyboardType="phone-pad"
              autoComplete="tel"
              invalid={!!addError}
              accessibilityLabel={t('masters.phone_label')}
            />
          </Field>
          <Field label={t('masters.label_label')} hint={t('masters.label_hint')}>
            <Input
              value={label}
              onChangeText={setLabel}
              placeholder={t('masters.label_placeholder')}
              maxLength={LABEL_MAX}
              accessibilityLabel={t('masters.label_label')}
            />
          </Field>
          <Button label={t('masters.add_submit')} busy={adding} onPress={() => void submitAdd()} />
        </View>
      </Sheet>
    </Screen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    section: { gap: space.gap },
    line: { flexDirection: 'row', alignItems: 'center', gap: space.gap },
    lineText: { flex: 1, minWidth: 0, gap: 2 },
    name: { fontSize: text.subtitle, fontWeight: '600', color: colors.text },
    meta: { fontSize: text.caption, color: colors.muted },
    hint: { fontSize: text.caption, color: colors.muted },
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 8,
    },
    sheetBody: { gap: space.gap },
  });
