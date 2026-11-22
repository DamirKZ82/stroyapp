import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * Открыта ли клавиатура. На iOS слушаем «will», чтобы отступ сменился
 * вместе с началом её движения, а не рывком после; на Android таких
 * событий нет — только «did».
 */
export function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setShown(true));
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}
