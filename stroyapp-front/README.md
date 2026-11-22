# StroyApp — мобильное приложение (Expo / React Native)

Клиент и владелец в одном приложении: поиск залов и исполнителей, заявки,
чат, избранное, свои объявления и календарь занятости.

Правила кода — в [AGENTS.md](AGENTS.md). Здесь — как запустить и собрать.

## Стек

- **Expo SDK 57**, React Native 0.86, React 19, TypeScript 6
- **expo-router** — экраны = файлы в `src/app`; системные вкладки
  (`NativeTabs`) и системные шапки. На iOS 26 панель вкладок — «жидкое
  стекло», на Android — Material
- Свой набор компонентов в `src/components`, системный шрифт, светлая и
  тёмная тема по системе (или выбранная в профиле)
- **Zustand** — токен, профиль, избранное, тема
- **axios** — Bearer, 401 → выход, 5xx → `/front-error`
- **i18next** — русский и казахский
- **expo-secure-store** (JWT), **expo-image**, **expo-image-picker**,
  **expo-location**

Минимальные системы: iOS 16.4, Android 7 (API 24).

## Запуск для разработки

Expo Go не подходит: нужен dev-клиент (сборка `development`) или веб.

```bash
cd stroyapp-front
npm install
npm start          # dev-клиент на телефоне, QR в консоли
npm run web        # быстрый просмотр в браузере
```

Адрес бэка берётся из `extra.apiBaseUrl` в `app.json` (прод:
`https://api.stroyapp.kz`). Для локального бэка его не правят, а задают
переменную окружения:

```bash
EXPO_PUBLIC_API_URL=http://192.168.X.X:4000 npm start
```

Локальный бэк: `cd stroyapp-back && python main.py`. В dev-режиме код из SMS
всегда `0000`.

Веб-превью — только для проверки вёрстки и логики: вкладки там рисуются
полосой сверху, `Alert.alert` ничего не показывает, стекла нет.

## Структура

```
stroyapp-front/
├── app.json                 конфигурация Expo (плагины, разрешения, EAS Update)
├── eas.json                 профили сборки: development / preview / production
├── src/
│   ├── app/                 экраны (expo-router)
│   │   ├── _layout.tsx      корень: тема, вход, стек
│   │   ├── (tabs)/          Поиск, Избранное, Сообщения, Профиль
│   │   └── *.tsx            экраны над вкладками: hall, provider, chat, …
│   ├── components/          кнопки, поля, карточки, шторки, календарь, галерея
│   ├── theme/               цвета, размеры, useColors / useThemedStyles
│   ├── api/                 axios + эндпоинты с типами
│   ├── store/               zustand: auth, favorites, theme, шторка входа
│   ├── i18n/                ru.json, kz.json
│   ├── config/              адрес API
│   └── utils/               форматирование, телефон, фото, навигация
├── assets/                  иконки, заставка, материалы для магазинов
└── scripts/                 скриншоты для магазинов: capture_store_shots.cjs, make_store_assets.py
```

## Проверка

```bash
npm run typecheck      # tsc --noEmit
npx expo-doctor        # версии пакетов и конфигурация
npx expo export        # собирается ли бандл под все платформы
```

## Сборки

Аккаунт EAS `damirrisbekov`, проект `stroyapp`. Глобальный `eas` может быть
старым — запускать через `npx eas-cli@latest`.

```bash
# APK для установки на телефон (внутреннее тестирование)
npx eas-cli@latest build --platform android --profile preview

# Магазины: AAB для Google Play и сборка для TestFlight
npx eas-cli@latest build --platform android --profile production
npx eas-cli@latest build --platform ios --profile production --auto-submit
```

Номер сборки увеличивается сам (`autoIncrement`), версия — `expo.version` в
`app.json`.

### Обновления без пересборки (EAS Update)

Правки только в JS/TS, переводах и картинках можно доставить в уже
установленные сборки той же версии приложения:

```bash
npx eas-cli@latest update --channel preview --message "что изменилось"
npx eas-cli@latest update --channel production --message "что изменилось"
```

Новая нативная зависимость, плагин или разрешение в `app.json` — только
новая сборка и новая версия (`runtimeVersion` привязан к версии приложения).

## Скриншоты для магазинов

Готовые картинки — в `assets/store/`: `app-store/ru` (1290×2796),
`app-store-6.3/ru` (1206×2622), `google-play/ru` и `google-play/kk`
(1080×1920). Собираются в два шага:

```bash
# 1. Снять экраны из веб-превью (нужны локальный бэк с данными и npm run web)
npm i --no-save puppeteer-core
node scripts/capture_store_shots.cjs ru ios      # ru | kk, ios | android

# 2. Добавить рамку телефона и подписи
python scripts/make_store_assets.py
```

Что и от чьего имени снимать, задаётся переменными окружения — см. `CONFIG`
в начале `capture_store_shots.cjs`. Подписи — в словаре `CAPTIONS` в
`make_store_assets.py`. Сырые снимки (`assets/store/raw/`) в репозиторий не
кладём; вместо снятых из веба туда можно положить скриншоты с телефона под
теми же именами.

Материал заголовка для App Store (вкладка «Заголовок и результаты поиска») —
`assets/store/app-store-header/ru/`, собирается из тех же сырых снимков:

```bash
python scripts/make_store_header.py            # 5244×2950 и 3840×1646
python scripts/make_store_header.py --compact  # ещё и вариант с мелкими карточками
```

Рядом, в `assets/store/preview/`, скрипт кладёт прикидку, как картинка встанет
на странице приложения и в поиске.

## Push-уведомления

Не включены: регистрация устройства из приложения не вызывается, бэк при
событиях пишет `Push skipped`. В описаниях для магазинов уведомления не
обещаем.

## Удаление аккаунта

Профиль → «Удалить аккаунт» (`DELETE /profile`). Страница для магазинов:
`https://api.stroyapp.kz/account-deletion`.
