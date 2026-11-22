import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radius, space, text } from '@/theme';

interface PhotoViewerProps {
  visible: boolean;
  /**
   * Готовые адреса картинок. Не пути с сервера: в форме исполнителя сюда
   * попадают и ещё не загруженные фото с телефона (file://), поэтому
   * photoUrl() зовёт тот, кто открывает просмотр.
   */
  uris: string[];
  initialIndex?: number;
  onClose: () => void;
}

/**
 * Просмотр фото на весь экран с листанием.
 *
 * Чёрный и белый здесь литералами намеренно: это слой поверх фотографий,
 * он одинаков в светлой и тёмной теме.
 */
export function PhotoViewer({ visible, uris, initialIndex = 0, onClose }: PhotoViewerProps) {
  if (!uris.length) return null;

  return (
    <Modal
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      {/* Содержимое отдельным компонентом: Modal размонтирует детей, когда
          скрыт, и каждое открытие начинается с нужного фото и своего счётчика
          без ручного сброса состояния. */}
      <ViewerBody uris={uris} initialIndex={initialIndex} onClose={onClose} />
    </Modal>
  );
}

interface Size {
  width: number;
  height: number;
}

function ViewerBody({ uris, initialIndex, onClose }: Required<Omit<PhotoViewerProps, 'visible'>>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const last = uris.length - 1;
  // Стартовое фото запоминаем один раз, при открытии. На iOS содержимое
  // живёт ещё и всё время анимации закрытия, а галерея к этому моменту уже
  // передаёт initialIndex = 0: с «живым» значением список получал бы новый
  // initialScrollIndex и подгружал первое фото под уходящим окном.
  const [start] = useState(() => Math.min(Math.max(initialIndex, 0), last));

  const [index, setIndex] = useState(start);
  // Размер берём из вёрстки, а не из окна: высота окна на Android то
  // включает строку состояния и панель навигации, то нет, и фото вставало
  // со сдвигом. Пока размера нет, список не рисуем — иначе initialScrollIndex
  // посчитается от чужой ширины.
  const [size, setSize] = useState<Size | null>(null);
  const listRef = useRef<FlatList<string>>(null);
  const indexRef = useRef(start);
  const width = size?.width ?? 0;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setSize((prev) => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }));
  }, []);

  // Ширина сменилась при открытом просмотре (раскрыли складной телефон,
  // разделили экран): страницы стали другой ширины, а смещение осталось
  // старым — возвращаем список на то же фото. Первое измерение пропускаем:
  // там список встаёт на место сам, через initialScrollIndex.
  const prevWidth = useRef(0);
  useEffect(() => {
    if (prevWidth.current > 0 && width > 0 && prevWidth.current !== width) {
      listRef.current?.scrollToOffset({ offset: indexRef.current * width, animated: false });
    }
    prevWidth.current = width;
  }, [width]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (width <= 0) return;
      const next = Math.min(Math.max(Math.round(e.nativeEvent.contentOffset.x / width), 0), last);
      indexRef.current = next;
      setIndex(next);
    },
    [width, last],
  );

  const getItemLayout = useCallback(
    (_: ArrayLike<string> | null | undefined, i: number) => ({ length: width, offset: width * i, index: i }),
    [width],
  );

  const keyExtractor = useCallback((uri: string, i: number) => `${i}-${uri}`, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<string>) => (
      // Тап по фото закрывает — привычный жест, но для экранного диктора это
      // была бы безымянная кнопка на каждой странице; ему хватает крестика.
      <Pressable style={size} onPress={onClose} accessible={false}>
        <Image source={{ uri: item }} style={styles.image} contentFit="contain" transition={150} />
      </Pressable>
    ),
    [size, onClose],
  );

  const shown = Math.min(index, last);

  return (
    <View style={styles.root} onLayout={onLayout}>
      {/* В светлой теме значки строки состояния тёмные и на чёрном пропадают. */}
      <StatusBar style="light" />

      {size ? (
        <FlatList
          ref={listRef}
          data={uris}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={start}
          getItemLayout={getItemLayout}
          onScroll={onScroll}
          scrollEventThrottle={16}
          // Фото полного размера тяжёлые: держим в памяти только соседние.
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          windowSize={3}
        />
      ) : null}

      {uris.length > 1 ? (
        <View style={[styles.counterRow, { top: insets.top + 8 }]} pointerEvents="none">
          <View style={styles.counter}>
            <Text style={styles.counterText}>{`${shown + 1} / ${uris.length}`}</Text>
          </View>
        </View>
      ) : null}

      <Pressable
        onPress={onClose}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        style={({ pressed }) => [styles.close, { top: insets.top + 8 }, pressed && styles.pressed]}
      >
        <Icon name="close" size={26} color="#FFFFFF" />
      </Pressable>
    </View>
  );
}

/** Сторона круглой кнопки закрытия; счётчик выравнивается по ней же. */
const CLOSE = 44;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  image: { flex: 1 },
  counterRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: CLOSE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  counter: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  // tabular-nums: иначе при листании «1 / 12» → «2 / 12» плашка дёргается.
  counterText: { fontSize: text.caption, fontWeight: '600', color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  close: {
    position: 'absolute',
    right: space.page,
    width: CLOSE,
    height: CLOSE,
    borderRadius: CLOSE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  pressed: { opacity: 0.7 },
});
