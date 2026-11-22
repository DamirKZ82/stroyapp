import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';

import { lightColors, radius, space } from '@/theme';

/** Сторона белого круга под сердцем. */
const SIZE = 44;

interface FavoriteHeartProps {
  isFavorite: boolean;
  onPress: () => void;
  /** Отступ от верхнего правого угла фото: в карточке списка 8, на экране зала и исполнителя 12. */
  inset?: number;
}

/**
 * Кнопка «в избранное» в белом круге поверх фото — на карточке в списке и
 * на экранах зала и исполнителя.
 *
 * Ставить соседом фото (галереи, нажимаемой карточки), а не ребёнком:
 * нажатие на сердце не должно открывать объявление или просмотр фото, а
 * кнопку внутри кнопки VoiceOver не находит — он читает внешнюю целиком.
 */
export function FavoriteHeart({ isFavorite, onPress, inset = space.gap }: FavoriteHeartProps) {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={isFavorite ? t('favorites.remove') : t('favorites.add')}
      accessibilityState={{ selected: isFavorite }}
      style={({ pressed }) => [styles.heart, { top: inset, right: inset }, pressed && styles.pressed]}
    >
      <Icon
        name={isFavorite ? 'heart' : 'heart-outline'}
        size={22}
        // Круг под сердцем белый в обеих темах, поэтому и красный берём
        // из светлой палитры: тёмный danger на белом слишком бледен.
        color={isFavorite ? lightColors.danger : '#000000'}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  heart: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    // Белый и в тёмной теме: круг лежит на фото, а не на карточке или фоне.
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
  pressed: { opacity: 0.6 },
});
