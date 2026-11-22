import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';

import { chatsApi } from '@/api';
import { useIsAuthed } from '@/store/useRequireAuth';
import { useColors } from '@/theme/scheme';

const UNREAD_POLL_MS = 15000;

/**
 * На iOS система сама добавляет первому списку вкладки отступ под панель —
 * но только если список есть в первом же кадре. У поиска, избранного и
 * профиля он есть, у сообщений сначала вертушка или экран гостя, и отступ
 * выходил бы разным: где-то двойным (свой TAB_BOTTOM плюс системный),
 * где-то одинарным. Отключаем системный и держим один свой запас из Screen.
 * На Android то же свойство убрало бы обёртку, которая поднимает содержимое
 * над панелью, поэтому там оно остаётся выключенным.
 */
const OWN_INSETS = Platform.OS === 'ios';

/**
 * Нижние вкладки.
 *
 * Вкладки системные, а не нарисованные: настоящий UITabBar на iOS и
 * BottomNavigationView на Android. На iOS 26 панель сама становится
 * «жидким стеклом» и сворачивается при прокрутке — рисовать это руками
 * пришлось бы заново после каждого обновления системы.
 *
 * Плата за это: высоту панели, цвет неактивных вкладок на iOS 26 и вид
 * бейджа задаёт система. Непрочитанные — обычный системный бейдж с числом
 * чатов: пустой бейдж диктор не читает, и вкладка звучала бы одинаково с
 * новыми сообщениями и без них.
 *
 * Значки заданы дважды: SF Symbols для iOS, Material для Android. У каждого
 * пара «обычный и выбранный»: контур превращается в заливку.
 */
export default function TabsLayout() {
  const { t } = useTranslation();
  const colors = useColors();
  const unread = useUnreadChats();

  // На Android панель по умолчанию красится в цвета обоев (Material You) —
  // рядом с фирменным зелёным это выглядит чужим. На iOS фон панели рисует
  // система, и там эти свойства не нужны.
  const android =
    Platform.OS === 'android'
      ? {
          backgroundColor: colors.card,
          indicatorColor: `${colors.primary}22`,
          rippleColor: `${colors.primary}22`,
          iconColor: { default: colors.muted, selected: colors.primary },
          labelStyle: {
            default: { color: colors.muted },
            selected: { color: colors.primary },
          },
        }
      : {};

  return (
    <NativeTabs
      tintColor={colors.primary}
      // Цвет цифр бейджа на iOS не задаётся: UIKit рисует их белыми, а белое
      // на нашем оранжевом не читается (в тёмной теме около 2:1). Там фон
      // остаётся системным красным, под который белые цифры и подобраны.
      badgeBackgroundColor={Platform.OS === 'ios' ? undefined : colors.accent}
      badgeTextColor={colors.onAccent}
      minimizeBehavior="onScrollDown"
      labelVisibilityMode="labeled"
      backBehavior="initialRoute"
      {...android}
    >
      <NativeTabs.Trigger name="index" disableAutomaticContentInsets={OWN_INSETS}>
        <NativeTabs.Trigger.Label>{t('tabs.search')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="favorites" disableAutomaticContentInsets={OWN_INSETS}>
        <NativeTabs.Trigger.Label>{t('tabs.favorites')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'heart', selected: 'heart.fill' }}
          md={{ default: 'favorite_border', selected: 'favorite' }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="messages" disableAutomaticContentInsets={OWN_INSETS}>
        <NativeTabs.Trigger.Label>{t('tabs.messages')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'bubble.left', selected: 'bubble.left.fill' }}
          md={{ default: 'chat_bubble_outline', selected: 'chat_bubble' }}
        />
        {/* Прячем через hidden у бейджа, а не у вкладки: скрытие вкладки
            пересоздаёт навигатор и сбрасывает открытые экраны. Текст при нуле
            не передаём вовсе: бейдж с текстом показывается и при hidden, и на
            вкладке висел бы «0». */}
        <NativeTabs.Trigger.Badge hidden={unread === 0}>
          {unread > 0 ? badgeText(unread) : undefined}
        </NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="profile" disableAutomaticContentInsets={OWN_INSETS}>
        <NativeTabs.Trigger.Label>{t('tabs.profile')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'person', selected: 'person.fill' }}
          md={{ default: 'person_outline', selected: 'person' }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

/** Трёхзначное число в кружок бейджа не помещается и растягивает его. */
const badgeText = (count: number) => (count > 99 ? '99+' : String(count));

/**
 * Число чатов с непрочитанным — для бейджа на вкладке.
 *
 * Опрос живёт здесь, а не в экране чатов: макет вкладок остаётся
 * смонтированным и под открытыми экранами, так что бейдж обновляется, даже
 * пока человек сидит в карточке зала.
 */
function useUnreadChats(): number {
  // Вход закончен, а не просто есть токен: у того, кто не принял условия,
  // вкладка «Сообщения» гостевая, и число на ней с этим спорило бы.
  const authed = useIsAuthed();
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try {
      const answer = await chatsApi.unreadCount();
      setUnread(answer.unread_count);
    } catch {
      // Сеть пропадает постоянно; бейдж — не повод показывать ошибку.
    }
  }, []);

  useEffect(() => {
    if (!authed) {
      setUnread(0);
      return;
    }
    void load();
    const id = setInterval(() => void load(), UNREAD_POLL_MS);
    return () => clearInterval(id);
  }, [authed, load]);

  return unread;
}
