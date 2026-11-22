/**
 * Цвет бейджа для статуса заявки — один на клиентский и владельческий
 * списки, чтобы «ожидает» не было жёлтым в одном месте и серым в другом.
 * Подпись: t(`bookings.status_${status}`).
 */
export type BookingTone = 'warning' | 'success' | 'danger' | 'muted';

export function bookingStatusTone(status: string): BookingTone {
  switch (status) {
    case 'pending':
      return 'warning';
    case 'confirmed':
      return 'success';
    case 'rejected':
      return 'danger';
    default:
      return 'muted';
  }
}
