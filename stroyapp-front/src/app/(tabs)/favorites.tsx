import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View, type ListRenderItem } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, favoritesApi } from '@/api';
import type { FavoriteItem } from '@/api/types';
import { Button } from '@/components/Button';
import { EmptyState, ErrorBanner, Loader } from '@/components/Feedback';
import { HallCard } from '@/components/HallCard';
import { ProviderCard } from '@/components/ProviderCard';
import { Screen, ScreenTitle, TAB_LIST_CONTENT } from '@/components/Screen';
import { useAuthGateStore } from '@/store/authGateStore';
import { useFavoritesStore } from '@/store/favoritesStore';
import { useIsAuthed } from '@/store/useRequireAuth';
import { space } from '@/theme';
import { useColors } from '@/theme/scheme';
import { pushOnce } from '@/utils/nav';

// Одна и та же ссылка для «пусто»: сброс при выходе не вызывает лишний рендер,
// а гостю FlatList не получает новый массив на каждый кадр.
const NO_ITEMS: FavoriteItem[] = [];

/**
 * Вкладка «Избранное»: залы и исполнители вперемешку, в порядке сервера.
 *
 * Все состояния — гость, первая загрузка, пусто, ошибка — живут в одном
 * списке, а не в отдельных экранах: заголовок вкладки стоит на месте и не
 * прыгает, когда гость входит или список догружается.
 */
export default function FavoritesScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const isAuthed = useIsAuthed();
  const openGate = useAuthGateStore((s) => s.open);
  const toggleHall = useFavoritesStore((s) => s.toggle);
  const toggleProvider = useFavoritesStore((s) => s.toggleProvider);

  const [items, setItems] = useState<FavoriteItem[]>(NO_ITEMS);
  // «Ответ уже был», а не «идёт запрос»: вертушка на весь список нужна только
  // до первого ответа, дальше обновление идёт поверх уже показанных карточек.
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Номер последнего запроса. Запросы накладываются (фокус + «потянуть», выход
  // посреди загрузки), и опоздавший ответ не должен затирать свежий список
  // или показывать избранное прошлого аккаунта.
  const requestId = useRef(0);
  // Что убирают прямо сейчас. Пока DELETE в пути, сервер ещё отдаёт эту
  // запись, и перезагрузка по фокусу вернула бы только что убранную карточку.
  const removing = useRef(new Set<string>());

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setError(null);
    try {
      const resp = await favoritesApi.list();
      if (id === requestId.current) {
        setItems(resp.items.filter((it) => !removing.current.has(guidOf(it))));
      }
    } catch (e) {
      if (id === requestId.current) {
        setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      }
    } finally {
      if (id === requestId.current) {
        setLoaded(true);
        setRefreshing(false);
      }
    }
  }, [t]);

  // Вышел (или сервер ответил 401) — список прошлого аккаунта убираем сразу:
  // вкладка остаётся смонтированной, и следующий вошедший увидел бы чужое
  // избранное до ответа сервера.
  useEffect(() => {
    if (isAuthed) return;
    requestId.current += 1;
    setItems(NO_ITEMS);
    setLoaded(false);
    setRefreshing(false);
    setError(null);
  }, [isAuthed]);

  // Только по фокусу, без отдельного useEffect: первый фокус и есть первая
  // загрузка, а вдвоём они слали два запроса на открытие. isAuthed в
  // зависимостях — чтобы список загрузился сразу после входа через шторку,
  // когда вкладка уже в фокусе.
  useFocusEffect(
    useCallback(() => {
      if (isAuthed) void load();
    }, [isAuthed, load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const retry = useCallback(() => {
    setLoaded(false);
    void load();
  }, [load]);

  const remove = useCallback(
    async (item: FavoriteItem, index: number) => {
      const guid = guidOf(item);
      removing.current.add(guid);
      // Строку убираем до ответа сервера: сердце на этом экране значит
      // только «убрать», ждать тут нечего.
      setItems((prev) => prev.filter((it) => guidOf(it) !== guid));

      // Всегда false, а не «наоборот от того, что в сторе»: если стор не
      // догрузился, переключение по нему превратилось бы в «добавить».
      if (item.type === 'provider') await toggleProvider(guid, false);
      else await toggleHall(guid, false);
      removing.current.delete(guid);

      // Стор глотает ошибку запроса и молча возвращает guid на место — это
      // единственный признак, что убрать не вышло. Возвращаем и строку, иначе
      // она пропала бы с экрана, оставшись в избранном на сервере.
      if (!useFavoritesStore.getState().guids.has(guid)) return;
      setItems((prev) =>
        prev.some((it) => guidOf(it) === guid)
          ? prev
          : [...prev.slice(0, index), item, ...prev.slice(index)],
      );
      setError(t('common.error_generic'));
    },
    [toggleHall, toggleProvider, t],
  );

  const keyExtractor = useCallback((item: FavoriteItem) => `${item.type}:${guidOf(item)}`, []);

  const renderItem = useCallback<ListRenderItem<FavoriteItem>>(
    ({ item, index }) =>
      // showAvailability={false}: у избранного нет даты, плашке «свободно»
      // здесь не из чего взяться.
      item.type === 'provider' ? (
        <ProviderCard
          item={item}
          isFavorite
          showAvailability={false}
          onToggleFavorite={() => void remove(item, index)}
          onPress={() =>
            pushOnce({ pathname: '/provider', params: { providerGuid: item.provider.guid } })
          }
        />
      ) : (
        <HallCard
          item={item}
          isFavorite
          showAvailability={false}
          onToggleFavorite={() => void remove(item, index)}
          onPress={() => pushOnce({ pathname: '/hall', params: { hallGuid: item.hall.guid } })}
        />
      ),
    [remove],
  );

  // До первого ответа карточки не показываем вовсе — в items мог остаться
  // хвост прошлого входа (например, строка, возвращённая после неудачного
  // удаления уже после выхода).
  const ready = isAuthed && loaded;

  let empty;
  if (!isAuthed) {
    empty = (
      <EmptyState
        title={t('favorites.guest_title')}
        subtitle={t('favorites.guest_subtitle')}
        action={<Button label={t('profile.login')} onPress={() => openGate('favorite')} />}
      />
    );
  } else if (!loaded) {
    empty = <Loader />;
  } else if (error) {
    // Список пуст и загрузка не удалась: «пока нет избранного» было бы
    // неправдой, а жест «потянуть» на пустом экране не очевиден.
    empty = <Button label={t('common.retry')} variant="outline" onPress={retry} />;
  } else {
    empty = <EmptyState title={t('favorites.empty_title')} subtitle={t('favorites.empty_hint')} />;
  }

  return (
    <Screen tab>
      <FlatList
        data={ready ? items : NO_ITEMS}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={TAB_LIST_CONTENT}
        ListHeaderComponent={
          <View style={styles.header}>
            <ScreenTitle title={t('favorites.title')} />
            {isAuthed ? <ErrorBanner message={error} /> : null}
          </View>
        }
        ListEmptyComponent={empty}
        // Гостю и во время первой загрузки обновлять нечего.
        refreshControl={
          ready ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          ) : undefined
        }
      />
    </Screen>
  );
}

function guidOf(item: FavoriteItem): string {
  return item.type === 'provider' ? item.provider.guid : item.hall.guid;
}

const styles = StyleSheet.create({
  header: { gap: space.gap },
});
