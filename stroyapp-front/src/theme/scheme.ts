import { useEffect, useMemo } from 'react';
import { Appearance, Platform, useColorScheme } from 'react-native';

import { useThemeStore, type ThemeMode } from '@/store/themeStore';
import { darkColors, lightColors, type ThemeColors } from './index';

/**
 * Какая тема сейчас на экране.
 *
 * Выбор хранит themeStore: «как в системе», светлая или тёмная. По
 * умолчанию — как в системе, поэтому приложение темнеет вместе с телефоном.
 */
export function useScheme(): {
  mode: ThemeMode;
  dark: boolean;
  colors: ThemeColors;
  setMode: (mode: ThemeMode) => Promise<void>;
} {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const system = useColorScheme();
  const dark = mode === 'system' ? system === 'dark' : mode === 'dark';
  return { mode, dark, colors: dark ? darkColors : lightColors, setMode };
}

export function useColors(): ThemeColors {
  return useScheme().colors;
}

/**
 * Стили, зависящие от темы.
 *
 * makeStyles объявляется на уровне модуля (внизу файла), а не внутри
 * компонента: иначе функция новая на каждый рендер и стили пересоздаются.
 */
export function useThemedStyles<T>(make: (colors: ThemeColors) => T): T {
  const colors = useColors();
  return useMemo(() => make(colors), [make, colors]);
}

/**
 * Ручной выбор темы доезжает и до системных элементов.
 *
 * Панель вкладок, шапки, клавиатура и Alert рисует система, и смотрят они
 * на системную тему, а не на наши цвета. Без этого «тёмная» в профиле при
 * светлом телефоне давала тёмные экраны под светлой панелью.
 * Вызывается один раз, в корневом макете.
 */
export function useSyncNativeScheme(): void {
  const mode = useThemeStore((s) => s.mode);
  useEffect(() => {
    // В браузере (expo start --web) этого метода нет — там просто не зовём.
    if (Platform.OS === 'web' || typeof Appearance.setColorScheme !== 'function') return;
    Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode);
  }, [mode]);
}
