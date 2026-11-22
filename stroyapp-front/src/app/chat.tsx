import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItem,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { ApiError, chatsApi, peerBlocksApi, type ChatDetails, type ChatMessage } from '@/api';
import { Button } from '@/components/Button';
// Под своим именем: Row в этом файле — строка ленты сообщений.
import { Row as MenuRow } from '@/components/Card';
import { EmptyState, ErrorBanner, Loader, useAnnounce } from '@/components/Feedback';
import { Sheet } from '@/components/Sheet';
import { Thumb } from '@/components/Thumb';
import { HIT, radius, space, text, type ThemeColors } from '@/theme';
import { useColors, useThemedStyles } from '@/theme/scheme';
import { confirmDestructive } from '@/utils/alert';
import { bookingStatusTone } from '@/utils/bookingStatus';
import { formatDateHuman, formatPrice } from '@/utils/format';
import { useLang } from '@/utils/lang';
import { pushOnce, useOnTop } from '@/utils/nav';
import { serverStamp, serverToday } from '@/utils/serverTime';
import { useKeyboardShown } from '@/utils/useKeyboardShown';
import { useSafeBottomInset } from '@/utils/useSafeBottomInset';

/** Чаще, чем список чатов: это «горячий» экран, ответа здесь ждут. */
const POLL_INTERVAL_MS = 4000;

/** Сервер отклоняет сообщение длиннее: лучше не дать набрать, чем вернуть ошибку. */
const MESSAGE_MAX = 2000;

/** Отступ вокруг поля ввода; он же — низ полосы, когда открыта клавиатура. */
const COMPOSER_PAD = 8;

type Row =
  | { kind: 'msg'; key: string; msg: ChatMessage; pending: boolean }
  | { kind: 'day'; key: string; label: string };

/**
 * Что стоит на месте поля ввода, когда писать нельзя:
 *   mine   — собеседника заблокировал я сам: пояснение и «Разблокировать»;
 *   closed — писать нельзя не из-за меня: одна нейтральная строка. Кто закрыл
 *            переписку, сервер не говорит — и мы не домысливаем.
 *
 * Решают только флаги из ответа сервера, а не код ответа на отправку и не то,
 * что нажали на этом экране: блокируют человека, а не чат, и поставить или
 * снять блокировку могли в другой переписке с ним. Сравнение строгое: сервер
 * старше блокировок этих полей не шлёт, и это значит «писать можно».
 */
function peerBarOf(chat: ChatDetails['chat']): 'mine' | 'closed' | null {
  if (chat.peer_block_by_me === true) return 'mine';
  if (chat.can_write === false) return 'closed';
  return null;
}

/**
 * Переписка с владельцем или клиентом.
 *
 * Сверху — карточка зала или исполнителя, о котором идёт разговор, и рядом
 * меню: пожаловаться на собеседника или заблокировать его. Под ними
 * сообщения, внизу поле ввода — или строка о том, что писать нельзя, если
 * собеседник заблокирован. Новые сообщения и сама блокировка приходят опросом
 * раз в несколько секунд, пока экран открыт.
 *
 * Рамка своя, а не Screen: полоса ввода — не кнопки в footer, ей нужен свой
 * отступ снизу, зависящий от клавиатуры.
 *
 * Гостя здесь не бывает: экран стоит под Stack.Protected, и при выходе (сам
 * или по ответу 401) стек убирает его вместе с перепиской.
 */
export default function ChatScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const safeBottom = useSafeBottomInset();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const keyboardShown = useKeyboardShown();
  const { chatGuid } = useLocalSearchParams<{ chatGuid?: string }>();

  const [details, setDetails] = useState<ChatDetails | null>(null);
  const [loading, setLoading] = useState(true);
  // Ошибки две, потому что живут по-разному: сбой загрузки снимает первый
  // же удачный круг опроса, а сбой отправки должен дождаться, пока человек
  // его прочтёт, — до следующей попытки.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Сообщение, которое уже показано, но ещё не подтверждено сервером.
  const [pending, setPending] = useState<ChatMessage | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Идёт запрос блокировки собеседника или её снятия.
  const [blockBusy, setBlockBusy] = useState(false);
  // Сбой этого запроса. Отдельно от sendError: отказ в отправке над полосой о
  // блокировке не показывается, а этот должен быть виден и там — иначе было
  // бы непонятно, почему «Разблокировать» или блокировка в ответ не сработали.
  const [blockError, setBlockError] = useState<string | null>(null);
  // Что сказать экранному диктору о том, что зрячему видно и так: после
  // «Разблокировать» полоса с кнопкой сменяется полем ввода, фокус диктора
  // остаётся на исчезнувшей кнопке, и без слов он не узнал бы, что блокировка
  // снята.
  const [notice, setNotice] = useState<string | null>(null);

  const listRef = useRef<FlatList<Row>>(null);
  // Номер последнего запроса: ответ с более старым номером уже неактуален.
  const seq = useRef(0);
  // Номер запроса, который сейчас в пути (0 — никакого): опрос не шлёт
  // второй запрос, пока не вернулся первый, иначе на плохой связи они
  // копятся — до пяти штук за время ожидания одного.
  const inFlight = useRef(0);
  // Замок, а не только состояние: два быстрых нажатия успевают пройти до
  // перерисовки кнопки, и сообщение ушло бы дважды.
  const sendLock = useRef(false);
  // Последний показанный ответ сервера. Опрос почти всегда приносит то же
  // самое, и без сравнения список перерисовывался бы каждые четыре секунды.
  const lastSig = useRef('');
  // Замок блокировки и её снятия — тоже замок, а не только состояние, по той
  // же причине, что и sendLock. Пока он стоит, опрос молчит: его ответ собран
  // до действия и на один круг вернул бы на экран прежнее состояние.
  const blockLock = useRef(false);
  // Перед глазами ли ещё чат: после блокировки экран закрывается, а
  // router.back() закрывает верхний экран, каким бы он ни был, — если за
  // время запроса открыли объявление, закрылось бы оно.
  const onTop = useOnTop();

  const load = useCallback(
    async (background: boolean) => {
      if (!chatGuid) return;
      if (background && (inFlight.current !== 0 || sendLock.current || blockLock.current)) return;
      const ticket = ++seq.current;
      inFlight.current = ticket;
      if (!background) setLoadError(null);
      try {
        const d = await chatsApi.get(chatGuid);
        // Пока сообщение отправляется, ответ опроса не применяем: в нём
        // может уже быть это сообщение, и оно показалось бы дважды — рядом
        // со своей ещё не подтверждённой копией. С блокировкой так же: ответ,
        // собранный до неё, показал бы прежнее состояние.
        if (ticket !== seq.current || sendLock.current || blockLock.current) return;
        setLoadError(null);
        const sig = JSON.stringify(d);
        if (sig !== lastSig.current) {
          lastSig.current = sig;
          setDetails(d);
          // Переписка закрыта блокировкой — отказ в последней отправке больше
          // не нужен: полоса внизу говорит то же самое. Над ней он и так не
          // показывается, но, оставшись в состоянии, вернулся бы над полем
          // ввода, когда блокировку снимут.
          if (peerBarOf(d.chat)) setSendError(null);
        }
        // Запрос только когда есть что отмечать: опрос идёт постоянно, и
        // иначе каждый его круг был бы двумя запросами.
        if (d.chat.unread_count > 0) {
          chatsApi.markRead(chatGuid).catch(() => {
            // Не страшно: отметим на следующем круге опроса.
          });
        }
      } catch (e) {
        if (ticket !== seq.current) return;
        // Сбой тихого опроса не показываем: следующий круг через 4 секунды.
        if (!background) setLoadError(e instanceof ApiError ? e.message : t('common.error_generic'));
      } finally {
        if (inFlight.current === ticket) inFlight.current = 0;
        // Только последний запрос снимает загрузку: «Повторить» запускает
        // новый поверх ещё не вернувшегося опроса, и тот, вернувшись первым,
        // показал бы экран ошибки на время до настоящего ответа.
        if (ticket === seq.current) setLoading(false);
      }
    },
    [chatGuid, t],
  );

  useFocusEffect(
    useCallback(() => {
      if (!chatGuid) return;
      void load(false);
      // Свёрнутое приложение не опрашиваем: кроме лишних запросов, опрос
      // пометил бы прочитанным сообщение, которого человек ещё не видел.
      const timer = setInterval(() => {
        if (AppState.currentState === 'active') void load(true);
      }, POLL_INTERVAL_MS);
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') void load(true);
      });
      return () => {
        clearInterval(timer);
        sub.remove();
      };
    }, [chatGuid, load]),
  );

  const retry = () => {
    setLoading(true);
    void load(false);
  };

  const send = async () => {
    const value = draft.trim();
    if (!value || !chatGuid || sendLock.current) return;
    sendLock.current = true;
    setSendError(null);
    setBlockError(null);
    // Сообщение появляется в ленте сразу, не дожидаясь сервера: на
    // медленной связи иначе кажется, что кнопка не сработала.
    setDraft('');
    setPending({
      guid: `local-${Date.now()}`,
      text: value,
      sender_id: 0,
      is_mine: true,
      created_at: serverStamp(),
      read_at: null,
    });
    // Если человек читал историю выше — показать ему его же сообщение.
    // В перевёрнутом списке ноль — это низ.
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    let failed = false;
    try {
      const { message } = await chatsApi.send(chatGuid, value);
      // Опросы, ушедшие до ответа, вернутся без этого сообщения и стёрли бы
      // его на один круг — обнуляем их.
      seq.current += 1;
      lastSig.current = '';
      setDetails((prev) =>
        prev && !prev.messages.some((m) => m.guid === message.guid)
          ? {
              ...prev,
              messages: [...prev.messages, message],
              chat: {
                ...prev.chat,
                last_message_at: message.created_at,
                last_message_preview: message.text.slice(0, 100),
              },
            }
          : prev,
      );
    } catch (e) {
      setSendError(e instanceof ApiError ? e.message : t('common.error_generic'));
      // Текст возвращаем в поле, чтобы не набирать заново, — но не поверх
      // того, что человек уже успел начать писать следом.
      setDraft((current) => (current.trim() ? current : value));
      failed = true;
    } finally {
      setPending(null);
      sendLock.current = false;
    }
    // После отказа перечитываем чат: если переписку только что закрыли
    // блокировкой, на месте поля ввода должна встать полоса. По коду ответа
    // этого не узнать — 403 приходит и аккаунту, заблокированному админом, —
    // решают флаги чата. Здесь, а не в catch: там ещё стоит замок отправки, и
    // load ничего бы не запросил.
    if (failed) void load(true);
  };

  // Список перевёрнут (inverted): первый элемент данных рисуется внизу.
  // Поэтому строки собираем в обычном порядке — дата, затем сообщения этого
  // дня — и разворачиваем целиком: дата оказывается после сообщений в
  // данных и, значит, над ними на экране.
  const rows = useMemo<Row[]>(() => {
    if (!details) return [];
    // Время сообщений показываем как пришло, в поясе сервера, — значит, и
    // «сегодня» считаем в нём же, а не по часам телефона.
    const today = serverToday();
    const yesterday = serverToday(1);
    const list: Row[] = [];
    let lastDate = '';
    const add = (msg: ChatMessage, isPending: boolean) => {
      const date = msg.created_at.slice(0, 10);
      if (date !== lastDate) {
        lastDate = date;
        const label =
          date === today
            ? t('messages.today')
            : date === yesterday
              ? t('messages.yesterday')
              : formatDateHuman(date, lang);
        // Ключ от сообщения, а не от даты: он не меняется, когда снизу
        // добавляются новые строки, и не повторится, даже если сервер
        // вернёт сообщения не по порядку.
        list.push({ kind: 'day', key: `day-${msg.guid}`, label });
      }
      list.push({ kind: 'msg', key: msg.guid, msg, pending: isPending });
    };
    for (const m of details.messages) add(m, false);
    if (pending) add(pending, true);
    return list.reverse();
  }, [details, pending, lang, t]);

  const otherName = details?.chat.other_user.name ?? '';

  const renderItem = useCallback<ListRenderItem<Row>>(
    ({ item }) => {
      if (item.kind === 'day') {
        return (
          <View style={styles.day}>
            <Text style={styles.dayText}>{item.label}</Text>
          </View>
        );
      }
      const { msg } = item;
      const time = msg.created_at.slice(11, 16);
      // Для диктора сообщение — один элемент с автором: на экране своё от
      // чужого отличают только сторона и цвет, а текст и время по отдельности
      // он читал бы двумя безымянными строками. У собеседника без имени
      // подписи нет — своё всё равно отличает «Вы».
      const sender = msg.is_mine ? t('messages.you') : otherName;
      return (
        <View
          accessible
          accessibilityLabel={`${sender ? `${sender}: ` : ''}${msg.text}, ${time}`}
          style={[
            styles.msg,
            msg.is_mine ? styles.msgMine : styles.msgOther,
            item.pending && styles.msgPending,
          ]}
        >
          <View style={[styles.bubble, msg.is_mine ? styles.bubbleMine : styles.bubbleOther]}>
            <Text style={[styles.bubbleText, msg.is_mine && styles.bubbleTextMine]}>{msg.text}</Text>
          </View>
          <Text style={styles.time}>{time}</Text>
        </View>
      );
    },
    [styles, otherName, t],
  );

  const keyExtractor = useCallback((row: Row) => row.key, []);

  const title = otherName || t('messages.chat_title');

  const peerBar = details ? peerBarOf(details.chat) : null;
  const peerBarText =
    peerBar === 'mine' ? t('peer_block.mine') : peerBar === 'closed' ? t('peer_block.closed') : null;
  // Сначала — что блокировка снята, потом — что стало с полем ввода: если
  // собеседник заблокировал в ответ, после «Разблокировать» встаёт строка
  // «написать нельзя», и в таком порядке это понятно.
  useAnnounce(notice);
  // Полоса встаёт сама, по ответу опроса: фокус диктора в это время где
  // угодно, и без объявления незрячий не узнал бы, куда делось поле ввода.
  useAnnounce(peerBarText);

  // Одна рамка на все состояния — с той же шапкой, иначе она мигает при
  // переходе от загрузки к переписке.
  const frame = (children: ReactNode) => (
    <SafeAreaView style={styles.screen} edges={[]}>
      <Stack.Screen options={{ headerShown: true, title }} />
      {children}
    </SafeAreaView>
  );

  if (!chatGuid) {
    return frame(
      <View style={styles.problem}>
        <ErrorBanner message={t('common.error_generic')} />
      </View>,
    );
  }

  if (loading) return frame(<Loader />);

  if (!details) {
    return frame(
      <View style={styles.problem}>
        <ErrorBanner message={loadError ?? t('common.error_generic')} />
        <Button label={t('common.retry')} variant="outline" onPress={retry} />
      </View>,
    );
  }

  const { subject, provider, booking } = details.chat;
  const subjectGuid = subject.guid;
  const price = provider?.price_from ?? null;
  const canSend = draft.trim().length > 0 && pending === null;
  // Отказ в отправке над полосой о блокировке не показываем: он говорит то же
  // самое, только словами сервера и всегда по-русски, — и когда переписку
  // закрыл собеседник, и когда человек заблокировал его сам, но с другого
  // устройства. Сбой блокировки показываем и там: иначе было бы непонятно,
  // почему ничего не произошло.
  const problem = blockError ?? (peerBar ? loadError : (sendError ?? loadError));

  const openSubject = () => {
    if (!subjectGuid) return;
    // fromChat — чтобы «Написать» на открытой карточке вернуло в этот чат,
    // а не положило поверх вторую его копию.
    pushOnce({ pathname: '/provider', params: { providerGuid: subjectGuid, fromChat: chatGuid } });
  };

  const dismissMode = Platform.OS === 'ios' ? 'interactive' : 'on-drag';

  // Гостя здесь не бывает, вход спрашивать не нужно. Сами сообщения к жалобе
  // не уходят: форма просит описать случившееся словами.
  const report = () => {
    // Клавиатура переписки на форме жалобы не нужна: поле там ещё не выбрано.
    Keyboard.dismiss();
    pushOnce({
      pathname: '/report',
      params: { targetType: 'chat', targetGuid: chatGuid, subjectName: otherName || subject.name },
    });
  };

  const openMenu = () => {
    // Иначе шторка встала бы на клавиатуру.
    Keyboard.dismiss();
    setMenuOpen(true);
  };

  const reportFromMenu = () => {
    setMenuOpen(false);
    report();
  };

  const doBlock = async () => {
    if (blockLock.current) return;
    blockLock.current = true;
    setBlockBusy(true);
    setSendError(null);
    setBlockError(null);
    try {
      await peerBlocksApi.block(chatGuid);
      // Опросы, ушедшие до ответа, вернулись бы с прежними флагами — обнуляем
      // их, как после отправки.
      seq.current += 1;
      lastSig.current = '';
      if (onTop.current) {
        // Ни окна «заблокировано», ни правки состояния на месте: экран
        // закрывается, а чат пропадает из списка — это и есть подтверждение.
        router.back();
      } else {
        // С экрана ушли — закрывать нечего. Перечитываем, чтобы к возвращению
        // здесь уже стояла полоса с «Разблокировать». Замок снимаем до
        // запроса: load отбрасывает ответ, пришедший под замком.
        blockLock.current = false;
        void load(false);
      }
    } catch (e) {
      // В полосу над полем ввода, а не окном: она видна и в веб-просмотре, и
      // диктор её объявит.
      setBlockError(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      blockLock.current = false;
      setBlockBusy(false);
    }
  };

  const confirmBlock = () => {
    setMenuOpen(false);
    confirmDestructive(
      t('peer_block.confirm_title'),
      t('peer_block.confirm_text'),
      () => void doBlock(),
      t('peer_block.confirm_yes'),
    );
  };

  // Без подтверждения: снять блокировку — не то, о чём потом жалеют, и её
  // можно тут же поставить снова.
  const unblock = async () => {
    if (blockLock.current) return;
    blockLock.current = true;
    setBlockBusy(true);
    setSendError(null);
    setBlockError(null);
    // Сброс — чтобы то же объявление прозвучало и во второй раз: одинаковый
    // текст подряд диктору не повторяют.
    setNotice(null);
    try {
      await peerBlocksApi.unblock(chatGuid);
      seq.current += 1;
      lastSig.current = '';
      // До перечитывания, а не после: объявление о снятой блокировке должно
      // прозвучать раньше, чем о том, что встало на место полосы.
      setNotice(t('peer_block.unblocked'));
      // Состояние не правим на месте, а перечитываем: собеседник мог
      // заблокировать в ответ, и тогда писать по-прежнему нельзя — это знает
      // только сервер. Замок снимаем до запроса (load отбрасывает ответ,
      // пришедший под замком), а кнопка остаётся занятой до самого ответа.
      blockLock.current = false;
      await load(false);
    } catch (e) {
      setBlockError(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      blockLock.current = false;
      setBlockBusy(false);
    }
  };

  const unblockFromMenu = () => {
    setMenuOpen(false);
    void unblock();
  };

  return frame(
    // Поправка на высоту шапки: экран под шапкой начинается не с нуля, а
    // KeyboardAvoidingView считает от верха окна. На Android отступ нужен
    // тоже: окно там от края до края (с Android 15 это не отключить), и
    // система его под клавиатуру уже не сжимает, несмотря на
    // softwareKeyboardLayoutMode: resize, — поле ввода осталось бы под ней.
    // Там, где окно всё же сжалось, отступ сам выходит нулевым.
    <KeyboardAvoidingView
      style={styles.flex}
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      {/* Верхняя полоса: объявление, о котором переписка, и «Действия» —
          пожаловаться на собеседника или заблокировать его. Кнопка здесь, а
          не в списке сообщений: она должна быть на виду и в длинной
          переписке, и в пустой. Стоит рядом с карточкой, а не внутри неё:
          иначе нажатие открывало бы объявление. */}
      <View style={styles.top}>
        {/* Удалённый зал или исполнитель приходит без guid: открывать нечего,
            карточку не показываем — переписка при этом остаётся. */}
        {subjectGuid ? (
          <Pressable
            onPress={openSubject}
            accessibilityRole="button"
            style={({ pressed }) => [styles.subject, pressed && styles.subjectPressed]}
          >
            <Thumb path={subject.main_thumb} size={56} />
            <View style={styles.subjectBody}>
              <Text style={styles.subjectName} numberOfLines={1}>
                {subject.name}
              </Text>
              {price !== null ? (
                <Text style={styles.subjectPrice} numberOfLines={1}>
                  {t('provider.price_from', { price: formatPrice(price) })}
                </Text>
              ) : null}
              {booking ? (
                // Две строки: длинный статус вместе с датой в одну на узком
                // экране не помещается, а обрезанной оказалась бы именно дата.
                <Text
                  style={[styles.subjectStatus, { color: colors[bookingStatusTone(booking.status)] }]}
                  numberOfLines={2}
                >
                  {t('messages.booking_status', { status: t(`bookings.status_${booking.status}`) })}
                  {' · '}
                  {formatDateHuman(booking.event_date, lang)}
                </Text>
              ) : (
                <Text style={styles.subjectGo} numberOfLines={1}>
                  {t('messages.go_to_provider')}
                </Text>
              )}
            </View>
            {/* Стрелка — украшение, как у Row: подпись кнопки Android собирает
                из детей, и символ шрифта прочёлся бы в ней непонятным знаком.
                На iOS сборщик подписи пропускает только accessibilityElementsHidden,
                accessible={false} там не помогает. */}
            <Icon
              name="chevron-right"
              size={20}
              color={colors.muted}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          </Pressable>
        ) : (
          <View style={styles.flex} />
        )}
        {/* Одна кнопка, а не два значка: блокировку за безымянным значком
            нажимали бы по ошибке, да и двум квадратам рядом с карточкой
            тесно. В шторке у каждого действия есть подпись. */}
        {subjectGuid ? (
          <Pressable
            onPress={openMenu}
            disabled={blockBusy}
            accessibilityRole="button"
            accessibilityLabel={t('peer_block.menu')}
            accessibilityState={{ disabled: blockBusy, busy: blockBusy }}
            style={({ pressed }) => [styles.more, pressed && styles.pressed]}
          >
            {/* Вертушка на месте значка: шторка и окно подтверждения к этому
                времени закрыты, и на медленной связи больше ничто не говорит,
                что блокировка в пути. */}
            {blockBusy ? (
              <ActivityIndicator color={colors.muted} />
            ) : (
              <Icon name="dots-vertical" size={22} color={colors.muted} />
            )}
          </Pressable>
        ) : (
          // Карточки нет — место есть: кнопка с подписью понятнее одного значка.
          <Button
            label={t('peer_block.menu')}
            variant="text"
            icon="dots-vertical"
            small
            busy={blockBusy}
            onPress={openMenu}
          />
        )}
      </View>

      {rows.length === 0 ? (
        // Пустое состояние — вне списка: FlatList переворачивает и свой
        // ListEmptyComponent, и текст в нём стоял бы вверх ногами.
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.emptyContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={dismissMode}
        >
          <EmptyState title={t('messages.no_messages_yet')} />
        </ScrollView>
      ) : (
        // Перевёрнутый список сам держится у последнего сообщения — и при
        // открытии, и когда приходит новое, и когда поднимается клавиатура.
        <FlatList
          ref={listRef}
          style={styles.flex}
          inverted
          data={rows}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={dismissMode}
        />
      )}

      {problem ? (
        <View style={styles.problemBar}>
          <ErrorBanner message={problem} />
        </View>
      ) : null}

      {/* С открытой клавиатурой отступ под вырез не нужен: полоса стоит на
          клавиатуре, и он был бы пустым местом между ними. */}
      <View
        style={[
          styles.composer,
          { paddingBottom: keyboardShown ? COMPOSER_PAD : Math.max(safeBottom, COMPOSER_PAD) },
        ]}
      >
        {peerBar ? (
          // Пояснение стоит в той же полосе, что и поле ввода, а не отдельным
          // блоком: низ экрана не меняет ни цвета, ни высоты, когда писать
          // становится нельзя, — а это случается и при открытом чате, по
          // ответу опроса. Черновик не трогаем: он в состоянии экрана и
          // вернётся в поле, когда блокировку снимут.
          <View style={styles.peerBar}>
            <Text style={[styles.peerText, peerBar === 'closed' && styles.peerTextAlone]}>
              {peerBarText}
            </Text>
            {peerBar === 'mine' ? (
              <Button
                label={t('peer_block.unblock')}
                variant="outline"
                small
                busy={blockBusy}
                onPress={() => void unblock()}
              />
            ) : null}
          </View>
        ) : (
          <>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={t('messages.placeholder')}
              placeholderTextColor={colors.muted}
              accessibilityLabel={t('messages.placeholder')}
              multiline
              maxLength={MESSAGE_MAX}
              style={styles.input}
            />
            <Pressable
              onPress={send}
              disabled={!canSend}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel={t('messages.send')}
              accessibilityState={{ disabled: !canSend, busy: pending !== null }}
              style={({ pressed }) => [styles.send, !canSend && styles.sendOff, pressed && styles.pressed]}
            >
              <Icon name="send" size={20} color={colors.onPrimary} />
            </Pressable>
          </>
        )}
      </View>

      <Sheet
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={otherName || t('peer_block.menu')}
      >
        <View style={styles.menu}>
          <MenuRow
            first
            title={t('report.link_chat')}
            icon="flag-outline"
            onPress={reportFromMenu}
          />
          {/* Пустой элемент справа — чтобы не было стрелки: эти строки никуда
              не ведут. Просто null её не убирает. */}
          {peerBar === 'mine' ? (
            <MenuRow
              title={t('peer_block.unblock')}
              icon="account-lock-open-outline"
              right={<View />}
              onPress={unblockFromMenu}
            />
          ) : (
            <MenuRow
              danger
              title={t('peer_block.block')}
              icon="account-cancel-outline"
              right={<View />}
              onPress={confirmBlock}
            />
          )}
        </View>
      </Sheet>
    </KeyboardAvoidingView>,
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    problem: { padding: space.page, gap: space.gap },

    top: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: HIT,
      backgroundColor: colors.card,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    subject: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.gap,
      minHeight: HIT,
      paddingLeft: space.page,
      paddingVertical: 10,
    },
    // Квадрат под палец: сам значок маленький.
    more: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    subjectPressed: { backgroundColor: colors.background },
    subjectBody: { flex: 1, minWidth: 0, gap: 2 },
    subjectName: { fontSize: text.body, fontWeight: '600', color: colors.text },
    subjectPrice: { fontSize: text.caption, fontWeight: '600', color: colors.primary },
    subjectStatus: { fontSize: text.caption, fontWeight: '500' },
    subjectGo: { fontSize: text.caption, fontWeight: '500', color: colors.primary },

    emptyContent: { flexGrow: 1 },
    listContent: { paddingHorizontal: space.page, paddingVertical: space.gap },

    day: { alignItems: 'center', marginVertical: 8 },
    dayText: {
      fontSize: 13,
      fontWeight: '500',
      color: colors.muted,
      backgroundColor: colors.card,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: radius.pill,
      // Без этого на iOS фон у Text не скругляется.
      overflow: 'hidden',
    },

    msg: { maxWidth: '82%', marginVertical: 3 },
    msgMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
    msgOther: { alignSelf: 'flex-start', alignItems: 'flex-start' },
    msgPending: { opacity: 0.6 },
    bubble: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.card },
    // Острый нижний угол показывает, с чьей стороны сообщение.
    bubbleMine: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
    bubbleOther: { backgroundColor: colors.card, borderBottomLeftRadius: 4 },
    bubbleText: { fontSize: text.body, lineHeight: 22, color: colors.text },
    bubbleTextMine: { color: colors.onPrimary },
    time: { fontSize: 12, color: colors.muted, marginTop: 2, marginHorizontal: 4 },

    problemBar: { paddingHorizontal: space.page, paddingBottom: COMPOSER_PAD },

    composer: {
      flexDirection: 'row',
      // Кнопка остаётся у нижней строки, когда поле вырастает.
      alignItems: 'flex-end',
      gap: COMPOSER_PAD,
      paddingHorizontal: space.page,
      paddingTop: COMPOSER_PAD,
      backgroundColor: colors.card,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    input: {
      flex: 1,
      minWidth: 0,
      minHeight: 44,
      // Около пяти строк: дальше текст прокручивается внутри поля.
      maxHeight: 124,
      paddingHorizontal: 14,
      // Именно top и bottom: у многострочного поля iOS paddingVertical
      // не отменяет собственный верхний отступ, и текст стоит не по центру.
      // 10, а не 11: пиксель съедает рамка.
      paddingTop: 10,
      paddingBottom: 10,
      borderRadius: 22,
      // Рамка outline, как у полей Field: фон поля к фону полосы — около
      // 1.1:1, и без рамки край поля почти не виден.
      borderWidth: 1,
      borderColor: colors.outline,
      backgroundColor: colors.background,
      // 16 — при меньшем iOS увеличивает экран при фокусе.
      fontSize: text.body,
      color: colors.text,
      textAlignVertical: 'center',
    },
    send: {
      width: 44,
      height: 44,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primary,
    },
    sendOff: { opacity: 0.5 },
    pressed: { opacity: 0.7 },

    // Полоса «писать нельзя» стоит внутри composer, на месте поля ввода, и
    // держит его высоту: фон, граница и отступы остаются теми же, и низ
    // экрана не прыгает, когда одно сменяет другое.
    peerBar: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.gap,
      minHeight: 44,
    },
    peerText: { flex: 1, minWidth: 0, fontSize: text.caption, color: colors.muted },
    // Строка без кнопки рядом — по центру: это подпись, а не начало абзаца.
    peerTextAlone: { textAlign: 'center' },

    // Строки шторки выходят за её поля (у Sheet они space.page) и возвращают
    // отступ себе: подсветка нажатия и разделитель идут от края до края.
    menu: { marginHorizontal: -space.page },
  });
