import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { FILL, radius, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { photoUrl } from '@/utils/photo';
import { FavoriteHeart } from './FavoriteHeart';
import { RatingInline, ratingLabel } from './RatingInline';

export interface ListingBadge {
  label: string;
  /** Занято — тёмная плашка, свободно — акцентная. */
  busy: boolean;
}

export interface ListingCardProps {
  /** Путь главного фото с сервера; пусто — заглушка. */
  photo: string | null | undefined;
  /** Путь превью: показывается, пока грузится большое фото. */
  thumb?: string | null;
  title: string;
  /** Вторая строка: «категория · город». */
  subtitle: string;
  rating?: { avg: number; count: number } | null;
  /** Значок «Проверенный» после названия: админ сверил БИН/ИИН и оплачен Pro. */
  verified?: boolean;
  /** Плашка занятости поверх фото; null — поиск без даты, плашки нет. */
  badge?: ListingBadge | null;
  /** Готовая строка цены. Пусто — цены нет, priceHint идёт вместо неё. */
  price?: string | null;
  /** Пояснение под ценой: «от · за м²». */
  priceHint?: string | null;
  /**
   * Строки под ценой: позиции прайса, совпавшие с поиском
   * («Газоблок 600×300 — 650 ₸ за шт»).
   */
  extraLines?: string[];
  onPress: () => void;
  /** Без него сердца нет вовсе. */
  onToggleFavorite?: () => void;
  isFavorite?: boolean;
}

/**
 * Карточка объявления в поиске и избранном — основа ProviderCard.
 * Сама про магазины и бригады не знает: получает готовые
 * строки, а что в них написано, решает обёртка.
 *
 * Сердце — сосед карточки, а не её ребёнок. Вложенная кнопка внутри кнопки
 * недоступна VoiceOver (он читает внешнюю как один элемент), а так ещё и
 * нажатие на сердце заведомо не открывает объявление.
 */
export function ListingCard({
  photo,
  thumb,
  title,
  subtitle,
  rating,
  verified = false,
  badge,
  price,
  priceHint,
  extraLines,
  onPress,
  onToggleFavorite,
  isFavorite = false,
}: ListingCardProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  const uri = photoUrl(photo);
  const thumbUri = photoUrl(thumb);
  const hasRating = !!rating && rating.count > 0;

  // Подпись собрана явно, а не из детей: иначе диктор читает символы шрифта
  // (заглушка, звезда) непонятными знаками, а «4,8 (12)» — без слова, что это
  // отзывы. Название первым: по нему ищут нужное, листая список.
  const a11yLabel = [
    title,
    verified ? t('provider.verified') : null,
    hasRating ? ratingLabel(t, rating.avg, rating.count) : null,
    subtitle,
    badge?.label,
    price,
    priceHint,
    ...(extraLines ?? []),
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View style={styles.card}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        style={({ pressed }) => pressed && styles.pressed}
      >
        <View style={styles.photo}>
          {/* Заглушка лежит под фото всегда: её видно, пока фото грузится
              и если оно не загрузилось, — без своего состояния ошибки. */}
          <Icon name="image-outline" size={40} color={colors.muted} />
          {uri ? (
            <Image
              source={{ uri }}
              // Большое фото весит сотни килобайт, превью — десятки: на
              // мобильной сети карточка не стоит пустой.
              placeholder={thumbUri ? { uri: thumbUri } : null}
              // По умолчанию у заглушки scale-down, и при смене на фото
              // картинка дёргается.
              placeholderContentFit="cover"
              contentFit="cover"
              transition={150}
              style={FILL}
            />
          ) : null}
          {badge ? (
            <View style={[styles.badge, badge.busy ? styles.badgeBusy : styles.badgeFree]}>
              <Text
                style={[styles.badgeText, badge.busy ? styles.badgeTextBusy : styles.badgeTextFree]}
                numberOfLines={1}
              >
                {badge.label}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={styles.body}>
          <View style={styles.head}>
            {/* Значок вплотную к названию: он про него, а не про рейтинг. */}
            <View style={styles.titleRow}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {verified ? (
                <Icon
                  name="check-decagram"
                  size={18}
                  color={colors.success}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                />
              ) : null}
            </View>
            {hasRating ? (
              <RatingInline
                avg={rating.avg}
                count={rating.count}
                style={styles.rating}
                accessible={false}
              />
            ) : null}
          </View>
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>

          <View style={styles.priceBlock}>
            {price ? (
              <Text style={styles.price} numberOfLines={1}>
                {price}
              </Text>
            ) : null}
            {priceHint ? (
              <Text style={price ? styles.priceHint : styles.noPrice} numberOfLines={1}>
                {priceHint}
              </Text>
            ) : null}
          </View>
          {extraLines && extraLines.length > 0 ? (
            <View style={styles.extra}>
              {extraLines.map((line, i) => (
                <Text key={i} style={styles.extraLine} numberOfLines={1}>
                  {line}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      </Pressable>

      {onToggleFavorite ? (
        <FavoriteHeart isFavorite={isFavorite} onPress={onToggleFavorite} inset={8} />
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // overflow нужен, чтобы фото обрезалось по скруглению карточки.
    card: { backgroundColor: colors.card, borderRadius: radius.card, overflow: 'hidden' },
    pressed: { opacity: 0.7 },
    photo: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badge: {
      position: 'absolute',
      top: 12,
      left: 12,
      // Справа стоит сердце: длинная плашка не должна под него заезжать.
      maxWidth: '65%',
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: radius.pill,
    },
    badgeFree: { backgroundColor: colors.accent },
    // Чёрный, а не цвет темы: плашка лежит на фотографии, и читаться ей
    // надо на любой картинке в обеих темах.
    badgeBusy: { backgroundColor: 'rgba(0,0,0,0.65)' },
    badgeText: { fontSize: 12, fontWeight: '600' },
    badgeTextFree: { color: colors.onAccent },
    badgeTextBusy: { color: '#FFFFFF' },
    body: { padding: space.card, gap: 2 },
    head: { flexDirection: 'row', alignItems: 'center', gap: space.gap },
    titleRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
    title: { flexShrink: 1, minWidth: 0, fontSize: text.subtitle, fontWeight: '600', color: colors.text },
    rating: { flexShrink: 0 },
    subtitle: { fontSize: text.caption, color: colors.muted },
    priceBlock: { marginTop: 8, gap: 2 },
    price: { fontSize: text.subtitle, fontWeight: '700', color: colors.primary },
    priceHint: { fontSize: text.caption, color: colors.muted },
    noPrice: { fontSize: text.body, fontWeight: '500', color: colors.muted },
    extra: {
      marginTop: 8,
      paddingTop: 8,
      gap: 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    extraLine: { fontSize: text.caption, color: colors.text },
  });
