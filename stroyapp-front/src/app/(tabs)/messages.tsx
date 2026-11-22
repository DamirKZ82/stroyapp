import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type ListRenderItem,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, chatsApi, type ChatListItem } from '@/api';
import { Button } from '@/components/Button';
import { EmptyState, ErrorBanner, Loader } from '@/components/Feedback';
import { Screen, ScreenTitle, TAB_BOTTOM, TAB_LIST_CONTENT } from '@/components/Screen';
import { Thumb } from '@/components/Thumb';
import type { AppLanguage } from '@/i18n';
import { useAuthGateStore } from '@/store/authGateStore';
import { useIsAuthed } from '@/store/useRequireAuth';
import { HIT, radius, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { formatDateHuman } from '@/utils/format';
import { useLang } from '@/utils/lang';
import { pushOnce } from '@/utils/nav';
import { serverToday } from '@/utils/serverTime';

const POLL_INTERVAL_MS = 10000;

type LoadMode = 'focus' | 'refresh' | 'poll';

/**
 * Вкладка «Сообщения»: список чатов.
 *
 * Гостю чаты недоступны — вместо списка приглашение войти. Сам список живёт
 * в отдельном компоненте: при выходе он размонтируется, и чаты прежнего
 * человека не мелькают у следующего, а после входа загрузка начинается с
 * вертушки, а не с «пока нет сообщений».
 */
export default function MessagesScreen() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const isAuthed = useIsAuthed();
  const openGate = useAuthGateStore((s) => s.open);

  if (!isAuthed) {
    return (
      <Screen tab>
        <View style={styles.plain}>
          <ScreenTitle title={t('messages.title')} />
          <EmptyState
            title={t('messages.guest_title')}
            subtitle={t('messages.guest_subtitle')}
            action={<Button label={t('profile.login')} onPress={() => openGate('message')} />}
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen tab>
      <ChatList />
    </Screen>
  );
}

function ChatList() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  const [items, setItems] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Пришёл ли список хоть раз. Одной ошибки для «пусто» мало: на время
  // повтора она гасится, и под вертушкой мелькнуло бы «пока нет сообщений».
  const [known, setKnown] = useState(false);
  // Сколько запросов списка сейчас в пути: фоновый опрос не встаёт в очередь
  // за медленным ответом, иначе при плохой сети запросы копятся.
  const pending = useRef(0);

  const load = useCallback(
    async (mode: LoadMode) => {
      if (mode === 'poll') {
        if (pending.current > 0) return;
      } else {
        setError(null);
      }
      pending.current += 1;
      try {
        const resp = await chatsApi.list();
        setItems(resp.items);
        setKnown(true);
        // Список свежий — старая ошибка над ним уже неправда.
        setError(null);
      } catch (e) {
        // Фоновый опрос молчит: сеть пропадает постоянно, а список на экране
        // всё ещё годится.
        if (mode !== 'poll') setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      } finally {
        pending.current -= 1;
        setLoading(false);
        // Жест гасит только свой запрос: иначе вертушку обрывал бы фоновый
        // опрос, успевший ответить раньше.
        if (mode === 'refresh') setRefreshing(false);
      }
    },
    [t],
  );

  // Опрос идёт только пока вкладка на экране: под открытым чатом и на других
  // вкладках список никто не видит. Возврат на вкладку сразу обновляет его.
  useFocusEffect(
    useCallback(() => {
      void load('focus');
      const id = setInterval(() => void load('poll'), POLL_INTERVAL_MS);
      return () => clearInterval(id);
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load('refresh');
  }, [load]);

  const count = items.length;
  const renderItem = useCallback<ListRenderItem<ChatListItem>>(
    ({ item, index }) => <ChatRow item={item} first={index === 0} last={index === count - 1} />,
    [count],
  );
  const keyExtractor = useCallback((item: ChatListItem) => item.guid, []);

  if (loading) {
    return (
      <View style={styles.plain}>
        <ScreenTitle title={t('messages.title')} />
        <Loader />
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.primary}
          colors={[colors.primary]}
        />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <ScreenTitle title={t('messages.title')} />
          <ErrorBanner message={error} />
        </View>
      }
      ListEmptyComponent={
        // Пока список не пришёл, «пока нет сообщений» было бы неправдой: мы
        // не знаем. Вместо него — кнопка: жест «потянуть» на пустом экране
        // не очевиден.
        error || !known ? (
          <Button
            label={t('common.retry')}
            variant="outline"
            busy={refreshing}
            onPress={onRefresh}
          />
        ) : (
          <EmptyState title={t('messages.empty_title')} subtitle={t('messages.empty_hint')} />
        )
      }
    />
  );
}

interface ChatRowProps {
  item: ChatListItem;
  first: boolean;
  last: boolean;
}

function ChatRow({ item, first, last }: ChatRowProps) {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  const unread = item.unread_count > 0;
  const mine = item.last_message_is_mine === true;
  const read = item.last_message_read === true;

  const name = item.other_user.name ?? '—';
  const subject = item.subject.name ?? '—';
  const time = chatTime(item.last_message_at, lang, t('messages.yesterday'));
  const preview = item.last_message_preview
    ? `${mine ? `${t('messages.you')}: ` : ''}${item.last_message_preview}`
    : t('messages.no_messages_yet');

  // Точку непрочитанного VoiceOver не видит — проговариваем её словами.
  const label = [
    name,
    subject,
    preview,
    time,
    unread ? t('messages.unread_a11y', { count: item.unread_count }) : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Pressable
      onPress={() => pushOnce({ pathname: '/chat', params: { chatGuid: item.guid } })}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.row,
        first ? styles.rowFirst : styles.rowDivided,
        last && styles.rowLast,
        pressed && styles.rowPressed,
      ]}
    >
      <Thumb path={item.subject.main_thumb} size={48} />

      <View style={styles.body}>
        <View style={styles.top}>
          <Text style={[styles.name, unread && styles.nameUnread]} numberOfLines={1}>
            {name}
          </Text>
          {time ? (
            <Text style={styles.time} numberOfLines={1}>
              {time}
            </Text>
          ) : null}
        </View>
        <Text style={styles.subject} numberOfLines={1}>
          {subject}
        </Text>
        <View style={styles.previewRow}>
          {/* Галочки только у своих сообщений: одна — отправлено, две —
              собеседник прочитал. */}
          {mine ? (
            <Icon
              name={read ? 'check-all' : 'check'}
              size={16}
              color={read ? colors.primary : colors.muted}
            />
          ) : null}
          <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={1}>
            {preview}
          </Text>
          {unread ? <View style={styles.dot} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Сегодня — время, вчера — «Вчера», раньше — дата. «Сегодня» — по поясу
 * сервера: он пишет время сообщений без пояса.
 */
function chatTime(iso: string | null, lang: AppLanguage, yesterday: string): string {
  if (!iso) return '';
  const date = iso.slice(0, 10);
  if (date === serverToday()) return iso.slice(11, 16);
  if (date === serverToday(1)) return yesterday;
  return formatDateHuman(date, lang);
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Гость и первая загрузка: заголовок на том же месте, что и в списке.
    plain: { flex: 1, padding: space.page, paddingBottom: TAB_BOTTOM, gap: space.gap },
    // Строки стоят вплотную, одной карточкой, поэтому общий gap списка убран,
    // а отступ под заголовком отдан самой шапке.
    list: { ...TAB_LIST_CONTENT, gap: 0 },
    header: { gap: space.gap, marginBottom: space.gap },

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.gap,
      minHeight: HIT,
      paddingHorizontal: space.card,
      paddingVertical: 12,
      backgroundColor: colors.card,
    },
    rowFirst: { borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card },
    rowLast: { borderBottomLeftRadius: radius.card, borderBottomRightRadius: radius.card },
    rowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    rowPressed: { backgroundColor: colors.background },

    body: { flex: 1, minWidth: 0, gap: 2 },
    top: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
    name: { flex: 1, minWidth: 0, fontSize: text.body, fontWeight: '500', color: colors.text },
    nameUnread: { fontWeight: '700' },
    time: { flexShrink: 0, fontSize: text.caption, color: colors.muted },
    subject: { fontSize: text.caption, color: colors.muted },
    previewRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    preview: { flex: 1, minWidth: 0, fontSize: text.caption, color: colors.muted },
    previewUnread: { color: colors.text, fontWeight: '600' },
    dot: {
      width: 10,
      height: 10,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
      flexShrink: 0,
      marginLeft: 4,
    },
  });
