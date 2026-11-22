import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import type { HallPhoto } from '@/api/types';
import { radius, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { photoUrl } from '@/utils/photo';
import { PhotoViewer } from './PhotoViewer';

/** Высота фото от ширины: кадр 16:10. */
const RATIO = 10 / 16;

interface Slide {
  id: number;
  uri: string;
  thumb: string | null;
}

/**
 * Фото зала или исполнителя: листаются вбок, по нажатию открываются на
 * весь экран.
 *
 * Ширину берём из вёрстки: галерея занимает всю ширину своего родителя,
 * а он не обязан быть шириной в экран (отступы экрана, планшет, разделённый
 * экран). Ширина окна — только догадка для первого кадра, чтобы фото не
 * появлялось с опозданием на кадр.
 */
export function PhotoGallery({ photos }: { photos: HallPhoto[] }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const window = useWindowDimensions();

  const [measured, setMeasured] = useState<number | null>(null);
  const width = measured ?? window.width;
  const [index, setIndex] = useState(0);
  /** С какого фото открыт просмотр; null — закрыт. */
  const [opened, setOpened] = useState<number | null>(null);
  const listRef = useRef<FlatList<Slide>>(null);
  const indexRef = useRef(0);

  const slides = useMemo(() => {
    const list: Slide[] = [];
    for (const photo of photos) {
      const uri = photoUrl(photo.file_path);
      if (uri) list.push({ id: photo.id, uri, thumb: photoUrl(photo.thumb_path) });
    }
    return list;
  }, [photos]);
  const uris = useMemo(() => slides.map((slide) => slide.uri), [slides]);
  const last = slides.length - 1;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setMeasured(e.nativeEvent.layout.width);
  }, []);

  // Ширина сменилась (раскрыли складной телефон, разделили экран): страницы
  // стали другой ширины, а смещение осталось старым, и в кадре оказались бы
  // половины двух фото. Возвращаем список на то же фото.
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: indexRef.current * width, animated: false });
  }, [width]);

  // Точку переключаем по ходу листания, а не по onMomentumScrollEnd: тот на
  // Android приходит не всегда, и точка отставала от фото.
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (width <= 0) return;
      const next = Math.min(Math.max(Math.round(e.nativeEvent.contentOffset.x / width), 0), Math.max(last, 0));
      indexRef.current = next;
      setIndex(next);
    },
    [width, last],
  );

  const getItemLayout = useCallback(
    (_: ArrayLike<Slide> | null | undefined, i: number) => ({ length: width, offset: width * i, index: i }),
    [width],
  );

  const keyExtractor = useCallback((slide: Slide) => String(slide.id), []);

  const total = slides.length;
  const renderItem = useCallback(
    ({ item, index: i }: ListRenderItemInfo<Slide>) => (
      // Отклика на нажатие нет намеренно: «нажато» срабатывает и в начале
      // каждого листания, фото мигало бы при любом свайпе.
      <Pressable
        onPress={() => setOpened(i)}
        accessibilityRole="imagebutton"
        accessibilityLabel={t('gallery.photo_of', { n: i + 1, total })}
      >
        <Image
          source={{ uri: item.uri }}
          // Миниатюра обычно уже в кэше после карточки в списке — показываем
          // её, пока грузится полное фото.
          placeholder={item.thumb ? { uri: item.thumb } : null}
          placeholderContentFit="cover"
          contentFit="cover"
          transition={150}
          style={[styles.photo, { width, height: width * RATIO }]}
        />
      </Pressable>
    ),
    [styles, width, total, t],
  );

  if (!total) {
    return (
      // Без подписи диктор пропустил бы заглушку или прочёл символ шрифта
      // значка — а «фото нет» человеку тоже надо знать.
      <View
        style={styles.empty}
        accessible
        accessibilityRole="image"
        accessibilityLabel={t('owner.photos_empty')}
      >
        <Icon
          name="image-off-outline"
          size={40}
          color={colors.muted}
          accessible={false}
          importantForAccessibility="no"
        />
      </View>
    );
  }

  const shown = Math.min(index, last);

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      <FlatList
        ref={listRef}
        data={slides}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        getItemLayout={getItemLayout}
        onScroll={onScroll}
        scrollEventThrottle={16}
        // Фото полного размера тяжёлые: держим в памяти только соседние.
        initialNumToRender={1}
        maxToRenderPerBatch={2}
        windowSize={3}
      />

      {total > 1 ? (
        // Точки не нажимаются и не читаются диктором: номер фото уже есть
        // в подписи самой картинки.
        <View
          style={styles.dotsRow}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <View style={styles.dots}>
            {slides.map((slide, i) => (
              <View key={slide.id} style={[styles.dot, i === shown && styles.dotActive]} />
            ))}
          </View>
        </View>
      ) : null}

      <PhotoViewer
        visible={opened !== null}
        uris={uris}
        initialIndex={opened ?? 0}
        onClose={() => setOpened(null)}
      />
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: { alignSelf: 'stretch' },
    // Фон виден, пока фото грузится, и у заглушки «фото нет».
    photo: { backgroundColor: colors.border },
    empty: {
      alignSelf: 'stretch',
      aspectRatio: 16 / 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.border,
    },
    dotsRow: { position: 'absolute', left: 0, right: 0, bottom: 10, alignItems: 'center' },
    // Белые точки на тёмной подложке — литералами: они лежат поверх фото и
    // должны читаться и на светлом кадре, в любой теме.
    dots: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRadius: radius.pill,
      backgroundColor: 'rgba(0,0,0,0.35)',
    },
    dot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.55)' },
    dotActive: { width: 18, backgroundColor: '#FFFFFF' },
  });
