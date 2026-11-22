import { Stack } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Review } from '@/api/types';
import { Button } from '@/components/Button';
import { Card, Row, RowGroup, SectionLabel, SwitchRow } from '@/components/Card';
import { Chip, ChipWrap } from '@/components/Chip';
import { Badge, EmptyState, ErrorBanner } from '@/components/Feedback';
import { Field, Input, SelectField } from '@/components/Field';
import { CalendarLegend, MonthCalendar } from '@/components/MonthCalendar';
import { ReviewList } from '@/components/ReviewList';
import { Screen } from '@/components/Screen';
import { Segment } from '@/components/Segment';
import { Sheet } from '@/components/Sheet';
import { StarRating } from '@/components/StarRating';
import { Thumb } from '@/components/Thumb';
import { space } from '@/theme';
import { useColors } from '@/theme/scheme';
import { serverToday } from '@/utils/serverTime';

/**
 * Витрина компонентов — только для разработки (__DEV__): открыть /kit.
 * В приложении на неё нет ни одной ссылки.
 */
export default function KitScreen() {
  const colors = useColors();
  const [seg, setSeg] = useState<'ru' | 'kz'>('ru');
  const [chips, setChips] = useState<string[]>(['stage']);
  const [date, setDate] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [on, setOn] = useState(true);
  const [stars, setStars] = useState(4);

  const toggle = (id: string) =>
    setChips((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  return (
    <Screen scroll footer={<Button label="Забронировать" onPress={() => {}} style={{ flex: 1 }} />}>
      <Stack.Screen options={{ headerShown: true, title: 'Компоненты' }} />

      <Card title="Кнопки" hint="filled, outline, text, danger, busy">
        <Button label="Главное действие" onPress={() => {}} />
        <Button label="Второстепенное" variant="outline" icon="chat-outline" onPress={() => {}} />
        <Button label="Удалить" variant="outline" tone="danger" onPress={() => {}} />
        <Button label="Ссылка" variant="text" onPress={() => {}} />
        <Button label="Идёт запрос" busy onPress={() => {}} />
        <Button label="Маленькая" small variant="outline" onPress={() => {}} />
      </Card>

      <Card title="Поля">
        <Field label="Название" hint="Как увидят клиенты">
          <Input placeholder="Например: Цемент М500" />
        </Field>
        <Field label="Цена, ₸" error="Укажите цену">
          <Input placeholder="500000" keyboardType="number-pad" invalid />
        </Field>
        <Field label="Описание">
          <Input placeholder="Что важно знать клиенту" multiline />
        </Field>
        <Field label="Город">
          <SelectField placeholder="Выберите город" value={null} onPress={() => setSheet(true)} />
        </Field>
      </Card>

      <SectionLabel>Переключатель и чипы</SectionLabel>
      <Segment
        value={seg}
        onChange={setSeg}
        options={[
          { value: 'ru', label: 'Русский' },
          { value: 'kz', label: 'Қазақша' },
        ]}
      />
      <ChipWrap>
        {[
          ['stage', 'Сцена'],
          ['parking', 'Парковка'],
          ['kitchen', 'Своя кухня'],
          ['kids', 'Детская зона'],
        ].map(([id, label]) => (
          <Chip key={id} label={label} selected={chips.includes(id)} onPress={() => toggle(id)} />
        ))}
        <Chip label="Метка" icon="map-marker" />
      </ChipWrap>

      <SectionLabel>Строки</SectionLabel>
      <RowGroup>
        <Row first title="Мои объявления" icon="storefront-outline" onPress={() => {}} />
        <Row title="Входящие заявки" icon="inbox-arrow-down-outline" value="3" onPress={() => {}} />
        <SwitchRow
          label="Зал опубликован"
          hint="Клиенты видят его в поиске"
          value={on}
          onValueChange={setOn}
        />
        <Row title="Выйти" danger onPress={() => {}} />
      </RowGroup>

      <Card title="Превью" hint="фото с сервера или заглушка">
        <View style={styles.thumbs}>
          <Thumb path={null} size={48} />
          <Thumb path={null} size={56} icon="storefront-outline" />
          <Thumb path={null} size={68} iconSize={28} icon="account-tie-outline" />
        </View>
      </Card>

      <SectionLabel>Отзывы</SectionLabel>
      <ReviewList reviews={SAMPLE_REVIEWS} replyLabel="Ответ владельца:" emptyText="Пока нет отзывов" />
      <ReviewList reviews={[]} replyLabel="Ответ владельца:" emptyText="Пока нет отзывов" />

      <Card title="Календарь">
        <MonthCalendar
          value={date}
          onSelect={setDate}
          days={[
            // Отрицательное «дней назад» — вперёд. По поясу сервера, как сам
            // календарь: по часам телефона образцы съезжали бы на день от его «сегодня».
            { date: serverToday(-3), status: 'confirmed', price: null, is_weekend: false },
            { date: serverToday(-5), status: 'pending', price: null, is_weekend: false },
          ]}
        />
        <CalendarLegend
          items={[
            { tone: 'busy', label: 'Занято' },
            { tone: 'waiting', label: 'Ждёт ответа' },
          ]}
        />
      </Card>

      <Card title="Состояния">
        <ErrorBanner message="Не удалось загрузить. Проверьте соединение." />
        <ChipWrap>
          <Badge label="Ожидает" tone="warning" />
          <Badge label="Подтверждено" tone="success" />
          <Badge label="Отклонено" tone="danger" />
          <Badge label="Отменено" />
        </ChipWrap>
        <StarRating value={stars} onChange={setStars} />
        <EmptyState
          title="Пока нет заявок"
          subtitle="Найдите магазин и подайте заявку"
          action={<Button label="Найти зал" variant="outline" onPress={() => {}} />}
        />
      </Card>

      <Sheet visible={sheet} onClose={() => setSheet(false)} title="Выберите город">
        <Input placeholder="Поиск" />
        <Text style={{ color: colors.muted }}>Здесь будет список городов.</Text>
        <Button label="Готово" onPress={() => setSheet(false)} />
      </Sheet>
    </Screen>
  );
}

const SAMPLE_REVIEWS: Review[] = [
  {
    id: 1,
    guid: 'kit-review-1',
    rating: 5,
    text: 'Всё прошло отлично, гости довольны. Отдельное спасибо за кухню.',
    owner_reply: 'Спасибо, ждём вас снова!',
    owner_reply_at: '2026-09-14T09:00:00Z',
    created_at: '2026-09-12T18:30:00Z',
    client_name: 'Айгерим',
  },
  {
    id: 2,
    guid: 'kit-review-2',
    rating: 3,
    text: null,
    owner_reply: null,
    owner_reply_at: null,
    created_at: '2026-08-30T12:00:00Z',
    client_name: 'Ерлан',
  },
];

const styles = StyleSheet.create({
  thumbs: { flexDirection: 'row', alignItems: 'center', gap: space.gap },
});
