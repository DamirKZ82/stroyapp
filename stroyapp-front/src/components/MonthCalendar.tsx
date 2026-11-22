import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { CalendarDay } from '@/api/types';
import { radius, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { formatDateHuman } from '@/utils/format';
import { useLang } from '@/utils/lang';
import { serverToday } from '@/utils/serverTime';

type DayStatus = CalendarDay['status'];

interface MonthCalendarProps {
  /** Выбранный день, YYYY-MM-DD. */
  value?: string | null;
  /** Нажатие на доступный день. */
  onSelect: (date: string, status: DayStatus | undefined) => void;
  /** Занятость по дням показанного месяца (с сервера). */
  days?: CalendarDay[];
  /** Сообщает показанный месяц (YYYY-MM): родитель догружает его занятость. */
  onMonthChange?: (month: string) => void;
  /** Дни раньше этого недоступны. По умолчанию — сегодня по поясу сервера. */
  minDate?: string;
  /**
   * Какие дни нельзя нажать. По умолчанию — подтверждённые: клиент не может
   * бронировать занятый день. Владелец в своём календаре, наоборот, жмёт
   * именно занятые — он передаёт свою функцию.
   */
  isDisabled?: (date: string, status: DayStatus | undefined) => boolean;
  /**
   * Как назвать занятость дня экранному диктору. По умолчанию — слова
   * клиентской легенды («Занято», «Ждёт ответа»); владелец передаёт подписи
   * своей, чтобы диктор говорил то же, что написано под календарём.
   */
  statusLabels?: { busy?: string; waiting?: string };
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * Месяц с отметками занятости.
 *
 * Свой, а не системный: ни один системный выбор даты не умеет красить и
 * отключать отдельные дни. Неделя с понедельника; названия месяцев и дней
 * берутся из переводов, так что календарь бывает и казахским.
 */
export function MonthCalendar({
  value,
  onSelect,
  days,
  onMonthChange,
  minDate,
  isDisabled,
  statusLabels,
}: MonthCalendarProps) {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  // «Сегодня» — по поясу сервера, а не по часам телефона: прошедший день
  // отклоняет сервер, и с телефоном в другом поясе календарь иначе разрешал
  // бы день, которого у сервера уже нет, или гасил бы его сегодняшний.
  const today = serverToday();
  const min = minDate ?? today;

  // Открываемся на месяце выбранного дня, иначе — на текущем.
  const start = value ?? today;
  const [year, setYear] = useState(Number(start.slice(0, 4)));
  const [month, setMonth] = useState(Number(start.slice(5, 7)));

  const statusByDate = useMemo(() => {
    const map: Record<string, DayStatus> = {};
    for (const day of days ?? []) map[day.date] = day.status;
    return map;
  }, [days]);

  const move = (delta: number) => {
    const next = new Date(year, month - 1 + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth() + 1);
    onMonthChange?.(`${next.getFullYear()}-${pad(next.getMonth() + 1)}`);
  };

  // Назад дальше месяца с минимальной датой листать некуда.
  const canGoBack = `${year}-${pad(month)}` > min.slice(0, 7);

  const cells = useMemo(() => {
    const first = new Date(year, month - 1, 1);
    const lead = (first.getDay() + 6) % 7; // понедельник — первый
    const count = new Date(year, month, 0).getDate();
    const list: (number | null)[] = Array(lead).fill(null);
    for (let d = 1; d <= count; d += 1) list.push(d);
    // Всегда шесть недель: иначе высота меняется от месяца к месяцу, и в
    // шторке стрелки листания уезжают из-под пальца.
    while (list.length < 42) list.push(null);
    return list;
  }, [year, month]);

  const months = t('calendar.months', { returnObjects: true }) as string[];
  const weekdays = t('calendar.weekdays', { returnObjects: true }) as string[];
  const busyLabel = statusLabels?.busy ?? t('date_picker.legend_busy');
  const waitingLabel = statusLabels?.waiting ?? t('date_picker.legend_pending');

  return (
    <View>
      <View style={styles.head}>
        <Pressable
          onPress={() => move(-1)}
          disabled={!canGoBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('calendar.prev_month')}
          style={[styles.arrow, !canGoBack && styles.hidden]}
        >
          <Icon name="chevron-left" size={26} color={colors.primary} />
        </Pressable>
        {/* В одну строку: длинный месяц при крупном шрифте иначе переносился
            бы, и шапка меняла высоту от месяца к месяцу. Нижний предел
            уменьшения действует только на iOS: Android читает лишь
            minimumFontSize, а его <Text> в RN 0.86 не передаёт, — там
            название уменьшается, пока не влезет целиком, без многоточия. */}
        <Text style={styles.month} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {months[month - 1]} {year}
        </Text>
        <Pressable
          onPress={() => move(1)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('calendar.next_month')}
          style={styles.arrow}
        >
          <Icon name="chevron-right" size={26} color={colors.primary} />
        </Pressable>
      </View>

      <View style={styles.week}>
        {weekdays.map((name) => (
          <Text key={name} style={styles.weekday}>
            {name}
          </Text>
        ))}
      </View>

      <View style={styles.grid}>
        {cells.map((day, index) => {
          if (day === null) {
            // Пустой клетке — тот же квадрат дня: без высоты последняя
            // пустая неделя схлопывалась, и шесть недель на деле были пятью.
            return (
              <View key={`gap-${index}`} style={styles.cell}>
                <View style={styles.day} />
              </View>
            );
          }
          const date = iso(year, month, day);
          const status = statusByDate[date];
          const past = date < min || status === 'past';
          const blocked = isDisabled ? isDisabled(date, status) : status === 'confirmed';
          const off = past || blocked;
          const chosen = date === value;
          const busy = status === 'confirmed';
          const waiting = status === 'pending';
          // Без подписи диктор читал бы голое число: ни месяца, ни того,
          // занят ли день — занятость была видна только по цвету.
          const stateLabel = busy ? busyLabel : waiting ? waitingLabel : null;
          const label = [formatDateHuman(date, lang), stateLabel].filter(Boolean).join(', ');

          return (
            // Нажимается вся ячейка, а не цветной квадрат внутри неё: иначе
            // зазоры между днями — мёртвые зоны, а цель на узком экране
            // меньше 44 pt.
            <Pressable
              key={date}
              onPress={() => onSelect(date, status)}
              disabled={off}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: chosen, disabled: off }}
              style={styles.cell}
            >
              <View
                style={[
                  styles.day,
                  busy && styles.busy,
                  waiting && styles.waiting,
                  chosen && styles.chosen,
                ]}
              >
                <Text
                  // Квадрат дня фиксированной высоты: при самых крупных
                  // системных шрифтах двузначное число из него вылезало бы.
                  maxFontSizeMultiplier={1.6}
                  style={[
                    styles.dayText,
                    date === today && styles.todayText,
                    busy && styles.busyText,
                    waiting && styles.waitingText,
                    past && styles.pastText,
                    chosen && styles.chosenText,
                  ]}
                >
                  {day}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export interface LegendItem {
  tone: 'busy' | 'waiting';
  label: string;
}

/** Подписи к цветам календаря. */
export function CalendarLegend({ items }: { items: LegendItem[] }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.legend}>
      {items.map((item) => (
        <View key={item.label} style={styles.legendItem}>
          <View style={[styles.legendDot, item.tone === 'busy' ? styles.busy : styles.waiting]} />
          <Text style={styles.legendText}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
    arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    hidden: { opacity: 0 },
    month: {
      flexShrink: 1,
      textAlign: 'center',
      fontSize: text.subtitle,
      fontWeight: '600',
      color: colors.text,
    },
    week: { flexDirection: 'row', marginTop: 4 },
    weekday: { flex: 1, textAlign: 'center', fontSize: 12, color: colors.muted, paddingVertical: 6 },
    grid: { flexDirection: 'row', flexWrap: 'wrap' },
    // 14.2857% — седьмая часть строки: семь дней в ряд без подсчёта ширины.
    cell: { width: '14.2857%', padding: 2 },
    day: { height: 42, borderRadius: radius.inner, alignItems: 'center', justifyContent: 'center' },
    dayText: { fontSize: text.body, color: colors.text },
    todayText: { color: colors.primary, fontWeight: '700' },
    pastText: { color: colors.muted, opacity: 0.5 },
    // Рамка только у «занято»: красноватую и оранжевую заливки при
    // дальтонизме не различить, а рамку видно без цвета. Точка в легенде
    // берёт этот же стиль и получает такую же рамку.
    busy: { backgroundColor: `${colors.danger}26`, borderWidth: 1, borderColor: colors.danger },
    busyText: { color: colors.danger },
    waiting: { backgroundColor: `${colors.warning}26` },
    waitingText: { color: colors.warning },
    // borderColor — чтобы у выбранного занятого дня (владелец жмёт именно
    // их) не оставалась красная рамка вокруг зелёной заливки.
    chosen: { backgroundColor: colors.primary, borderColor: colors.primary },
    chosenText: { color: colors.onPrimary, fontWeight: '700', opacity: 1 },
    legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    legendDot: { width: 14, height: 14, borderRadius: 4 },
    legendText: { fontSize: 13, color: colors.muted },
  });
