import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { space } from '@/theme';
import { intOrNull, onlyDigits } from '@/utils/number';
import { Button } from './Button';
import { Field, Input } from './Field';
import { Sheet } from './Sheet';

interface GuestsPickerProps {
  visible: boolean;
  value: number | null;
  onChange: (value: number | null) => void;
  onClose: () => void;
  /** Границы вместимости. Подсказка и проверка — только когда заданы обе. */
  min?: number;
  max?: number;
}

/** Пример в пустом поле. Это цифры, а не слово — переводить нечего. */
const EXAMPLE = '150';

/** Пять знаков хватает с запасом, а длиннее — уже опечатка. */
const MAX_DIGITS = 5;

const toText = (value: number | null) => (value != null ? String(value) : '');

/**
 * Шторка «сколько гостей».
 *
 * Число уходит наружу только по «Готово»: пока человек набирает, фильтр
 * поиска не дёргается на каждую цифру. Пустое поле и ноль значат «не важно»
 * и отдаются как null.
 */
export function GuestsPicker({ visible, value, onChange, onClose, min, max }: GuestsPickerProps) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(toText(value));

  // Компонент не размонтируется между открытиями, а value за это время мог
  // поменяться снаружи (сброс фильтров) или человек закрыл шторку, не нажав
  // «Готово». Сверяемся в рендере, а не в useEffect: поле с autoFocus иначе
  // показало бы на первом кадре старый текст.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setRaw(toText(value));
  }

  const parsed = intOrNull(raw);
  const count = parsed !== null && parsed > 0 ? parsed : null;

  const ranged = min != null && max != null;
  const rangeHint = ranged ? t('guests_picker.range_hint', { min, max }) : undefined;
  // Подсказка обещает границы — значит число вне их принять нельзя. Пустое
  // поле не ошибка: это «сбросить».
  const outOfRange = ranged && count !== null && (count < min || count > max);
  // У ошибки свой текст, а не та же подсказка красным: одну смену цвета
  // человек, который плохо различает цвета, не заметит.
  const rangeError = outOfRange ? t('guests_picker.out_of_range', { min, max }) : null;

  const apply = () => {
    onChange(count);
    onClose();
  };

  const reset = () => {
    setRaw('');
    onChange(null);
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('guests_picker.title')}>
      <Field hint={rangeHint} error={rangeError}>
        <Input
          value={raw}
          onChangeText={(next) => setRaw(onlyDigits(next, MAX_DIGITS))}
          keyboardType="number-pad"
          placeholder={EXAMPLE}
          // Иначе экранный диктор назвал бы поле по примеру в нём: «150».
          accessibilityLabel={t('guests_picker.title')}
          invalid={outOfRange}
          autoFocus
        />
      </Field>
      <View style={styles.actions}>
        <Button variant="text" label={t('common.reset')} onPress={reset} />
        <Button label={t('common.done')} onPress={apply} disabled={outOfRange} style={styles.done} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.gap },
  done: { flex: 1 },
});
