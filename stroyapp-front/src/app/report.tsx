import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, complaintsApi, type ComplaintReason, type ComplaintTarget } from '@/api';
import { Button } from '@/components/Button';
import { Card, SectionLabel } from '@/components/Card';
import { ErrorBanner, useAnnounce } from '@/components/Feedback';
import { Field, Input } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { HIT, radius, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { showThen } from '@/utils/alert';
import { useOnTop } from '@/utils/nav';

/** Сервер отклоняет комментарий длиннее: лучше не дать набрать, чем вернуть ошибку. */
const COMMENT_MAX = 1000;
/** «Другое» без пояснения сервер не примет: разбирать такую жалобу не по чему. */
const OTHER_COMMENT_MIN = 5;

// Причины в порядке показа. Набор у каждого вида жалобы свой и повторяет
// серверный: причину не из набора сервер отклонит.
const REASONS: Record<ComplaintTarget, readonly ComplaintReason[]> = {
  hall: ['false_info', 'photos', 'fraud', 'offensive', 'spam', 'other'],
  provider: ['false_info', 'photos', 'fraud', 'offensive', 'spam', 'other'],
  review: ['offensive', 'spam', 'false_info', 'other'],
  chat: ['offensive', 'fraud', 'spam', 'other'],
};

// Ключи выписаны целиком, а не склеены: так их находит поиск по проекту.
const REASON_KEY: Record<ComplaintReason, string> = {
  false_info: 'report.reason_false_info',
  photos: 'report.reason_photos',
  fraud: 'report.reason_fraud',
  offensive: 'report.reason_offensive',
  spam: 'report.reason_spam',
  other: 'report.reason_other',
};

const ABOUT_KEY: Record<ComplaintTarget, string> = {
  hall: 'report.about_listing',
  provider: 'report.about_listing',
  review: 'report.about_review',
  chat: 'report.about_chat',
};

const isTarget = (value: string | undefined): value is ComplaintTarget =>
  value === 'hall' || value === 'provider' || value === 'review' || value === 'chat';

/**
 * Жалоба на объявление, отзыв или собеседника: причина из списка и, если
 * есть что добавить, комментарий.
 *
 * Открывается с карточки зала и исполнителя, из отзыва и из чата. На что
 * жалоба, приходит параметрами; название — только чтобы показать человеку,
 * что он не ошибся экраном.
 */
export default function ReportScreen() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { targetType, targetGuid, subjectName } = useLocalSearchParams<{
    targetType?: string;
    targetGuid?: string;
    subjectName?: string;
  }>();

  const [reason, setReason] = useState<ComplaintReason | null>(null);
  const [comment, setComment] = useState('');
  // Что не заполнено. Храним признак, а не готовый текст: текст зависит от
  // языка, а язык можно сменить, пока форма открыта.
  const [missing, setMissing] = useState<'reason' | 'comment' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  // Замок, а не только состояние: два быстрых нажатия успевают пройти до
  // перерисовки кнопки.
  const locked = useRef(false);
  // Сверху ли ещё форма: «Спасибо» не должно выскочить поверх другого экрана.
  const onTop = useOnTop();

  const reasonError = missing === 'reason' ? t('report.need_reason') : null;
  const commentError = missing === 'comment' ? t('report.need_comment') : null;
  // Ошибку причины диктору объявляем сами: у списка причин нет Field,
  // который делает это для полей.
  useAnnounce(reasonError);

  // Экран открыли по неполному адресу: жаловаться не на что. Параметр,
  // повторённый в адресе дважды, приходит списком — это тоже не адрес жалобы.
  if (!isTarget(targetType) || typeof targetGuid !== 'string' || !targetGuid) {
    return (
      <Screen scroll>
        <Stack.Screen options={{ headerShown: true, title: t('report.title') }} />
        <ErrorBanner message={t('common.error_generic')} />
      </Screen>
    );
  }

  const pickReason = (value: ComplaintReason) => {
    setReason(value);
    setMissing(null);
  };

  const submit = async () => {
    if (locked.current) return;
    const note = comment.trim();
    if (!reason) {
      setError(null);
      setMissing('reason');
      return;
    }
    if (reason === 'other' && note.length < OTHER_COMMENT_MIN) {
      setError(null);
      setMissing('comment');
      return;
    }

    locked.current = true;
    Keyboard.dismiss();
    setSubmitting(true);
    setError(null);
    setMissing(null);
    let already: boolean;
    try {
      ({ already } = await complaintsApi.create({
        target_type: targetType,
        target_guid: targetGuid,
        reason,
        comment: note || undefined,
      }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      setSubmitting(false);
      locked.current = false;
      return;
    }

    // Замок после успеха не снимаем: форма доживает последние секунды под
    // сообщением, и вторая отправка с неё не нужна.
    setSubmitting(false);
    setSent(true);
    if (!onTop.current) return;
    showThen(
      already ? t('report.already_title') : t('report.success_title'),
      already ? t('report.already_text') : t('report.success_text'),
      () => {
        if (onTop.current) router.back();
      },
    );
  };

  const editable = !submitting && !sent;

  return (
    <Screen
      scroll
      footer={
        // Ошибка у кнопки, как в остальных формах: под длинным комментарием
        // верх формы уезжает за экран.
        <View style={styles.footer}>
          <ErrorBanner message={error ?? reasonError ?? commentError} announce={!!error} />
          <Button label={t('report.submit')} onPress={submit} busy={submitting} disabled={sent} />
        </View>
      }
    >
      <Stack.Screen options={{ headerShown: true, title: t('report.title') }} />

      <View style={styles.head}>
        <Text style={styles.about}>{t(ABOUT_KEY[targetType])}</Text>
        {typeof subjectName === 'string' && subjectName ? (
          <Text style={styles.subject} numberOfLines={2}>
            {subjectName}
          </Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <SectionLabel>{t('report.reason_label')}</SectionLabel>
        {/* Свои строки, а не Row: причина — переключатель «один из», и диктору
            нужно сказать, какая выбрана. У Row роли только кнопка и ссылка. */}
        <View style={styles.reasons} accessibilityRole="radiogroup">
          {REASONS[targetType].map((code, i) => {
            const checked = reason === code;
            // У отзыва «недостоверно» звучит иначе, чем у объявления.
            const label =
              code === 'false_info' && targetType === 'review'
                ? t('report.reason_false_info_review')
                : t(REASON_KEY[code]);
            return (
              <Pressable
                key={code}
                onPress={() => pickReason(code)}
                disabled={!editable}
                accessibilityRole="radio"
                accessibilityState={{ checked, disabled: !editable }}
                accessibilityLabel={label}
                style={({ pressed }) => [styles.reason, i > 0 && styles.divided, pressed && styles.pressed]}
              >
                {/* Причина — весь смысл строки: при крупном шрифте пусть переносится, а не обрезается. */}
                <Text style={[styles.reasonText, checked && styles.reasonChosen]} numberOfLines={4}>
                  {label}
                </Text>
                {/* Значок — украшение: выбрана ли причина, диктору говорит состояние. */}
                <Icon
                  name={checked ? 'radiobox-marked' : 'radiobox-blank'}
                  size={22}
                  color={checked ? colors.primary : colors.outline}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                />
              </Pressable>
            );
          })}
        </View>
      </View>

      <Card>
        <Field
          label={reason === 'other' ? t('report.comment_label') : t('report.comment_label_optional')}
          hint={targetType === 'chat' ? t('report.chat_hint') : undefined}
          error={commentError}
        >
          <Input
            value={comment}
            onChangeText={(value) => {
              setComment(value);
              if (missing === 'comment') setMissing(null);
            }}
            placeholder={t('report.comment_placeholder')}
            // Подпись над полем — отдельный текст: без этого диктор называет
            // поле только по набранному.
            accessibilityLabel={t('report.comment_label')}
            multiline
            maxLength={COMMENT_MAX}
            editable={editable}
            invalid={!!commentError}
            style={styles.comment}
          />
        </Field>
      </Card>
    </Screen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    head: { gap: 2, paddingHorizontal: 4 },
    about: { fontSize: text.caption, color: colors.muted },
    subject: { fontSize: text.section, fontWeight: '600', color: colors.text },
    // Подпись раздела держится ближе к своему блоку, чем к предыдущему.
    section: { gap: 8 },
    reasons: { backgroundColor: colors.card, borderRadius: radius.card, overflow: 'hidden' },
    reason: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.gap,
      minHeight: HIT,
      paddingHorizontal: space.card,
      paddingVertical: 10,
    },
    divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    pressed: { backgroundColor: colors.background },
    reasonText: { flex: 1, minWidth: 0, fontSize: text.body, color: colors.text },
    reasonChosen: { fontWeight: '600' },
    comment: { minHeight: 120 },
    footer: { flex: 1, gap: 8 },
  });
