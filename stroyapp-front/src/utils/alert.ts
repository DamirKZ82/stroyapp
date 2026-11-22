import { Alert, Platform } from 'react-native';

import i18n from '@/i18n';

/**
 * Сообщение с одной кнопкой «ОК», после которого экран действует сам —
 * обычно закрывается («Сохранено», «Спасибо за отзыв»).
 *
 * В вебе Alert.alert ничего не показывает и кнопок не вызывает: форма так и
 * осталась бы открытой с погашенной кнопкой. Там сразу onClose — веб у нас
 * только просмотр для разработки, но и в нём путь не должен обрываться.
 *
 * На Android сообщение можно закрыть нажатием мимо него — тогда «ОК» не
 * срабатывает, и без onDismiss человек остался бы на форме. Дважды onClose
 * не придёт: из кнопки и onDismiss система вызывает только первое.
 */
export function showThen(title: string, message: string | undefined, onClose: () => void): void {
  if (Platform.OS === 'web') {
    onClose();
    return;
  }
  Alert.alert(title, message, [{ text: i18n.t('common.ok'), onPress: onClose }], {
    cancelable: true,
    onDismiss: onClose,
  });
}

/**
 * Подтверждение необратимого действия: «Отмена» и красная кнопка, по
 * умолчанию «Удалить».
 *
 * В вебе Alert.alert пуст, и удаление там было бы не проверить вовсе —
 * спрашиваем системным window.confirm.
 *
 * На Android Alert по умолчанию не закрывается ни «Назад», ни нажатием мимо,
 * а от диалога там ждут именно этого. Закрыть безопасно: onConfirm вызывает
 * только красная кнопка, так что закрытие — та же «Отмена».
 */
export function confirmDestructive(
  title: string,
  message: string | undefined,
  onConfirm: () => void,
  confirmLabel: string = i18n.t('common.delete'),
  cancelLabel: string = i18n.t('common.cancel'),
): void {
  if (Platform.OS === 'web') {
    if (window.confirm(message ? `${title}\n\n${message}` : title)) onConfirm();
    return;
  }
  Alert.alert(
    title,
    message,
    [
      { text: cancelLabel, style: 'cancel' },
      { text: confirmLabel, style: 'destructive', onPress: onConfirm },
    ],
    { cancelable: true },
  );
}
