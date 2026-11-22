import { Linking } from 'react-native';

/**
 * Внешние ссылки: страницы, почта, звонок и 2ГИС. Лежат в одном месте,
 * потому что формат адреса (dgis://, очистка номера) должен меняться сразу
 * для всех экранов: раньше у каждой карточки была своя копия.
 */

/**
 * Открыть страницу в браузере. false — открыть нечем (на телефоне нет
 * браузера): вызывающий сам решает, что показать вместо этого.
 */
export function openPage(url: string): Promise<boolean> {
  return Linking.openURL(url).then(
    () => true,
    () => false,
  );
}

/**
 * Написать письмо на адрес. false — почтовой программы нет: тогда адрес
 * нужно показать человеку, чтобы он написал с другого устройства.
 */
export function writeEmail(address: string, subject: string): Promise<boolean> {
  return Linking.openURL(`mailto:${address}?subject=${encodeURIComponent(subject)}`).then(
    () => true,
    () => false,
  );
}

/** Позвонить по номеру, как бы он ни был записан. */
export function callPhone(phone: string): void {
  // Телефон вводят как хотят — со скобками и пробелами, а адрес tel: с
  // пробелами iOS не открывает вовсе. Ошибку глотаем: на планшете без
  // звонилки открывать нечем, а номер и так на экране.
  Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch(() => {});
}

/** Маршрут до точки в 2ГИС. */
export function openRouteIn2Gis(latitude: number, longitude: number): void {
  // Без приложения 2ГИС схема dgis:// не открывается — тогда карта в браузере,
  // иначе кнопка молча ничего не делает.
  Linking.openURL(`dgis://2gis.ru/routeSearch/rsType/car/to/${longitude},${latitude}`).catch(() =>
    Linking.openURL(`https://2gis.kz/?m=${longitude},${latitude}/17`).catch(() => {}),
  );
}

/** Поиск по адресу в 2ГИС — когда точки на карте нет. */
export function openSearchIn2Gis(address: string): void {
  Linking.openURL(`https://2gis.kz/search/${encodeURIComponent(address)}`).catch(() => {});
}
