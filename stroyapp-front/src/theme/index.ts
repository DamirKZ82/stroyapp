/**
 * Цвета и размеры ToiApp.
 *
 * Устройство темы взято из iduken: короткий набор цветов, фон и карточки
 * вместо теней, системный шрифт. Свои у ToiApp только сами цвета —
 * фирменный зелёный и оранжевый акцент на тёплых нейтральных.
 *
 * Все цвета — шестизначный hex без прозрачности: оттенки делаются
 * приписыванием альфы, `${colors.primary}22`.
 *
 * Тёмная тема — не инверсия светлой: фон тёмно-тёплый, текст приглушённо-
 * белый, а зелёный, оранжевый и цвета статусов взяты светлее, иначе на
 * тёмном фоне они не проходят по контрасту.
 *
 * Контраст посчитан, а не подобран на глаз (WCAG AA): текст — не ниже 4.5:1
 * и на background, и на card, и на своём же оттенке (`${danger}1F` у полосы
 * ошибки, `${warning}26` в календаре); значки и рамки полей — не ниже 3:1.
 * Меняешь цвет — пересчитай: светлая тема уже однажды не проходила.
 */

export interface ThemeColors {
  /** Фирменный зелёный: главные кнопки, активная вкладка, цены. */
  primary: string;
  /** Текст поверх primary. */
  onPrimary: string;
  /** Оранжевый акцент: бейджи, рейтинг, «свободно». */
  accent: string;
  /**
   * Текст поверх accent. В обеих темах тёмный: белый на оранжевом не
   * дотягивает и до 3:1, а бейдж «свободно» набран 12-м кеглем.
   */
  onAccent: string;
  background: string;
  card: string;
  text: string;
  muted: string;
  /** Волосяные разделители и заглушки. Для рамок полей слишком бледный. */
  border: string;
  /**
   * Рамка того, во что вводят и что выбирают: поле, чип, сегмент. Они
   * стоят на карточке того же цвета, и рамка — единственная их граница,
   * поэтому она темнее border (3:1 к card и к background).
   */
  outline: string;
  danger: string;
  success: string;
  warning: string;
}

export const lightColors: ThemeColors = {
  primary: '#1F7A4F',
  onPrimary: '#FFFFFF',
  accent: '#D06F0C',
  onAccent: '#1A1512',
  background: '#F5F3F0',
  card: '#FFFFFF',
  text: '#171514',
  muted: '#706963',
  border: '#E8E3DE',
  outline: '#928B85',
  danger: '#A83838',
  success: '#2E7D32',
  warning: '#964D07',
};

export const darkColors: ThemeColors = {
  primary: '#4CAF78',
  onPrimary: '#0F1A13',
  accent: '#F2A03C',
  onAccent: '#1A1512',
  background: '#121110',
  card: '#1D1B1A',
  text: '#F2EFEC',
  muted: '#8F8781',
  border: '#383432',
  outline: '#757069',
  danger: '#FF6B6B',
  success: '#6BC073',
  warning: '#F4A344',
};

/**
 * Затемнение под шторкой. Не в ThemeColors: оно одинаково в светлой и
 * тёмной теме и с прозрачностью, а цвета темы — непрозрачный hex.
 */
export const scrim = 'rgba(0,0,0,0.45)';

/** Отступы: край экрана, внутренность карточки, зазор между блоками. */
export const space = { page: 16, card: 16, gap: 12 } as const;

/**
 * Размеры текста. Меньше 14 — только бейджи и подписи под иконками.
 * В полях ввода всегда 16: при меньшем iOS увеличивает экран при фокусе.
 */
export const text = {
  caption: 14,
  body: 16,
  subtitle: 18,
  section: 20,
  title: 24,
  metric: 26,
} as const;

export const radius = { card: 14, inner: 10, pill: 999 } as const;

/** Минимальная высота того, во что попадают пальцем. */
export const HIT = 48;

/**
 * «Растянуть на всего родителя». Свой объект вместо StyleSheet.absoluteFill:
 * тот в вебе — не обычный объект стиля, его нельзя развернуть через `...`, а
 * expo-image его не понимает и рисует картинку нулевого размера.
 */
export const FILL = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;
