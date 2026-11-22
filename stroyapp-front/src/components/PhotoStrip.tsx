import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRef } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { FILL, radius, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';

export interface PhotoStripItem {
  /** Устойчивый ключ: по нему же экран узнаёт, что удалять. */
  key: string;
  /** Готовый адрес: photoUrl(thumb_path) для фото с сервера, локальный uri для выбранного. */
  uri: string;
  /** Выбрано, но ещё не на сервере — уйдёт при сохранении. */
  pending?: boolean;
}

export interface PhotoStripProps {
  photos: PhotoStripItem[];
  /** Сколько фото можно всего; при достижении плитка «добавить» пропадает. */
  limit: number;
  onAdd: () => void;
  onRemove: (key: string) => void;
  /** Нажатие на фото — открыть просмотр. Без него фото не нажимаются. */
  onOpen?: (index: number) => void;
  /** Идёт загрузка: на плитке «добавить» вертушка, нажать её нельзя. */
  busy?: boolean;
  /** Добавлять и удалять нельзя (форма сохраняется, объект ещё не создан). */
  disabled?: boolean;
  /** Строка под лентой вместо обычной «До 20 фото…». */
  hint?: string;
}

const TILE = 96;

/**
 * Лента фотографий в формах зала и исполнителя.
 *
 * Только показывает: выбор из галереи, загрузку и подтверждение удаления
 * делает экран — у зала фото уходят на сервер сразу, у исполнителя копятся
 * до сохранения, и общий компонент об этой разнице знать не должен.
 *
 * Плитка «добавить» стоит первой, а не последней: она остаётся на виду,
 * сколько бы фото ни набралось, и её не нужно искать прокруткой.
 */
export function PhotoStrip({
  photos,
  limit,
  onAdd,
  onRemove,
  onOpen,
  busy = false,
  disabled = false,
  hint,
}: PhotoStripProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  const full = photos.length >= limit;
  const addOff = disabled || busy;

  // Новые фото встают в конец ленты, а плитка «добавить» — в начале: без
  // прокрутки человек после выбора не видит, что что-то добавилось.
  // Считаем в onContentSizeChange, а не в useEffect: в эффекте ширина
  // содержимого ещё старая и scrollToEnd останавливается не доезжая.
  const scroller = useRef<ScrollView>(null);
  const shown = useRef(photos.length);
  const followNewPhotos = () => {
    if (photos.length > shown.current) scroller.current?.scrollToEnd({ animated: true });
    shown.current = photos.length;
  };

  return (
    <View style={styles.wrap}>
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        // Лента стоит внутри формы: без этого первое нажатие при открытой
        // клавиатуре только закрывает её, а плитка и крестик не срабатывают.
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={followNewPhotos}
        contentContainerStyle={styles.strip}
      >
        {full ? null : (
          <Pressable
            onPress={onAdd}
            disabled={addOff}
            accessibilityRole="button"
            accessibilityLabel={t('owner.add_photos')}
            accessibilityState={{ disabled: addOff, busy }}
            style={({ pressed }) => [
              styles.tile,
              styles.add,
              disabled && styles.off,
              pressed && styles.pressed,
            ]}
          >
            {busy ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Icon name="plus" size={28} color={colors.primary} />
            )}
            {/* Плитка не растёт вместе с шрифтом, поэтому увеличение ограничено:
                при крупном системном шрифте слово обрезалось бы посередине. */}
            <Text style={styles.addLabel} numberOfLines={2} maxFontSizeMultiplier={1.3}>
              {t('owner.add_photos')}
            </Text>
          </Pressable>
        )}

        {photos.map((photo, index) => {
          const label = photo.pending
            ? `${t('owner.photo_n', { n: index + 1 })}, ${t('owner.photo_pending')}`
            : t('owner.photo_n', { n: index + 1 });
          const picture = (
            <>
              <Image
                source={{ uri: photo.uri }}
                style={styles.image}
                contentFit="cover"
                transition={150}
              />
              {photo.pending ? (
                <View style={styles.pending}>
                  <Icon name="cloud-upload-outline" size={24} color="#FFFFFF" />
                </View>
              ) : null}
            </>
          );

          return (
            // Фото и крестик — соседи, а не вложены друг в друга: вложенную
            // кнопку VoiceOver не видит, и удалить фото с ним было бы нечем.
            <View key={photo.key} style={styles.tile}>
              {onOpen ? (
                <Pressable
                  onPress={() => onOpen(index)}
                  accessibilityRole="imagebutton"
                  accessibilityLabel={label}
                  style={({ pressed }) => [styles.fill, pressed && styles.pressed]}
                >
                  {picture}
                </Pressable>
              ) : (
                <View accessible accessibilityRole="image" accessibilityLabel={label} style={styles.fill}>
                  {picture}
                </View>
              )}
              <Pressable
                onPress={() => onRemove(photo.key)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={t('common.delete')}
                accessibilityState={{ disabled }}
                style={({ pressed }) => [styles.removeZone, (pressed || disabled) && styles.off]}
              >
                <View style={styles.remove}>
                  <Icon name="close" size={16} color="#FFFFFF" />
                </View>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>

      {photos.length === 0 ? <Text style={styles.note}>{t('owner.photos_empty')}</Text> : null}
      {/* На пределе обычная подсказка «До 20 фото…» повторяла бы строку о
          пределе, поэтому остаётся только своя, переданная экраном. */}
      {full ? <Text style={styles.note}>{t('owner.photos_limit', { limit })}</Text> : null}
      {full && !hint ? null : <Text style={styles.note}>{hint ?? t('owner.photos_hint')}</Text>}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: { gap: 6 },
    strip: { gap: 8 },
    tile: {
      width: TILE,
      height: TILE,
      borderRadius: radius.inner,
      overflow: 'hidden',
      // Виден, пока фото грузится, и под фото с прозрачностью.
      backgroundColor: colors.border,
    },
    fill: { flex: 1 },
    image: { width: '100%', height: '100%' },
    add: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      padding: 6,
      borderWidth: 1.5,
      borderStyle: 'dashed',
      borderColor: `${colors.primary}88`,
      backgroundColor: `${colors.primary}14`,
    },
    // 12 — подпись под иконкой; обычные 14 в плитку 96 не помещаются.
    addLabel: { fontSize: 12, fontWeight: '500', color: colors.primary, textAlign: 'center' },
    pending: {
      ...FILL,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.4)',
    },
    // Сам кружок 28, а нажимается зона 44 в углу плитки. hitSlop тут не
    // годится: на Android он не выходит за край родителя, а кружок стоит
    // вплотную к углу — попасть было бы можно только точно в него.
    removeZone: {
      position: 'absolute',
      top: 0,
      right: 0,
      width: 44,
      height: 44,
      alignItems: 'flex-end',
      padding: 4,
    },
    remove: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.6)',
    },
    off: { opacity: 0.5 },
    pressed: { opacity: 0.7 },
    note: { fontSize: 13, color: colors.muted },
  });
