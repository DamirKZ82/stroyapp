import * as ImagePicker from 'expo-image-picker';

/** Фото с телефона в том виде, в каком его принимает загрузка на сервер. */
export interface PickedPhoto {
  uri: string;
  name: string;
  type: string;
}

/**
 * Выбор фото из галереи для форм владельца. room — сколько ещё можно
 * добавить (больше нуля: ноль для системы значит «без ограничения»).
 * Возвращает null, если человек закрыл галерею, ничего не выбрав.
 *
 * Доступ к фото не запрашиваем: системный выбор (PHPicker на iOS, Photo
 * Picker на Android) работает без него и отдаёт только выбранное. Запрос
 * просил бы всю медиатеку, а отказ закрывал бы добавление фото насовсем —
 * второй раз система не спрашивает.
 */
export async function pickPhotos(room: number): Promise<PickedPhoto[] | null> {
  const pick = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    quality: 0.9,
    selectionLimit: room,
  });
  if (pick.canceled) return null;

  // Старые системы selectionLimit не понимают и отдают всё выбранное, а
  // сервер при превышении предела отклоняет пачку целиком.
  const stamp = Date.now();
  return pick.assets.slice(0, room).map((a, i) => ({
    uri: a.uri,
    name: a.fileName ?? `photo_${stamp}_${i}.jpg`,
    type: a.mimeType ?? 'image/jpeg',
  }));
}
