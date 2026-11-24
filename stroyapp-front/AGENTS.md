# StroyApp mobile — правила кода

Expo SDK 58, React Native 0.88, expo-router, TypeScript 6. **Expo сильно
изменился**: прежде чем писать код с незнакомым API, сверься с версионной
документацией https://docs.expo.dev/versions/v58.0.0/ и с типами в
`node_modules` (они — истина для установленной версии).

Интерфейс устроен «как в iduken» (`D:\Projects\iduken\iduken-mobile`):
системные вкладки и шапки, свои простые компоненты, системный шрифт,
светлая и тёмная тема по системе. `react-native-paper`, React Navigation
напрямую и свои шрифты не используются.

Старый интерфейс (Paper + React Navigation) — в истории git до коммита
`fde911d`: там смотреть, что экран делал, какие запросы слал и какие были тексты.

## Где что лежит

```
src/app/                 экраны = файлы (expo-router)
  _layout.tsx            корень: тема, вход, стек
  (tabs)/                4 вкладки: index (поиск), favorites, messages, profile
  provider.tsx, chat.tsx …  экраны над вкладками, плоско, kebab-case
  kit.tsx                витрина компонентов, только в разработке (__DEV__)
src/components/          общие компоненты
src/theme/               цвета, размеры, useColors / useThemedStyles
src/api, src/store       слой данных — НЕ ПЕРЕПИСЫВАТЬ, только использовать
src/i18n/ru.json, kz.json, pending/
src/utils/               мелкие общие функции — см. «Утилиты»
```

## Тема и стили

```tsx
import { radius, space, text, HIT, FILL, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';

export default function SomeScreen() {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();           // для цвета иконок и вертушек
  ...
}

// На уровне модуля, внизу файла — иначе стили пересоздаются каждый рендер.
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({ ... });
```

- Цвета только из темы: `primary, onPrimary, accent, onAccent, background,
  card, text, muted, border, outline, danger, success, warning`. Оттенок —
  альфой: `` `${colors.primary}22` ``. Литералы цветов — только чёрный/белый
  поверх фотографий.
- `border` — волосяные разделители, заглушки и рамки меток, которые не
  нажимают. `outline` — рамка того, во что вводят и что выбирают: поле,
  нажимаемый чип, сегмент (3:1 к фону — иначе граница не видна).
- `scrim` — затемнение под шторкой, одно на обе темы: `import { scrim } from '@/theme'`.
- `FILL` — растянуть на весь родитель; вместо `StyleSheet.absoluteFill`:
  expo-image с ним рисует картинку нулевого размера, а в вебе его нельзя
  развернуть через `...`.
- `space.page` 16 (край экрана), `space.card` 16, `space.gap` 12.
  `text.caption` 14, `body` 16, `subtitle` 18, `section` 20, `title` 24,
  `metric` 26 (крупная цифра: цена, код из СМС). `radius.card` 14,
  `radius.inner` 10, `radius.pill`.
- Шрифт системный: **никакого `fontFamily`**. Вес — `fontWeight` '500' /
  '600' / '700'.
- Теней и elevation нет: глубину даёт `card` на `background`.
- Всё нажимаемое — не ниже `HIT` (48), второстепенное — 44. Отклик на
  нажатие — прозрачность или смена фона, без ряби.
- В колонке с текстом — `flex: 1, minWidth: 0`; у значений справа —
  `flexShrink: 0`; у длинных текстов в строках — `numberOfLines`.

## Готовые компоненты (`src/components`)

Смотри сами файлы — там пропсы и пояснения.

| Компонент | Для чего |
| --- | --- |
| `Screen`, `ScreenTitle` | рамка экрана, заголовок вкладки |
| `Button` | filled / outline / text, tone danger, icon, busy, small |
| `Field`, `Input`, `SelectField` | подпись + поле + ошибка; поле ввода; поле-выбор |
| `Chip`, `ChipWrap` | чип-таблетка (без `onPress` — метка), ряды с переносом |
| `TouchChip`, `ChipRow` | нажимаемые чипы в одну строку с прокруткой вбок (фильтры над списком). В ряду hitSlop обрезается — внутрь только `TouchChip` |
| `Segment` | выбор из 2–4 вариантов |
| `Card`, `SectionLabel`, `RowGroup`, `Row` | карточка, подпись раздела, строки настроек |
| `SwitchRow` | строка «подпись + переключатель» в `RowGroup`, нажимается вся. Switch в `right` у `Row` не ставить: он ниже 44, а hitSlop не слушает |
| `Thumb` | квадратное превью в строке списка: путь фото с сервера, заглушка-иконка |
| `Loader`, `ErrorBanner`, `EmptyState`, `Badge` | загрузка, ошибка, пусто, статус |
| `useAnnounce` | проговорить диктору появившийся текст (ошибку). `ErrorBanner` и `Field` с `error` делают это сами — второй раз тот же текст не объявлять: полоса у кнопки, повторяющая ошибку поля, — `<ErrorBanner announce={false} …>` |
| `Sheet` | шторка снизу |
| `MonthCalendar`, `CalendarLegend` | месяц для выбора даты (умеет красить дни по занятости, в StroyApp не используется) |
| `StarRating` | звёзды |

Отступы списка (`contentContainerStyle` у FlatList) — из `Screen.tsx`:

| Константа | Где |
| --- | --- |
| `TAB_LIST_CONTENT` | список на вкладке: запас под панель вкладок и `flexGrow` для `EmptyState` по центру |
| `LIST_CONTENT` | список на экране над вкладками |
| `LIST_CONTENT_FILL` | то же, но с `EmptyState` или вертушкой первой загрузки по центру |
| `TAB_BOTTOM` | нижний запас вкладки для содержимого, которое не список |

Подстроить — разворотом, а не своим набором: `{ ...TAB_LIST_CONTENT, gap: 0 }`.

«Готово» над цифровой клавиатурой: `Input` сам ставит его на iOS для
`number-pad` / `phone-pad` / `decimal-pad` / `numeric` (через
`inputAccessoryViewButtonLabel`). Голому `TextInput` с такой клавиатурой
нужно передать `inputAccessoryViewButtonLabel={t('common.done')}` самому —
иначе закрыть её нечем.

Компоненты предметной области (тоже в `src/components`):

| Компонент | Что важно знать |
| --- | --- |
| `ProviderCard` | карточка магазина или бригады в списках. Совпавшие с поиском позиции прайса (`matched_items`) показывает строками под ценой. Отступов между карточками нет — их даёт `gap` списка |
| `ListingCard` | основа `ProviderCard`: получает готовые строки, `extraLines` — дополнительные строки под ценой. Новая карточка в поиске — обёртка над ней, а не своя вёрстка |
| `FavoriteHeart` | сердце «в избранное» в белом круге поверх фото. Ставить соседом фото или нажимаемой карточки, а не внутрь: иначе нажатие откроет объявление, а VoiceOver кнопку не найдёт. `inset={8}` в карточке списка, по умолчанию 12 — на экране объявления |
| `RatingInline`, `ratingLabel` | звезда, средняя оценка и число отзывов в строку; `ratingLabel` — то же словами для диктора. Внутри нажимаемой карточки со своей подписью — `accessible={false}` |
| `ReviewList` | отзывы на карточке объявления: `reviews={reviews?.items ?? []}`, подпись ответа и текст «пусто». С `onReport` у каждого отзыва появляется «Пожаловаться» |
| `CategoryBar`, `FiltersBar` | полосы поиска. Отступ от краёв экрана у них внутри: в заголовке списка с `LIST_CONTENT` их оборачивают в `<View style={{ marginHorizontal: -space.page }}>` |
| `CityPicker`, `DatePickerSheet`, `FiltersSheet` | шторки выбора. `FiltersSheet` — предел цены, сортировка и теги-признаки (`tags`) |
| `PhotoGallery`, `PhotoViewer` | галерея берёт ширину родителя: для фото от края до края — `marginHorizontal: -space.page` |
| `PhotoStrip` | лента фото в формах владельца; только показ, выбор и загрузка — в экране. Ключи должны быть уникальны, монтировать уже с загруженным списком |
| `AuthGateSheet` | шторка входа, уже в корневом макете. Открывается через `useRequireAuth()` / `useAuthGateStore().open(reason)` |

Нужного нет — сделай локально в файле экрана. Общие компоненты и тему не
правь: напиши, чего не хватило, в итоговом ответе.

Иконки в содержимом — `MaterialCommunityIcons` из `@expo/vector-icons`.
Имя иконки с сервера (категории) — через `mdiOrFallback(name)` из
`@/utils/icons`: незнакомое имя иначе рисуется знаком вопроса. Фото —
`Image` из `expo-image` (`contentFit="cover"`, `transition={150}`), адрес —
`photoUrl(path)` из `@/utils/photo`; квадратное превью в строке — `Thumb`.

## Каркас экрана

**Вкладка** (`src/app/(tabs)/*.tsx`) — системной шапки нет:

```tsx
<Screen tab>
  <FlatList
    data={items}
    contentContainerStyle={TAB_LIST_CONTENT}
    ListHeaderComponent={<ScreenTitle title={t('favorites.title')} />}
    ...
  />
</Screen>
```

**Экран над вкладками** — шапку включает сам, первой строкой:

```tsx
<Screen scroll footer={<Button label={t('common.save')} onPress={save} style={{ flex: 1 }} />}>
  <Stack.Screen options={{ headerShown: true, title: t('owner.provider_form_new') }} />
  ...
</Screen>
```

- Новый экран — строкой в `src/app/_layout.tsx`: каталог (`provider`) открыт гостю, личные экраны — внутри
  `<Stack.Protected guard={authed}>`.
- Формы и карточки — `<Screen scroll>`; списки — `<Screen>` и свой
  `FlatList` с `LIST_CONTENT` / `LIST_CONTENT_FILL` (см. таблицу выше).
- Заголовок, зависящий от данных, — тот же `<Stack.Screen options>` с новым
  `title`. `navigation.setOptions` не используем.
- Кнопки действия — в содержимом или в `footer`, а не в шапке.
- Первая загрузка: `if (loading) return <Screen>…<Loader /></Screen>` — с тем
  же `<Stack.Screen>`, иначе шапка мигает.
- Список: `refreshing` / `onRefresh` у FlatList (или `refreshControl` с
  `tintColor={colors.primary}`), пусто — `ListEmptyComponent={<EmptyState …/>}`,
  ошибка — `<ErrorBanner>` в `ListHeaderComponent`.
- В списках `renderItem` и `keyExtractor` — в `useCallback`.

## Навигация (expo-router)

```tsx
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { pushOnce, useOnTop } from '@/utils/nav';

pushOnce({ pathname: '/provider', params: { providerGuid } });
const { providerGuid } = useLocalSearchParams<{ providerGuid: string }>();
router.back();
router.dismissTo('/my-listings');   // назад к уже открытому экрану
router.setParams({ providerGuid }); // форма «создать» стала «изменить»
```

- Экран открывать только через `pushOnce`, не `router.push`: быстрый
  двойной тап положил бы в стек две копии.
- Переход или `Alert` после `await` — только если экран ещё перед глазами:
  `const onTop = useOnTop();` вверху экрана, затем
  `if (!onTop.current) return;` перед `pushOnce` и
  `if (onTop.current) Alert.alert(…)` для ошибки. Шторки и просмотр фото
  его не сбрасывают.
- Из `@react-navigation/*` ничего не импортируем. Единственное исключение —
  `HeaderHeightContext` из `expo-router/react-navigation` (высота шапки для
  клавиатуры; уже стоит в `Screen` и `chat`).

Параметры — только строки. Число: `String(id)` при отправке, `Number(x)` и
проверка на `NaN` при чтении. Объекты через параметры не передаём — экран
сам грузит по guid.

| Экран | Путь | Параметры |
| --- | --- | --- |
| Поиск / Избранное / Сообщения / Профиль | `/`, `/favorites`, `/messages`, `/profile` | — |
| Магазин / бригада | `/provider` | `providerGuid`, `fromChat?` (guid чата, из которого открыли) |
| Новая заявка | `/booking-form` | `providerGuid`, `initialDate?` (YYYY-MM-DD), `initialComment?` (текст заявки, например позиция прайса). Если у человека есть клиенты как у мастера, форма сама предложит выбрать, для кого заявка |
| Чат | `/chat` | `chatGuid` |
| Мои заявки | `/my-bookings` | — |
| Отзыв | `/review-form` | `bookingGuid`, `subjectName?` |
| Жалоба | `/report` | `targetType` (`provider` / `review` / `chat`), `targetGuid`, `subjectName?` |
| Заблокированные | `/blocked-users` | — |
| Мои объявления | `/my-listings` | — |
| Входящие заявки | `/incoming-bookings` | — |
| Заявка (владельцу) | `/booking` | `bookingGuid` |
| Форма объявления (с прайсом) | `/provider-form` | `providerGuid?`, `categoryId?` |
| Тариф и оплата продавца | `/subscription` | — |
| Мастера и клиенты (мастер заказывает от имени клиента) | `/masters` | — |
| Заявки мастера для клиентов | `/ordered-bookings` | — |

Перейти на вкладку с экрана над вкладками — `router.dismissTo('/messages')`,
а не `push` / `navigate`: те положат поверх вторую копию вкладок.

## Данные

- Запросы — через `@/api` (`searchApi`, `providersApi`, …), ошибки — `ApiError`,
  текст ошибки: `e instanceof ApiError ? e.message : t('common.error_generic')`.
- Загрузка — `useEffect` / `useFocusEffect` (из `expo-router`) + `useState`,
  как было. react-query не подключаем.
- Вход: `useRequireAuth()` из `@/store/useRequireAuth` —
  `requireAuth('book', () => pushOnce(...))`; причины — `book`, `favorite`,
  `message`, `generic`. `useIsAuthed()` — вошёл ли: есть токен, имя и
  согласие с условиями использования. Экрана входа нет, вход — шторка
  `AuthGateSheet`: телефон → код → согласие с условиями → имя; последние
  два шага — только если их ещё не прошли. Согласие уходит на сервер с
  версией условий, которую он прислал (`user.terms_version`).
- Ответ сервера с пользователем у того, кто уже вошёл, кладём в хранилище
  через `keptForSession` (из `@/store/useRequireAuth`):
  `setUser(answer.user, keptForSession(now.user, answer.user) ?? undefined)`.
  Сервер может ответить «условия не приняты» посреди работы (ответ о профиле
  при запуске опоздал), и голый `setUser` молча отнял бы вход вместе с
  экраном, на котором человек находится.
- Адреса страниц с условиями и политикой и почта поддержки —
  `TERMS_URL`, `PRIVACY_URL`, `SUPPORT_EMAIL` из `@/config`.
- Язык для справочников: `const lang = useLang()` из `@/utils/lang`, затем
  `dictName(item, lang)`. **Не** `user.language`.
- Подтверждение с красной кнопкой (удалить, выйти) — `confirmDestructive`,
  «Сохранено» с закрытием экрана — `showThen`, оба из `@/utils/alert`, а не
  голый `Alert.alert` с колбэком: в веб-просмотре он пуст и кнопок не
  вызывает, и путь там обрывается.

## Утилиты (`src/utils`)

| Файл | Что там |
| --- | --- |
| `alert.ts` | `confirmDestructive(title, message, onConfirm, label?)` — «Отмена» и красная кнопка; `showThen(title, message, onClose)` — «ОК», затем действие экрана. В вебе работают через `window.confirm` и сразу |
| `bookingStatus.ts` | цвет бейджа статуса заявки; подпись — ``t(`bookings.status_${status}`)`` |
| `category.ts` | `KINDS`, `KIND_KEY`, `KIND_ICON` — вид объявления: магазин материалов (`material`) или бригада (`service`) |
| `cityCoords.ts` | координаты городов, ближайший город к GPS |
| `coords.ts` | разбор координат в формах владельца, вставка пары из 2GIS |
| `format.ts` | `formatPrice`, `formatDateHuman`, `monthOf`. «Сегодня» здесь нет намеренно — оно в `serverTime.ts` |
| `i18nDict.ts` | `dictName` — название из справочника на нужном языке |
| `icons.ts` | `mdiOrFallback` — иконка с сервера с запасной |
| `lang.ts` | `useLang` — текущий язык интерфейса |
| `links.ts` | страница в браузере (`openPage`), письмо (`writeEmail`), звонок, маршрут и поиск в 2GIS |
| `nav.ts` | `pushOnce`, `useOnTop` |
| `number.ts` | числовые поля форм: `onlyDigits`, `intOrNull` |
| `phone.ts` | казахстанские номера: приведение, показ, маска ввода |
| `payments.ts` | `PAY_IN_APP` — можно ли платить за тариф из приложения. На iOS нельзя (правила App Store): ни кнопок оплаты, ни цен, ни ссылок на оплату — Pro оплачивают в веб-кабинете `/cabinet` |
| `photo.ts` | `photoUrl` — полный адрес фото по пути с сервера |
| `pickPhotos.ts` | выбор фото из галереи для форм владельца |
| `priceUnit.ts` | единицы прайса: `UNITS`, `UNIT_KEY`, `unitName` («м²»), `unitLabel` («за м²») |
| `push.ts` | регистрация push; в 1.0 не подключена |
| `serverTime.ts` | `serverToday`, `serverStamp` — «сегодня» и «сейчас» по поясу сервера (UTC+5). Любое «сегодня», которое сравнивают с датами сервера (календарь, выбор даты, заявка, переписка), — только отсюда, не по часам телефона: иначе в другом поясе или около полуночи пропустим день, который сервер отклонит |
| `useKeyboardShown.ts` | открыта ли клавиатура — для отступов под ней |
| `useSafeBottomInset.ts` | нижний отступ с запасом под кнопки Android |

## Переводы

Ни одной строки, видимой человеку, в коде: только `t('ns.key')`. Ключи есть
в `src/i18n/ru.json` и `kz.json` — сначала ищи готовый. Если нужного нет,
**не правь json** (их правят несколько человек сразу), а положи рядом файл
`src/i18n/pending/<имя-экрана>.json`:

```json
{ "owner.photos_uploading": ["Загружаем фото…", "Фото жүктелуде…"] }
```

Первым русский, вторым казахский. Их сольют в общие файлы после.

- Ключ пиши целиком, а не склеивай из кусков: такой находит поиск по
  проекту, а забытый вариант не соберётся. Набор вариантов — таблицей
  ключей, как `UNIT_KEY` в `@/utils/priceUnit`.
- Число с существительным — `t('owner.items_count', { count })` и формы
  `_one`, `_few`, `_many`, `_other` **в обоих файлах**. В kz все четыре с
  одним текстом: код языка `kz` не из CLDR (казахский — `kk`), и правило
  множественного числа берётся по языку телефона — на русском телефоне
  без `_few` для «2» показался бы русский текст.

## Комментарии и стиль

Комментарии по-русски и только о том, **почему** так: решение, подводный
камень, причина отказа от очевидного. Что делает код — видно из кода.
Одинарные кавычки, точки с запятой, отступ два пробела. Никаких
`console.log`.

## Проверка

`npx tsc --noEmit` из `stroyapp-front`. Ошибки в чужих файлах не чини —
сообщи. `npm install` не запускай.
