import { useCallback } from 'react';
import { useAuthStore, type User } from './authStore';
import { useAuthGateStore, AuthGateReason } from './authGateStore';

/**
 * Хук для защиты действий, требующих логина.
 *
 * Использование:
 *   const requireAuth = useRequireAuth();
 *   const onBook = () => requireAuth('book', () => doActualBooking());
 *
 * Если пользователь залогинен — сразу вызывает колбэк.
 * Если нет — открывает AuthGateSheet. После успешного логина колбэк вызовется.
 */
/**
 * Что осталось сделать человеку с токеном, чтобы вход считался законченным:
 * принять Условия использования ('terms'), назвать себя ('profile') или уже
 * ничего (null). Одно правило и для шторки входа, и для useIsAuthed.
 *
 * Сначала согласие: имя — тоже данные человека, и спрашивать его до согласия
 * незачем. Сравнение с false строгое: сервер старше согласия этого поля не
 * шлёт, и принять условия там негде — это не причина не пускать.
 */
export function pendingLoginStep(user: User | null): 'terms' | 'profile' | null {
  if (!user) return null;
  if (user.terms_accepted === false) return 'terms';
  if (!user.full_name) return 'profile';
  return null;
}

/**
 * Сервер прислал пользователя, у которого условия не приняты, а человек
 * уже пользуется приложением как вошедший: ответ о профиле при запуске
 * опоздал, и вход держится на том, что лежало в телефоне. Отнять вход
 * сейчас — значит молча закрыть экран, на котором он находится (переписку
 * с набранным сообщением, форму заявки), и не объяснить почему.
 *
 * Возвращает, каким пользователь остаётся в памяти до конца запуска: всё
 * свежее, а согласие — как было. В хранилище телефона при этом пишется то,
 * что прислал сервер, и следующий запуск начнётся с шага согласия. Сервер
 * согласия не требует, так что до тех пор ничего не ломается.
 *
 * null — придерживать нечего: вход и так не закончен либо условия приняты.
 */
export function keptForSession(current: User | null, fresh: User): User | null {
  if (!current || pendingLoginStep(current) !== null) return null;
  if (pendingLoginStep(fresh) !== 'terms') return null;
  return { ...fresh, terms_accepted: current.terms_accepted, terms_version: current.terms_version };
}

/**
 * Вошёл ли человек. Токен без согласия с условиями или без имени — ещё
 * гость: вход не закончен, шторка входа остановилась на одном из этих шагов.
 */
export function useIsAuthed(): boolean {
  return useAuthStore((s) => !!s.token && !!s.user && pendingLoginStep(s.user) === null);
}

export function useRequireAuth() {
  const isAuthed = useIsAuthed();
  const open = useAuthGateStore((s) => s.open);

  return useCallback(
    (reason: AuthGateReason, action: () => void) => {
      if (isAuthed) {
        action();
      } else {
        open(reason, action);
      }
    },
    [isAuthed, open],
  );
}
