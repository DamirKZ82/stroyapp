import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  View,
  type ListRenderItem,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, peerBlocksApi, type PeerBlock } from '@/api';
import { Button } from '@/components/Button';
import { Row, RowGroup } from '@/components/Card';
import { EmptyState, ErrorBanner, Loader, useAnnounce } from '@/components/Feedback';
import { LIST_CONTENT_FILL, Screen } from '@/components/Screen';
import { useColors } from '@/theme/scheme';
import { formatDateHuman } from '@/utils/format';
import { useLang } from '@/utils/lang';
import { pushOnce } from '@/utils/nav';

const NONE: ReadonlySet<string> = new Set();

/**
 * Заблокированные собеседники: с кем человек закрыл для себя переписку.
 *
 * Без этого экрана блокировку было бы не снять, а переписку — не открыть:
 * чаты с заблокированным пропадают из «Сообщений». Клиент ещё может зайти в
 * неё с объявления (пока его не скрыли и не удалили), а владельцу объявления
 * и этой дороги нет. Поэтому строка здесь открывает саму переписку — с
 * историей, «Пожаловаться» и «Разблокировать».
 */
export default function BlockedUsersScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const colors = useColors();

  const [items, setItems] = useState<PeerBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Пришёл ли список хоть раз. «Вы никого не заблокировали» — утверждение о
  // списке, а не об отсутствии ошибки: пока он не пришёл, мы этого не знаем.
  const [known, setKnown] = useState(false);
  // Набор, а не одна запись: пока снимается первая блокировка, человек
  // успевает нажать на вторую, и вертушка должна остаться на обеих.
  const [busy, setBusy] = useState<ReadonlySet<string>>(NONE);
  // Что сказать экранному диктору: после «Разблокировать» человек просто
  // исчезает из списка, фокус диктора остаётся на пропавшей строке, и без
  // слов он не узнал бы, что блокировка снята. С именем — чтобы два снятия
  // подряд были двумя разными объявлениями: одинаковый текст не повторяют.
  const [notice, setNotice] = useState<string | null>(null);
  useAnnounce(notice);

  // Номер последнего запроса списка: фокус и «потянуть вниз» могут запустить
  // два сразу, а ответ, собранный до снятия блокировки, вернул бы её в список.
  const requestRef = useRef(0);
  // Замки по записям, а не только состояние: два быстрых нажатия успевают
  // пройти до перерисовки кнопки.
  const locks = useRef(new Set<string>());

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const resp = await peerBlocksApi.list();
      if (request !== requestRef.current) return;
      setItems(resp.items);
      setKnown(true);
      // Ошибку снимаем после удачного ответа, а не перед запросом: иначе при
      // повторе полоса мигает, а список под ней прыгает.
      setError(null);
    } catch (e) {
      if (request !== requestRef.current) return;
      // Прежний список при ошибке не трогаем: полоса над тем, что уже
      // показано, полезнее пустого экрана.
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      if (request === requestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [t]);

  // Только по фокусу, без отдельного useEffect: фокус срабатывает и при
  // первом открытии, а второй запрос рядом был бы лишним.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  // Без подтверждения: снять блокировку — не то, о чём потом жалеют, а
  // поставить её заново можно из чата.
  const unblock = useCallback(
    async (item: PeerBlock) => {
      if (locks.current.has(item.guid)) return;
      locks.current.add(item.guid);
      setBusy((prev) => new Set(prev).add(item.guid));
      try {
        await peerBlocksApi.remove(item.guid);
        // Список, запрошенный до ответа, вернул бы эту запись обратно —
        // обнуляем его. Он же должен был погасить вертушку «потянуть вниз»,
        // поэтому гасим её сами.
        requestRef.current += 1;
        setRefreshing(false);
        // Строку убираем на месте, без нового запроса: сервер уже ответил, и
        // список не мигает.
        setItems((prev) => prev.filter((other) => other.guid !== item.guid));
        setError(null);
        setNotice(
          t('peer_block.unblocked_a11y', { name: item.name || t('peer_block.no_name') }),
        );
      } catch (e) {
        // В полосу над списком, а не окном: список короткий, полоса на виду,
        // и диктор её объявит.
        setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      } finally {
        locks.current.delete(item.guid);
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(item.guid);
          return next;
        });
      }
    },
    [t],
  );

  const renderItem = useCallback<ListRenderItem<PeerBlock>>(
    ({ item }) => {
      const name = item.name || t('peer_block.no_name');
      // Объявление — потому что владельца знают по нему, а не по личному
      // имени. Его может не быть: объявление удалили вместе с перепиской.
      const meta = [
        item.subject_name,
        t('peer_block.since', { date: formatDateHuman(item.created_at.slice(0, 10), lang) }),
      ]
        .filter(Boolean)
        .join(' · ');
      const chatGuid = item.chat_guid;
      return (
        <RowGroup>
          {/* Верхняя строка открывает переписку. Её может уже не быть — зал
              удалили вместе с ней — или сервер старше этого поля: тогда это
              просто подпись, без стрелки. */}
          <Row
            first
            title={name}
            subtitle={meta}
            accessibilityLabel={
              chatGuid ? `${t('peer_block.open_chat_a11y', { name })}, ${meta}` : `${name}, ${meta}`
            }
            onPress={
              chatGuid ? () => pushOnce({ pathname: '/chat', params: { chatGuid } }) : undefined
            }
          />
          <Row
            title={t('peer_block.unblock')}
            icon="account-lock-open-outline"
            // Строк с одной подписью на экране столько же, сколько людей:
            // диктору нужно имя, чтобы их различить.
            accessibilityLabel={t('peer_block.unblock_a11y', { name })}
            // Строка никуда не ведёт, поэтому справа не стрелка, а пустой
            // элемент (просто null её не убирает) — или вертушка, пока идёт
            // запрос. Повторное нажатие в это время гасит замок в unblock.
            right={busy.has(item.guid) ? <ActivityIndicator color={colors.muted} /> : <View />}
            onPress={() => void unblock(item)}
          />
        </RowGroup>
      );
    },
    [busy, colors, lang, t, unblock],
  );

  const keyExtractor = useCallback((item: PeerBlock) => item.guid, []);

  const header = (
    <Stack.Screen options={{ headerShown: true, title: t('peer_block.list_title') }} />
  );

  if (loading) {
    return (
      <Screen>
        {header}
        <Loader />
      </Screen>
    );
  }

  return (
    <Screen>
      {header}
      <FlatList
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={LIST_CONTENT_FILL}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        // Пустой заголовок списку не отдаём: обёртка нулевой высоты всё
        // равно получила бы свой gap, и первая карточка съехала бы вниз.
        ListHeaderComponent={error ? <ErrorBanner message={error} /> : null}
        // Пока список не пришёл, «никого не заблокировали» было бы неправдой.
        // Вместо него — кнопка: жест «потянуть» на пустом экране не очевиден.
        ListEmptyComponent={
          error || !known ? (
            <Button
              label={t('common.retry')}
              variant="outline"
              busy={refreshing}
              onPress={onRefresh}
            />
          ) : (
            <EmptyState
              title={t('peer_block.list_empty_title')}
              subtitle={t('peer_block.list_empty_hint')}
            />
          )
        }
      />
    </Screen>
  );
}
