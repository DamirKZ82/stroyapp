import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Keyboard, Platform, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { ApiError, reviewsApi } from '@/api';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ErrorBanner } from '@/components/Feedback';
import { Field, Input } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { StarRating } from '@/components/StarRating';
import { text, type ThemeColors } from '@/theme';
import { useThemedStyles } from '@/theme/scheme';
import { showThen } from '@/utils/alert';
import { useOnTop } from '@/utils/nav';

/** Сервер отклоняет отзыв длиннее: лучше не дать набрать, чем вернуть ошибку. */
const COMMENT_MAX = 2000;

// Двойное касание диктора по регулятору оценки должно ничего не делать. Если
// элемент его не принял, система подменяет его касанием по центру, а там
// третья звезда: оценка молча становилась 3. На Android его принимает
// 'activate' (onRatingAction его пропускает), на iOS — onAccessibilityTap.
// 'activate' там не добавляем: Fabric показал бы его в ротаторе лишним
// действием с английским названием.
// У increment / decrement — подписи: Fabric на iOS показывает каждое действие
// в ротаторе «Действия» под его label, а без него — английским именем.
const ratingActions = (t: TFunction) => {
  const adjust = [
    { name: 'increment', label: t('review_form.rating_more') },
    { name: 'decrement', label: t('review_form.rating_less') },
  ];
  return Platform.OS === 'android' ? [...adjust, { name: 'activate' }] : adjust;
};
const ignoreTap = () => {};

/**
 * Отзыв по состоявшейся заявке: оценка обязательна, текст — нет.
 *
 * Открывается из «Моих заявок»; название зала или исполнителя приходит
 * параметром, отдельного запроса за ним нет.
 */
export default function ReviewFormScreen() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { bookingGuid, subjectName } = useLocalSearchParams<{
    bookingGuid: string;
    subjectName?: string;
  }>();

  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [needRating, setNeedRating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  // Замок, а не только состояние: два быстрых нажатия успевают пройти до
  // перерисовки кнопки, и второй запрос вернул бы «Отзыв уже оставлен»
  // поверх успешно отправленного первого.
  const locked = useRef(false);

  // Сверху ли ещё форма. Человек может уйти назад, не дождавшись ответа, или
  // поверх откроется другой экран: тогда сообщение об успехе выскочило бы
  // поверх чужого экрана, а «ОК» в нём закрыл бы уже его.
  const onTop = useOnTop();

  const pickRating = (value: number) => {
    setRating(value);
    setNeedRating(false);
  };

  // Экранный диктор меняет оценку жестом «больше / меньше». Ниже единицы не
  // опускаем: снять оценку нельзя и нажатием на звёзды.
  const onRatingAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'increment') pickRating(Math.min(5, rating + 1));
    if (event.nativeEvent.actionName === 'decrement') pickRating(Math.max(1, rating - 1));
  };

  const submit = async () => {
    if (locked.current) return;
    if (rating < 1) {
      setError(null);
      setNeedRating(true);
      return;
    }

    locked.current = true;
    Keyboard.dismiss();
    setSubmitting(true);
    setError(null);
    try {
      await reviewsApi.create(bookingGuid, rating, comment.trim() || undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      setSubmitting(false);
      locked.current = false;
      return;
    }

    // Замок после успеха не снимаем: форма доживает последние секунды под
    // сообщением, и повторная отправка с неё не нужна — второй раз сервер
    // ответил бы «Отзыв уже оставлен».
    setSubmitting(false);
    setSent(true);
    // Форму закрыли или накрыли другим экраном, пока шёл запрос: отзыв
    // принят, а «Спасибо» поверх чужого экрана ни к чему — так же молчат и
    // формы владельца. Погашенную форму закрывают кнопкой «Назад» в шапке.
    if (!onTop.current) return;
    showThen(t('review_form.success'), undefined, () => {
      if (onTop.current) router.back();
    });
  };

  const ratingError = needRating ? t('review_form.need_rating') : null;

  return (
    <Screen
      scroll
      footer={
        // Ошибка у кнопки, как в формах владельца: под длинным комментарием
        // верх формы уезжает за экран, и полосу над звёздами после нажатия
        // не видно — казалось бы, что кнопка не сработала.
        <View style={styles.footer}>
          {/* Ошибку оценки диктору уже проговорил её Field — полоса лишь
              показывает её зрячим и второй раз не объявляет. */}
          <ErrorBanner message={error ?? ratingError} announce={!!error} />
          <Button
            label={t('review_form.submit')}
            onPress={submit}
            busy={submitting}
            disabled={sent}
          />
        </View>
      }
    >
      <Stack.Screen options={{ headerShown: true, title: t('review_form.title') }} />

      {subjectName ? (
        <Text style={styles.subject} numberOfLines={2}>
          {subjectName}
        </Text>
      ) : null}

      <Card>
        <Field label={t('review_form.rating_label')} error={ratingError}>
          {/* Обёртка — один регулятор для экранного диктора: с названием поля
              и текущей оценкой, меняется жестом вверх-вниз. Звёзды в
              StarRating — радиокнопки «n из 5» с отметкой, но без названия
              поля, и перебирать их пришлось бы по одной. */}
          <View
            style={styles.stars}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={t('review_form.rating_label')}
            aria-valuemin={0}
            aria-valuemax={5}
            aria-valuenow={rating}
            // Без текста iOS читает значение процентами от диапазона: «20%»
            // вместо «1 из 5». Словами, а не «1 / 5», как у звёзд: косую
            // черту диктор читает как дробь или знак. aria-, а не
            // accessibilityValue: тот веб не понимает.
            aria-valuetext={t('review_form.rating_value', { n: rating })}
            accessibilityActions={ratingActions(t)}
            onAccessibilityAction={onRatingAction}
            onAccessibilityTap={ignoreTap}
          >
            {/* На Android accessible-родитель не прячет нажимаемых детей, и
                TalkBack заходил бы ещё и на каждую звезду. iOS этот проп
                не читает: там детей уже спрятал accessible. */}
            <View importantForAccessibility="no-hide-descendants">
              <StarRating value={rating} onChange={pickRating} size={36} />
            </View>
          </View>
        </Field>

        <Field label={t('review_form.text_label')}>
          <Input
            value={comment}
            onChangeText={setComment}
            placeholder={t('review_form.text_placeholder')}
            // Подпись над полем — отдельный текст: без этого диктор называет
            // поле только по набранному, без слова «Комментарий».
            accessibilityLabel={t('review_form.text_label')}
            multiline
            maxLength={COMMENT_MAX}
            editable={!submitting && !sent}
            style={styles.comment}
          />
        </Field>
      </Card>
    </Screen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    subject: {
      fontSize: text.section,
      fontWeight: '600',
      color: colors.text,
      paddingHorizontal: 4,
    },
    // По ширине звёзд, а не всей строки: иначе рамка фокуса диктора и
    // область жеста тянутся на пустое место справа.
    stars: { alignSelf: 'flex-start' },
    comment: { minHeight: 120 },
    footer: { flex: 1, gap: 8 },
  });
