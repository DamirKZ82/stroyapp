import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, dictsApi, venuesApi, type City, type VenueDetails } from '@/api';
import { Button } from '@/components/Button';
import { Card, SectionLabel } from '@/components/Card';
import { Badge, EmptyState, ErrorBanner, Loader } from '@/components/Feedback';
import { LIST_CONTENT_FILL, Screen } from '@/components/Screen';
import { Thumb } from '@/components/Thumb';
import { HIT, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { capacityLabel } from '@/utils/capacity';
import { formatPrice } from '@/utils/format';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { pushOnce } from '@/utils/nav';

type VenueHall = VenueDetails['halls'][number];

/**
 * Заведение владельца: карточка заведения и список его залов.
 *
 * Отсюда владелец уходит в формы (заведения, зала) и в календарь зала, а
 * вернувшись, должен увидеть уже изменённое — поэтому данные грузятся на
 * каждый фокус экрана, а не один раз при открытии.
 */
export default function VenueScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { venueGuid } = useLocalSearchParams<{ venueGuid: string }>();

  const [venue, setVenue] = useState<VenueDetails | null>(null);
  const [cities, setCities] = useState<City[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const citiesLoaded = useRef(false);
  // Фокус и «потянуть вниз» могут запустить два запроса сразу: показываем
  // ответ только последнего, иначе старый ответ затрёт свежий.
  const lastRequest = useRef(0);

  const load = useCallback(async () => {
    const request = ++lastRequest.current;
    try {
      if (!venueGuid) throw new Error('venueGuid');
      const [res, cityList] = await Promise.all([
        venuesApi.get(venueGuid),
        // Сервер отдаёт у заведения только city_id, название города — в
        // справочнике. Он не меняется, поэтому берём его один раз и вместе
        // с заведением: придёт позже — карточка подпрыгнет. Без него экран
        // работает, просто без строки города, поэтому его ошибку глотаем.
        citiesLoaded.current
          ? null
          : dictsApi
              .cities()
              .then((r) => r.items)
              .catch(() => null),
      ]);
      if (request !== lastRequest.current) return;
      setVenue(res.venue);
      if (cityList) {
        citiesLoaded.current = true;
        setCities(cityList);
      }
      // Ошибку снимаем только после удачного ответа, а не перед запросом:
      // иначе при повторе полоса ошибки мигает.
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
  }, [venueGuid, t]);

  // Только на фокус: он срабатывает и при первом открытии, отдельный
  // useEffect дал бы второй такой же запрос.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const editVenue = useCallback(() => {
    pushOnce({ pathname: '/venue-form', params: { venueGuid } });
  }, [venueGuid]);

  const addHall = useCallback(() => {
    pushOnce({ pathname: '/hall-form', params: { venueGuid } });
  }, [venueGuid]);

  const cityId = venue?.city_id;
  const cityName = useMemo(() => {
    const city = cities?.find((c) => c.id === cityId);
    return city ? dictName(city, lang) : null;
  }, [cities, cityId, lang]);

  const keyExtractor = useCallback((hall: VenueHall) => hall.guid, []);

  const renderItem = useCallback(
    ({ item }: { item: VenueHall }) => (
      <HallRow
        hall={item}
        onEdit={() =>
          pushOnce({ pathname: '/hall-form', params: { venueGuid, hallGuid: item.guid } })
        }
        onCalendar={() =>
          pushOnce({
            pathname: '/hall-calendar',
            params: { hallGuid: item.guid, hallName: item.name },
          })
        }
      />
    ),
    [venueGuid],
  );

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: true, title: '' }} />
        <Loader />
      </Screen>
    );
  }

  if (!venue) {
    return (
      <Screen scroll refreshing={refreshing} onRefresh={refresh}>
        <Stack.Screen options={{ headerShown: true, title: '' }} />
        <ErrorBanner message={error ?? t('common.error_generic')} />
        <Button label={t('common.retry')} variant="outline" busy={refreshing} onPress={refresh} />
      </Screen>
    );
  }

  const hasHalls = venue.halls.length > 0;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: venue.name }} />
      <FlatList
        data={venue.halls}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={LIST_CONTENT_FILL}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <ErrorBanner message={error} />

            <Card>
              <View style={styles.venueText}>
                <Text style={styles.venueName}>{venue.name}</Text>
                <Text style={styles.venueAddress}>{venue.address}</Text>
                {cityName ? <Text style={styles.venueCity}>{cityName}</Text> : null}
              </View>
              <Button
                label={t('common.edit')}
                variant="outline"
                icon="pencil-outline"
                onPress={editVenue}
                style={styles.editButton}
              />
            </Card>

            <View style={styles.sectionRow}>
              <View style={styles.sectionText}>
                <SectionLabel>{t('owner.venue_details_halls')}</SectionLabel>
              </View>
              {/* Пока залов нет, эту же кнопку показывает пустое состояние:
                  две одинаковые главные кнопки подряд ни к чему. */}
              {hasHalls ? (
                <Button
                  label={t('owner.add_hall')}
                  icon="plus"
                  small
                  onPress={addHall}
                  style={styles.addButton}
                />
              ) : null}
            </View>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title={t('owner.no_halls')}
            action={<Button label={t('owner.add_hall')} icon="plus" onPress={addHall} />}
          />
        }
      />
    </Screen>
  );
}

interface HallRowProps {
  hall: VenueHall;
  onEdit: () => void;
  onCalendar: () => void;
}

/**
 * Строка зала. Календарь — сосед нажимаемой части, а не её ребёнок: кнопку
 * внутри кнопки VoiceOver читает как один элемент, и до календаря было бы
 * не добраться.
 */
function HallRow({ hall, onEdit, onCalendar }: HallRowProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  const capacity = capacityLabel(t, hall.capacity_min, hall.capacity_max);

  return (
    <Card style={styles.hall}>
      <Pressable
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityHint={t('common.edit')}
        style={({ pressed }) => [styles.hallMain, pressed && styles.pressed]}
      >
        {/* Отдельного главного превью в этом ответе нет — им служит первое фото. */}
        <Thumb path={hall.photos[0]?.thumb_path} size={68} iconSize={28} />
        <View style={styles.hallText}>
          <Text style={styles.hallName} numberOfLines={1}>
            {hall.name}
          </Text>
          {capacity ? (
            <Text style={styles.hallMeta} numberOfLines={1}>
              {capacity}
            </Text>
          ) : null}
          <Text style={styles.hallPrice} numberOfLines={1}>
            {formatPrice(hall.price_weekday)} / {formatPrice(hall.price_weekend)}
          </Text>
          {!hall.is_active ? (
            <View style={styles.hallBadge}>
              <Badge label={t('owner.provider_inactive')} tone="warning" />
            </View>
          ) : null}
        </View>
      </Pressable>
      <Pressable
        onPress={onCalendar}
        accessibilityRole="button"
        accessibilityLabel={t('owner.calendar_button')}
        style={({ pressed }) => [styles.calendar, pressed && styles.pressed]}
      >
        <Icon name="calendar-check-outline" size={24} color={colors.primary} />
      </Pressable>
    </Card>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    header: { gap: space.gap },
    venueText: { gap: 4 },
    venueName: { fontSize: text.section, fontWeight: '700', color: colors.text },
    venueAddress: { fontSize: text.body, color: colors.text },
    venueCity: { fontSize: text.caption, color: colors.muted },
    editButton: { alignSelf: 'flex-start' },
    // Высота строки задана явно: с кнопкой и без неё (пустой список)
    // подпись раздела стоит на одном месте.
    sectionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.gap,
      minHeight: 44,
      marginTop: 4,
    },
    sectionText: { flex: 1, minWidth: 0 },
    addButton: { flexShrink: 0 },
    // Отступы карточки сняты: их несёт нажимаемая часть, чтобы зона
    // нажатия доходила до краёв карточки.
    hall: { padding: 0, gap: 0, flexDirection: 'row', alignItems: 'stretch', overflow: 'hidden' },
    hallMain: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.gap,
      padding: space.gap,
    },
    pressed: { opacity: 0.7 },
    hallText: { flex: 1, minWidth: 0, gap: 2 },
    hallName: { fontSize: text.body, fontWeight: '600', color: colors.text },
    hallMeta: { fontSize: text.caption, color: colors.muted },
    hallPrice: { fontSize: text.caption, fontWeight: '600', color: colors.primary },
    hallBadge: { marginTop: 4 },
    calendar: {
      width: 56,
      minHeight: HIT,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: colors.border,
    },
  });
