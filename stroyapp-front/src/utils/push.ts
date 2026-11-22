import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';

import { authApi } from '@/api';
import { EAS_PROJECT_ID } from '@/config';
import i18n from '@/i18n';
import { lightColors } from '@/theme';

/**
 * Настройка отображения уведомлений когда приложение на переднем плане.
 * По умолчанию Expo их скрывает, мы — показываем баннер.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Регистрация для получения push.
 *
 * Звать после входа, без await. Если человек уже давал разрешение, просто
 * возьмёт токен; если нет — спросит.
 *
 * Возвращает true, если токен получен и отправлен на бэк. Не бросает: пуши —
 * удобство, и сбой здесь (нет сети, нет сервисов Google) не должен стать
 * необработанным отказом посреди входа.
 */
export async function registerForPush(): Promise<boolean> {
  // В веб-превью пушей нет, а браузер всё равно спросил бы разрешение; на
  // симуляторе и эмуляторе токен не выдаётся. Выходим без ошибки.
  if (Platform.OS === 'web' || !Device.isDevice) return false;

  try {
    // Канал — до запроса разрешения: Android 13 не покажет окно разрешения,
    // пока у приложения нет ни одного канала. Без канала уведомления к тому
    // же беззвучные.
    if (Platform.OS === 'android') {
      // Идентификатор тот же, что defaultChannel у плагина expo-notifications
      // в app.json: в этот канал попадают пуши без своего канала, а бэк его
      // не указывает. Менять — только вместе.
      await Notifications.setNotificationChannelAsync('default', {
        // Имя видно человеку в настройках уведомлений. Канал обновляется при
        // каждой регистрации, так что имя сменится вместе с языком.
        name: i18n.t('push.channel_default'),
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 250, 250, 250],
        // Канал системный и от темы приложения не зависит — цвет из светлой.
        lightColor: lightColors.primary,
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== 'granted') return false;

    // В Expo Go projectId выводится сам, в standalone-сборке
    // (TestFlight / Play) его надо передать явно, иначе получим
    // "No projectId found" и пуши молча не заработают.
    const tokenResult = await Notifications.getExpoPushTokenAsync(
      EAS_PROJECT_ID ? { projectId: EAS_PROJECT_ID } : undefined,
    );
    const token = tokenResult.data;
    if (!token) return false;

    await authApi.setFcmToken(token);
    return true;
  } catch {
    return false;
  }
}
