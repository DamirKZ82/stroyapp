import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { Review } from '@/api/types';
import { radius, space, text, type ThemeColors } from '@/theme';
import { useThemedStyles } from '@/theme/scheme';
import { formatDateHuman } from '@/utils/format';
import { useLang } from '@/utils/lang';
import { Button } from './Button';
import { Card } from './Card';
import { StarRating } from './StarRating';

interface ReviewListProps {
  reviews: readonly Review[];
  /** Подпись над ответом: у зала «Ответ владельца:», у исполнителя — свой. */
  replyLabel: string;
  /** Что показать, когда отзывов нет. */
  emptyText: string;
  /** Пожаловаться на отзыв. Без него кнопки у отзывов нет. */
  onReport?: (review: Review) => void;
}

/**
 * Отзывы на карточке зала и исполнителя. Один компонент на оба экрана:
 * один и тот же отзыв не должен выглядеть у них по-разному.
 *
 * Свой контейнер вместо Card: у той отступы внутри, а разделители между
 * отзывами идут от края до края.
 */
export function ReviewList({ reviews, replyLabel, emptyText, onReport }: ReviewListProps) {
  const styles = useThemedStyles(makeStyles);

  if (reviews.length === 0) {
    return (
      <Card>
        <Text style={styles.empty}>{emptyText}</Text>
      </Card>
    );
  }

  return (
    <View style={styles.list}>
      {reviews.map((review, i) => (
        <ReviewItem
          key={review.id}
          review={review}
          replyLabel={replyLabel}
          first={i === 0}
          onReport={onReport}
        />
      ))}
    </View>
  );
}

function ReviewItem({
  review,
  replyLabel,
  first,
  onReport,
}: {
  review: Review;
  replyLabel: string;
  first: boolean;
  onReport?: (review: Review) => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const lang = useLang();

  return (
    <View style={[styles.review, !first && styles.divided]}>
      {/* Звёзды из набора — картинка без подписи; чтобы диктор не говорил
          просто «изображение», имя и оценку читаем одной строкой. Оценка
          словами, как в форме отзыва: «5/5» диктор читает дробью или датой. */}
      <View
        style={styles.head}
        accessible
        accessibilityLabel={`${review.client_name}, ${t('review_form.rating_value', { n: review.rating })}`}
      >
        <Text style={styles.name} numberOfLines={1}>
          {review.client_name}
        </Text>
        <StarRating value={review.rating} size={16} />
      </View>
      <Text style={styles.date}>{formatDateHuman(review.created_at.slice(0, 10), lang)}</Text>
      {review.text ? <Text style={styles.body}>{review.text}</Text> : null}
      {review.owner_reply ? (
        <View style={styles.reply}>
          <Text style={styles.replyLabel}>{replyLabel}</Text>
          <Text style={styles.replyText}>{review.owner_reply}</Text>
        </View>
      ) : null}
      {onReport ? (
        <Button
          label={t('report.link_short')}
          variant="text"
          small
          // Подпись у всех отзывов одна — диктору говорим, на чей отзыв жалоба.
          accessibilityLabel={t('report.link_review_a11y', { name: review.client_name })}
          onPress={() => onReport(review)}
          style={styles.report}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    empty: { fontSize: text.body, color: colors.muted },
    list: { backgroundColor: colors.card, borderRadius: radius.card, overflow: 'hidden' },
    review: { padding: space.card, gap: 4 },
    divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    head: { flexDirection: 'row', alignItems: 'center', gap: space.gap },
    name: { flex: 1, minWidth: 0, fontSize: text.body, fontWeight: '600', color: colors.text },
    date: { fontSize: text.caption, color: colors.muted },
    body: { fontSize: text.body, lineHeight: 22, color: colors.text, marginTop: 4 },
    reply: {
      marginTop: 8,
      padding: 12,
      gap: 2,
      borderRadius: radius.inner,
      // Ответ — вложенный блок: фон экрана внутри карточки.
      backgroundColor: colors.background,
    },
    replyLabel: { fontSize: text.caption, fontWeight: '600', color: colors.muted },
    replyText: { fontSize: text.body, color: colors.text },
    // У правого края и вплотную к нему: действие редкое и не должно спорить
    // с текстом отзыва. Отрицательный отступ съедает поля самой кнопки.
    report: { alignSelf: 'flex-end', marginRight: -8, marginBottom: -8 },
  });
