import { useEffect } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { space } from '@/theme';
import { monthOf } from '@/utils/format';
import { serverToday } from '@/utils/serverTime';
import { Button } from './Button';
import { CalendarLegend, MonthCalendar, type CalendarDay } from './MonthCalendar';
import { Sheet } from './Sheet';

interface DatePickerSheetProps {
  visible: boolean;
  /** Выбранный день, YYYY-MM-DD. */
  value: string | null;
  /**
   * Нажали на день или «Сбросить» (null). Сам выбор шторку не закрывает:
   * её закрывают «Готово», крестик или нажатие мимо — через onClose.
   */
  onChange: (date: string | null) => void;
  onClose: () => void;
  /** Занятость по дням. Без неё — простой выбор даты, как в поиске. */
  calendar?: CalendarDay[];
  /** По умолчанию — «Выберите дату». */
  title?: string;
  /**
   * Показанный месяц, YYYY-MM: родитель догружает его занятость. Приходит
   * при открытии шторки и при каждом перелистывании.
   */
  onMonthChange?: (month: string) => void;
}

/** Шторка выбора даты: месяц с занятостью, «Сбросить» и «Готово». */
export function DatePickerSheet({
  visible,
  onClose,
  title,
  ...body
}: DatePickerSheetProps) {
  const { t } = useTranslation();
  return (
    <Sheet visible={visible} onClose={onClose} title={title ?? t('date_picker.title')}>
      <DatePickerBody onClose={onClose} {...body} />
    </Sheet>
  );
}

type BodyProps = Omit<DatePickerSheetProps, 'visible' | 'title'>;

/**
 * Содержимое вынесено в свой компонент ради момента монтирования: Modal
 * держит детей только пока шторка на экране, так что тело создаётся заново
 * ровно тогда же, когда календарь заново встаёт на свой первый месяц.
 */
function DatePickerBody({
  value,
  onChange,
  onClose,
  calendar,
  onMonthChange,
}: BodyProps) {
  const { t } = useTranslation();

  // Календарь открывается на месяце выбранного дня (или на текущем) и сам
  // сообщает месяц только при перелистывании. Без этого вызова родитель не
  // знает, что показано сразу: дата, пришедшая с прошлого экрана, может быть
  // через три месяца, а занятость загружена лишь за текущий.
  // «Текущий» — по поясу сервера, как и в самом календаре: по часам телефона
  // в другом поясе на стыке месяцев запросили бы не тот месяц, что на экране.
  // Зависимостей нет намеренно — нужен именно момент открытия.
  useEffect(() => {
    onMonthChange?.(monthOf(value ?? serverToday()));
  }, []);

  return (
    <>
      {/* На низком экране шесть недель с подписями не влезают в шторку —
          тогда календарь прокручивается, а кнопки остаются на месте. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        alwaysBounceVertical={false}
        showsVerticalScrollIndicator={false}
      >
        {/* Высота месяца постоянна (всегда шесть недель), так что шторка
            при перелистывании не прыгает и запас по высоте ей не нужен. */}
        <MonthCalendar
          value={value}
          onSelect={(date) => onChange(date)}
          days={calendar}
          onMonthChange={onMonthChange}
        />
        {calendar ? (
          <CalendarLegend
            items={[
              { tone: 'busy', label: t('date_picker.legend_busy') },
              { tone: 'waiting', label: t('date_picker.legend_pending') },
            ]}
          />
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        {value ? (
          <Button label={t('common.reset')} variant="text" onPress={() => onChange(null)} />
        ) : null}
        <Button label={t('common.done')} onPress={onClose} disabled={!value} style={styles.done} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // flexGrow: 0 — по высоте содержимого; сжимается, когда шторка упёрлась
  // в свой предел.
  scroll: { flexGrow: 0 },
  content: { gap: space.gap },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.gap },
  done: { flex: 1 },
});
