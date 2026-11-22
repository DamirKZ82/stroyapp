/**
 * Время «как у сервера».
 *
 * Сервер пишет и проверяет даты по Казахстану (UTC+5) и отдаёт их без пояса.
 * Всё, что сравнивается с его датами, — «сегодня» в переписке, «событие уже
 * прошло» у заявки — считаем в том же поясе, а не по часам телефона: иначе
 * у человека за границей ночные сообщения попадали бы не в тот день, а
 * приложение разрешало бы то, что сервер ещё отклоняет.
 */
export const SERVER_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** «Сейчас» в том виде, в каком время пишет сервер: 'YYYY-MM-DDTHH:MM:SS'. */
export function serverStamp(daysAgo = 0): string {
  return new Date(Date.now() + SERVER_UTC_OFFSET_MS - daysAgo * DAY_MS).toISOString().slice(0, 19);
}

/** Дата по поясу сервера, 'YYYY-MM-DD': сегодня (0), вчера (1). */
export function serverToday(daysAgo = 0): string {
  return serverStamp(daysAgo).slice(0, 10);
}
