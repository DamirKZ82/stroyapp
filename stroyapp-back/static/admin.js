/* Админка StroyApp: одна страница, разделы — по #якорю в адресе.
   Без сборки и библиотек. Всё, что приходит с сервера, попадает на страницу
   только через textContent / свойства узлов — никакого innerHTML: в именах,
   описаниях и отзывах лежит текст, который писали пользователи. */
(() => {
  'use strict';

  // ===================================================================
  // Основа
  // ===================================================================

  // Токен живёт только до закрытия вкладки: админский доступ не должен
  // оставаться в браузере надолго. Хранилище у каждой вкладки своё, поэтому
  // запись, открытая в новой вкладке, сначала попросит войти. Делиться входом
  // между вкладками намеренно не стали: тогда его мог бы попросить любой
  // скрипт с этого же адреса.
  // Копия в памяти — на случай, когда браузер хранилище не даёт: без неё
  // удачный вход молча возвращал бы на форму входа.
  const TOKEN_KEY = 'stroyapp_admin_token';
  let tokenInMemory = null;
  const store = {
    get() { try { return sessionStorage.getItem(TOKEN_KEY) || tokenInMemory; } catch (e) { return tokenInMemory; } },
    set(v) { tokenInMemory = v; try { sessionStorage.setItem(TOKEN_KEY, v); } catch (e) { /* останется в памяти, до перезагрузки */ } },
    clear() { tokenInMemory = null; try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* нечего чистить */ } },
  };

  const $ = (id) => document.getElementById(id);

  /** Узел: el('div', { class: 'x', text: '…', onclick: fn }, ...дети). Пустые дети пропускаются. */
  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const kid of kids.flat(3)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const REQUEST_TIMEOUT_MS = 30000;

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  /** Запрос к серверу. token — если нужен не сохранённый вход, а другой (см. smsToken). */
  async function api(method, path, body, token = store.get()) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // Зависший запрос не должен держать страницу: пока одно действие в
        // пути, следующее не начинается (см. run).
        signal: AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
      });
    } catch (e) {
      throw new ApiError(0, e && e.name === 'TimeoutError'
        ? 'Сервер не ответил за полминуты. Попробуйте ещё раз.'
        : 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* ответ без тела */ }
    if (!res.ok) throw new ApiError(res.status, data.message || ('Ошибка ' + res.status));
    return data;
  }

  /** Запрос из админки: если вход истёк — обратно на экран входа. */
  async function call(method, path, body) {
    const token = store.get();
    if (!token) {
      // Вышли, пока шло прошлое действие. Запрос ни от чьего имени не шлём и
      // об «истёкшем входе» не сообщаем: человек вышел сам.
      const quiet = new ApiError(401, 'Вход истёк — войдите снова');
      quiet.silent = true;
      throw quiet;
    }
    try {
      return await api(method, path, body, token);
    } catch (e) {
      // Отказ относится к тому входу, с которым запрос ушёл. Если за это
      // время вышли или вошли заново, нынешний вход он не трогает.
      if (e.status === 401 && store.get() === token) {
        store.clear();
        screen('login');
        // Одни и те же слова и на экране входа, и во всплывающей строке раздела.
        e.message = 'Вход истёк — войдите снова';
        $('login-error').textContent = e.message;
        $('login-phone').focus();
      }
      throw e;
    }
  }

  function query(params) {
    const parts = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  // Всплывающая строка должна лечь поверх открытых окон. Окна (<dialog>) живут
  // в «верхнем слое» браузера, и обычный элемент оказывается под ними, какой
  // z-index ему ни дай. Popover попадает в тот же слой — выше всех, кого
  // показали раньше; поэтому каждый раз прячем его и показываем заново.
  const toastNode = $('toast');
  const toastInTopLayer = typeof toastNode.showPopover === 'function';
  if (!toastInTopLayer) toastNode.hidden = true;   // старый браузер: как обычный элемент
  let toastTimer;

  function hideToast() {
    if (!toastInTopLayer) toastNode.hidden = true;
    else if (toastNode.matches(':popover-open')) toastNode.hidePopover();
  }

  function toast(message, bad) {
    toastNode.textContent = message;
    toastNode.className = 'toast' + (bad ? ' bad' : '');
    if (toastInTopLayer) {
      hideToast();
      toastNode.showPopover();
    } else {
      toastNode.hidden = false;
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, bad ? 6000 : 3000);
  }

  // ---- как показывать значения ---------------------------------------

  const fmtDate = (ts) => (ts ? `${ts.slice(8, 10)}.${ts.slice(5, 7)}.${ts.slice(0, 4)} ${ts.slice(11, 16)}` : '—');
  const fmtDay = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '—');
  // Числа — через Intl: разряды разделяет неразрывный пробел, и «500 000 ₸» не
  // переносится посреди числа. Номер телефона — тоже с неразрывными.
  // Даты через Intl не идут намеренно: сервер отдаёт их строкой уже в своём
  // (казахстанском) времени, а Intl пересчитал бы в пояс браузера.
  const NBSP = '\u00A0';
  const NUM = new Intl.NumberFormat('ru-RU');
  const fmtNum = (n) => NUM.format(n);
  const fmtMoney = (n) => (n === null || n === undefined ? '—' : fmtNum(n) + NBSP + '₸');
  const fmtPhone = (p) => (p && /^\+7\d{10}$/.test(p)
    ? ['+7', p.slice(2, 5), p.slice(5, 8), p.slice(8, 10), p.slice(10)].join(NBSP)
    : (p || '—'));
  const person = (phone, name) => fmtPhone(phone) + (name ? ' · ' + name : '');
  const stars = (n) => '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n));

  const LISTING_STATUS = {
    public: ['В поиске', 'ok'],
    unpublished: ['Снято владельцем', ''],
    hidden: ['Скрыто модератором', 'bad'],
    owner_blocked: ['Владелец заблокирован', 'bad'],
  };
  const BOOKING_STATUS = {
    pending: ['Ожидает ответа', 'warn'],
    confirmed: ['Принята', 'ok'],
    rejected: ['Отклонена', 'bad'],
    cancelled: ['Отменена клиентом', ''],
  };
  // Единицы прайса — подписи с сервера (/dicts/units), здесь запасные.
  const UNITS = {
    piece: 'шт', m2: 'м²', m3: 'м³', m: 'п.м.', kg: 'кг', ton: 'т', bag: 'мешок', pack: 'упак.',
    roll: 'рулон', sheet: 'лист', liter: 'л', hour: 'час', day: 'день', trip: 'рейс', object: 'объект', work: 'работа',
  };
  const perUnit = (u) => (UNITS[u] ? 'за ' + UNITS[u] : '');
  const KINDS = { material: 'Магазин', service: 'Бригада' };
  const ACTIONS = {
    user_block: 'Заблокировал пользователя',
    user_unblock: 'Разблокировал пользователя',
    user_delete: 'Удалил пользователя',
    provider_hide: 'Скрыл объявление',
    provider_unhide: 'Вернул объявление в поиск',
    photo_delete: 'Удалил фото',
    review_delete: 'Удалил отзыв',
    service_create: 'Создал служебный аккаунт',
    service_update: 'Изменил служебный аккаунт',
    complaint_resolve: 'Принял меры по жалобе',
    complaint_reject: 'Отклонил жалобу',
    admin_grant: 'Назначил админом',
    admin_revoke: 'Снял права админа',
    admin_password_set: 'Задал пароль админки',
    provider_verify: 'Отметил «Проверенный»',
    provider_unverify: 'Снял «Проверенный»',
    pro_grant: 'Подарил Pro',
    setting_update: 'Изменил настройку',
    setting_reset: 'Сбросил настройку к .env',
  };
  const PLAN_TIER = {
    none: ['Без тарифа', ''],
    trial: ['Пробный', 'warn'],
    free: ['Бесплатный', ''],
    pro: ['Pro', 'ok'],
  };
  const PAYMENT_STATUS = {
    pending: ['Не завершена', ''],
    paid: ['Оплачено', 'ok'],
    failed: ['Не прошла', 'bad'],
  };
  const GATEWAYS = { freedompay: 'Freedom Pay', test: 'тестовая', admin: 'подарок админа' };

  const badge = (pair) => el('span', { class: 'badge ' + (pair ? pair[1] : ''), text: pair ? pair[0] : '?' });

  function thumb(path) {
    return path
      ? el('img', { class: 'thumb', src: path, alt: '', loading: 'lazy', width: 64, height: 48 })
      : el('div', { class: 'thumb' });
  }

  /**
   * Ссылка на запись: обычное нажатие открывает её окно здесь же, а с Ctrl / ⌘
   * браузер сам откроет адрес в новой вкладке — там сработает разбор адреса
   * в route().
   */
  function entityLink(text, href, open, props) {
    return el('a', {
      ...props,
      href,
      text,
      onclick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        open();
      },
    });
  }

  /**
   * Строка списка, открывающая запись. Заголовок — настоящая ссылка: до неё
   * доходит Tab, диктор называет её ссылкой, а с Ctrl / ⌘ запись открывается
   * в новой вкладке. Роль кнопки всей строке не даём: тогда диктор прочёл бы
   * её содержимое одной длинной фразой. Мышью можно нажать в любое место
   * строки, чтобы не целиться в текст.
   */
  function row({ href, open, title, image, lines, side }) {
    const node = el('div', { class: 'item click' },
      image,
      el('div', { class: 'grow' }, el('div', { class: 'title' }, entityLink(title, href, open)), lines),
      el('div', { class: 'side' }, side));
    // Нажатие по самой ссылке она обработает сама.
    node.addEventListener('click', (e) => { if (!e.target.closest('a')) open(); });
    return node;
  }

  /** Поле для номеров, кодов и поиска: подчёркивать «ошибки» и предлагать прошлые значения незачем. */
  function plain(input) {
    input.spellcheck = false;
    input.autocomplete = 'off';
    return input;
  }

  let fieldSeq = 0;
  /** Подпись, привязанная к полю: нажатие на неё ставит фокус, а диктор читает её как имя поля. */
  function labeled(text, control) {
    if (!control.id) control.id = `field-${++fieldSeq}`;
    return [el('label', { htmlFor: control.id, text }), control];
  }

  function facts(pairs) {
    const dl = el('dl', { class: 'facts' });
    for (const [name, value] of pairs) {
      if (value === null || value === undefined || value === '') continue;
      dl.append(el('dt', { text: name }), el('dd', null, value));
    }
    return dl;
  }

  // ===================================================================
  // Окна
  // ===================================================================

  const openModals = new Set();

  /**
   * Окно поверх страницы. Несколько окон складываются стопкой: каждое — свой <dialog>.
   *
   * onClose вызывается ровно один раз, когда окно закрыто — кнопкой, нажатием
   * мимо или клавишей Esc. Вызываем его сами, сразу при закрытии, а не по
   * событию close: во вкладке, которую сейчас не видно, браузер это событие
   * придерживает, и действие, которое человек уже подтвердил, зависло бы.
   */
  let dialogSeq = 0;
  function modal({ title, slim, body, foot, onClose, canClose }) {
    // Заголовок — имя окна: без него диктор объявляет просто «диалог».
    const titleId = `dialog-title-${++dialogSeq}`;
    const node = el('dialog', { class: 'dialog' + (slim ? ' slim' : ''), 'aria-labelledby': titleId });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      openModals.delete(close);
      node.remove();
      if (onClose) onClose();
    };
    const close = () => { if (node.open) node.close(); finish(); };
    // Закрытие человеком — крестик, Esc, нажатие мимо, «Отмена». Окно может
    // попросить подождать (canClose), пока его запрос в пути. Сам close()
    // закрывает всегда: им пользуются код окна и уход с экрана.
    const dismiss = () => { if (!canClose || canClose()) close(); };
    openModals.add(close);
    const bodyNode = el('div', { class: 'dialog-body' }, body);
    const footNode = el('div', { class: 'dialog-foot' }, foot);
    footNode.hidden = !foot || !foot.length;
    node.append(
      el('div', { class: 'dialog-head' },
        el('h2', { id: titleId, text: title }),
        el('button', { class: 'x', type: 'button', 'aria-label': 'Закрыть', text: '×', onclick: dismiss })),
      bodyNode,
      footNode,
    );
    // Esc: закрываем своей функцией, а не ждём, пока это сделает браузер.
    node.addEventListener('cancel', (e) => { e.preventDefault(); dismiss(); });
    node.addEventListener('close', finish);
    // Нажатие мимо окна закрывает его: цель события тогда — сам <dialog>.
    // Смотрим и на то, где кнопку мыши нажали: выделение текста в поле,
    // законченное за краем окна, не должно закрыть его вместе с набранным.
    let pressedOutside = false;
    node.addEventListener('mousedown', (e) => { pressedOutside = e.target === node; });
    // e.detail — номер нажатия в серии: второе нажатие двойного щелчка по строке
    // списка приходится уже на фон только что открытого окна и закрыло бы его.
    node.addEventListener('click', (e) => { if (e.target === node && pressedOutside && e.detail <= 1) dismiss(); });
    document.body.append(node);
    node.showModal();
    return {
      node,
      close,
      dismiss,
      fill(newBody, newFoot) {
        bodyNode.replaceChildren(...[newBody].flat(3).filter(Boolean));
        footNode.replaceChildren(...(newFoot || []).filter(Boolean));
        footNode.hidden = !newFoot || !newFoot.filter(Boolean).length;
      },
    };
  }

  // Кто прочитает причину — пишем прямо под полем: от этого зависит, что в неё писать.
  const REASON_FOR_OWNER = 'Причину увидит владелец, если попробует опубликовать объявление снова, и админы — в журнале действий.';
  const REASON_FOR_ADMINS = 'Причину увидят только админы — в журнале действий.';

  /** Спросить причину. Вернёт текст или null, если передумали. hint — кто её увидит. */
  /** extra — поле над причиной (срок Pro); calm — кнопка не красная: действие не карательное. */
  function askReason({ title, text, confirmLabel, hint, placeholder, extra, calm }) {
    return new Promise((resolve) => {
      let answer = null;
      const input = el('textarea', { maxLength: 500, placeholder: placeholder || 'Например: чужие фотографии, недостоверные цены' });
      const error = el('div', { class: 'error', role: 'alert' });
      const ok = el('button', {
        class: calm ? 'btn' : 'btn danger solid', type: 'button', text: confirmLabel,
        onclick: () => {
          const value = input.value.trim();
          if (value.length < 3) { error.textContent = 'Напишите причину — она останется в журнале'; input.focus(); return; }
          answer = value;
          win.close();
        },
      });
      const win = modal({
        title,
        slim: true,
        body: [
          text ? el('p', { text }) : null,
          extra || null,
          labeled('Причина', input),
          hint ? el('p', { class: 'muted small', text: hint }) : null,
          error,
        ],
        foot: [el('button', { class: 'btn ghost', type: 'button', text: 'Отмена', onclick: () => win.close() }), ok],
        onClose: () => resolve(answer),
      });
      input.focus();
    });
  }

  /** Подтверждение. mustType — слово, которое надо набрать для необратимого действия. */
  function confirmAction({ title, text, confirmLabel, danger, mustType }) {
    return new Promise((resolve) => {
      let answer = false;
      const input = mustType ? plain(el('input', { placeholder: mustType })) : null;
      const error = el('div', { class: 'error', role: 'alert' });
      const ok = el('button', {
        class: 'btn' + (danger ? ' danger solid' : ''), type: 'button', text: confirmLabel,
        onclick: () => {
          if (mustType && input.value.trim().toUpperCase() !== mustType) {
            error.textContent = `Наберите слово ${mustType}`;
            input.focus();
            return;
          }
          answer = true;
          win.close();
        },
      });
      const win = modal({
        title,
        slim: true,
        body: [
          el('p', { text }),
          mustType ? labeled(`Чтобы подтвердить, наберите ${mustType}`, input) : null,
          error,
        ],
        foot: [el('button', { class: 'btn ghost', type: 'button', text: 'Отмена', onclick: () => win.close() }), ok],
        onClose: () => resolve(answer),
      });
      (input || ok).focus();
    });
  }

  /**
   * Действие, которое подтверждают своим паролем: назначить или снять админа.
   * send(пароль) делает сам запрос. Окно закрывается только после удачного
   * ответа: неверный пароль или номер исправляют тут же, не начиная заново.
   * Вернёт ответ сервера или null, если передумали.
   */
  /** note — почему спрашиваем пароль; по умолчанию — про назначение админов. */
  function confirmByPassword({ title, text, confirmLabel, danger, fields, send, note }) {
    return new Promise((resolve) => {
      let answer = null;
      let busy = false;
      // Свой номер скрытым полем, первым в форме: по нему менеджер паролей
      // понимает, чей это пароль. Без него он счёл бы логином соседнее поле —
      // имя или номер нового админа — и подставил бы туда сохранённый логин.
      const username = el('input', { type: 'text', name: 'username', autocomplete: 'username', value: me.phone, hidden: true });
      const password = el('input', { type: 'password', name: 'password', autocomplete: 'current-password' });
      const error = el('div', { class: 'error', role: 'alert' });
      const ok = el('button', {
        class: 'btn' + (danger ? ' danger solid' : ''), type: 'button', text: confirmLabel,
        onclick: () => form.requestSubmit(),
      });
      const cancel = el('button', { class: 'btn ghost', type: 'button', text: 'Отмена', onclick: () => win.dismiss() });
      // data-first — поле, с которого начинать, даже если оно скрытое (новый секрет).
      const firstField = () => form.querySelector('[data-first]') || form.querySelector('input:not([type="password"]):not([hidden])') || password;
      const form = el('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          if (busy) return;
          error.textContent = '';
          if (!password.value) { error.textContent = 'Введите свой пароль'; password.focus(); return; }
          busy = true;
          ok.disabled = true;
          cancel.disabled = true;
          try {
            answer = await send(password.value);
          } catch (err) {
            error.textContent = err.message;
            // 403 и 429 — про пароль; остальное (не тот номер, уже админ) — про поля выше.
            const field = err.status === 403 || err.status === 429 ? password : firstField();
            field.focus();
            field.select();
            return;
          } finally {
            busy = false;
            ok.disabled = false;
            cancel.disabled = false;
          }
          win.close();
        },
      },
        username,
        text ? el('p', { text }) : null,
        fields,
        labeled('Ваш пароль от админки', password),
        el('p', { class: 'muted small', text: note || 'Так назначить или снять админа не сможет тот, кому достался только ваш открытый вход, без пароля.' }),
        error,
        // Невидимая кнопка отправки: с ней Enter в любом поле отправляет форму.
        el('button', { type: 'submit', hidden: true, tabIndex: -1 }));
      const win = modal({
        title,
        slim: true,
        body: form,
        foot: [cancel, ok],
        // Пока запрос в пути, окно не закрыть: действие уже ушло на сервер,
        // «отмена» его не отменила бы, а только спрятала итог.
        canClose: () => !busy,
        onClose: () => resolve(answer),
      });
      firstField().focus();
    });
  }

  // Окна перечитывают себя после действий в соседнем окне. Если запись за это
  // время удалили (аккаунт — вместе с объявлениями), это не ошибка: окно просто
  // закрывается, а человек видит итог своего действия, а не «не найдено».
  const gone = (e, again) => again && e.status === 404;

  /**
   * Выполнить действие и показать итог; ошибку — всплывающей строкой.
   * Пока одно действие в пути, второе не начинается: двойное нажатие на
   * «Вернуть» иначе ушло бы на сервер дважды и вторым ответом была бы ошибка.
   */
  let running = false;
  async function run(action, doneText) {
    if (running) {
      toast('Подождите: предыдущее действие ещё выполняется');
      return false;
    }
    running = true;
    try {
      await action();
      if (doneText) toast(doneText);
      return true;
    } catch (e) {
      if (!e.silent) toast(e.message, true);
      return false;
    } finally {
      running = false;
    }
  }

  // ===================================================================
  // Список с поиском, фильтрами и «Показать ещё»
  // ===================================================================

  function listView({ filters, fetchPage, renderItem, emptyText }) {
    const params = {};
    let page = 1;
    let loaded = 0;
    let seq = 0;   // номер запроса: ответ на устаревший запрос не должен затереть свежий
    let timer;

    const listNode = el('div', { class: 'list' });
    const countNode = el('p', { class: 'count', 'aria-live': 'polite' });
    const moreBtn = el('button', { class: 'btn ghost', type: 'button', text: 'Показать ещё', onclick: () => load(false) });
    const moreWrap = el('div', { class: 'more' }, moreBtn);
    moreWrap.hidden = true;
    const toolbar = el('div', { class: 'toolbar' });

    for (const f of filters || []) {
      if (f.type === 'search') {
        const input = plain(el('input', {
          type: 'search', name: f.name, placeholder: f.placeholder + '…', 'aria-label': f.placeholder,
        }));
        input.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => { params[f.name] = input.value.trim(); load(true); }, 300);
        });
        toolbar.append(input);
      } else {
        const select = el('select', { 'aria-label': f.label },
          f.options.map(([value, text]) => el('option', { value: String(value), text })));
        // «all» у выпадающего списка — «без отбора»: такой параметр не шлём.
        // Кроме списков с keepAll: там без параметра сервер отбирает сам.
        select.addEventListener('change', () => {
          params[f.name] = select.value === 'all' && !f.keepAll ? '' : select.value;
          load(true);
        });
        toolbar.append(select);
      }
    }

    // id показанных строк. Страницы считаются от начала списка, и пока человек
    // листает, в начало приходят новые записи (в журнале отказов — постоянно):
    // без этой проверки последняя строка страницы пришла бы ещё раз.
    const seen = new Set();

    async function load(reset) {
      const mine = ++seq;
      const want = reset ? 1 : page;
      // Ссылка строки, на которой стоит фокус (он вернулся к ней из закрытого
      // окна): после перечитывания списка ставим его на ту же запись, иначе
      // он пропадал бы вместе со старой строкой.
      const focused = reset && listNode.contains(document.activeElement)
        ? document.activeElement.getAttribute('href') : null;
      moreBtn.disabled = true;
      try {
        const data = await fetchPage({ ...params, page: want });
        if (mine !== seq) return;
        // Счётчики и сам список меняем только после удачного ответа: при сбое
        // всё остаётся как было, и «Показать ещё» продолжит с того же места.
        if (reset) { listNode.replaceChildren(); seen.clear(); loaded = 0; }
        for (const item of data.items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          listNode.append(renderItem(item, () => load(true)));
          loaded += 1;
        }
        page = want + 1;
        if (!loaded) listNode.replaceChildren(el('div', { class: 'empty', text: emptyText }));
        countNode.textContent = data.total ? `Показано ${fmtNum(loaded)} из ${fmtNum(data.total)}` : '';
        moreWrap.hidden = !data.items.length || loaded >= data.total;
        if (focused) {
          const again = [...listNode.querySelectorAll('.title a')].find((a) => a.getAttribute('href') === focused);
          (again || $('view')).focus();
        }
      } catch (e) {
        if (mine === seq && !e.silent) toast(e.message, true);
      } finally {
        if (mine === seq) moreBtn.disabled = false;
      }
    }

    const node = el('div', null, (filters || []).length ? toolbar : null, countNode, listNode, moreWrap);
    load(true);
    return { node, reload: () => load(true) };
  }

  // Справочники для фильтров — один раз за сеанс.
  const dicts = { cities: null, categories: null };
  async function loadDicts() {
    if (!dicts.cities) {
      const [cities, categories] = await Promise.all([api('GET', '/dicts/cities'), api('GET', '/dicts/categories')]);
      dicts.cities = cities.items || [];
      dicts.categories = categories.items || [];
    }
    return dicts;
  }
  const cityOptions = () => [['all', 'Все города'], ...dicts.cities.map((c) => [c.id, c.name_ru])];
  const STATUS_OPTIONS = [
    ['all', 'Любой статус'], ['public', 'В поиске'], ['unpublished', 'Сняты владельцем'], ['hidden', 'Скрыты модератором'],
    ['verify_wait', 'Ждут проверки БИН'], ['verified', 'Проверенные'],
  ];

  // ===================================================================
  // Разделы
  // ===================================================================

  // ---- Обзор ----------------------------------------------------------

  async function viewOverview(root) {
    const data = await call('GET', '/admin/api/stats');
    const t = data.totals;
    // Карточка, ведущая в раздел, — настоящая ссылка: её можно открыть в новой
    // вкладке и до неё доходит Tab.
    const card = (num, cap, sub, opts) => el(opts && opts.go ? 'a' : 'div', {
      class: 'card' + (opts && opts.alert ? ' alert' : '') + (opts && opts.go ? ' click' : ''),
      href: opts && opts.go ? '#' + opts.go : null,
    }, el('div', { class: 'num', text: fmtNum(num) }), el('div', { class: 'cap', text: cap }), el('div', { class: 'sub muted', text: sub }));

    const errors = t.errors_back_day + t.errors_front_day;
    root.append(
      el('h2', { text: 'Обзор' }),
      el('div', { class: 'cards' },
        card(t.complaints_new, 'Новые жалобы', `всего было ${t.complaints_total}`, { go: 'complaints', alert: t.complaints_new > 0 }),
        card(t.users_total, 'Пользователи', `+${t.users_week} за 7 дней · заблокировано ${t.users_blocked}`, { go: 'users' }),
        card(t.providers_total, 'Объявления', `магазинов ${t.shops_total} · бригад ${t.crews_total} · в поиске ${t.providers_public} · скрыто ${t.providers_hidden} · позиций в прайсах ${fmtNum(t.items_total)}`, { go: 'providers' }),
        card(t.bookings_total, 'Заявки', `+${t.bookings_week} за 7 дней · ждут ответа ${t.bookings_pending} · подтверждено ${t.bookings_confirmed}`, { go: 'bookings' }),
        // Старый сервер этих полей не пришлёт — тогда карточек нет.
        t.sellers_pro === undefined ? null
          : card(t.sellers_pro, 'Продавцы на Pro', `на пробном ${t.sellers_trial} · оплат за 30 дней ${fmtMoney(t.revenue_30d)}`),
        t.verify_wait === undefined ? null
          : card(t.verify_wait, 'Ждут проверки БИН', 'продавец прислал БИН/ИИН', { go: 'providers', alert: t.verify_wait > 0 }),
        card(t.reviews_total, 'Отзывы', t.reviews_total ? `средняя оценка ${t.reviews_avg}` : 'пока нет', { go: 'reviews' }),
        card(t.chats_total, 'Переписки', `сообщений ${fmtNum(t.messages_total)}`),
        card(errors, 'Ошибки за сутки', `сервер ${t.errors_back_day} · приложение ${t.errors_front_day} · отказов ${t.warns_day}`, { go: 'logs', alert: errors > 0 }),
      ),
    );

    const chart = (title, key) => {
      const max = Math.max(1, ...data.series.map((d) => d[key]));
      const cols = data.series.map((d) => {
        const bar = el('div', { class: 'bar', title: `${fmtDay(d.day)}: ${d[key]}` });
        bar.style.height = Math.round((d[key] / max) * 100) + '%';
        return el('div', { class: 'col' },
          el('div', { class: 'val', text: d[key] || '' }), bar, el('div', { class: 'day', text: d.day.slice(8, 10) }));
      });
      const total = data.series.reduce((sum, d) => sum + d[key], 0);
      return el('div', { class: 'panel' },
        el('strong', { text: title }), el('span', { class: 'muted small', text: `  за 14 дней: ${total}` }),
        el('div', { class: 'chart' }, cols));
    };
    root.append(chart('Регистрации', 'users'), chart('Заявки', 'bookings'), chart('Новые объявления', 'listings'));
  }

  // ---- Пользователи -----------------------------------------------------

  function viewUsers(root) {
    const list = listView({
      filters: [
        { type: 'search', name: 'q', placeholder: 'Телефон или имя' },
        { type: 'select', name: 'filter', label: 'Кого показать', options: [
          ['all', 'Все'], ['owners', 'С объявлениями'], ['clients', 'С заявками'],
          ['blocked', 'Заблокированные'], ['admins', 'Админы'], ['service', 'Служебные'],
        ] },
      ],
      fetchPage: (p) => call('GET', '/admin/api/users' + query(p)),
      emptyText: 'Никого не нашлось',
      renderItem: (u, reload) => row({
        href: '#users/' + u.id,
        open: () => openUser(u.id, reload),
        title: person(u.phone, u.full_name),
        lines: el('div', { class: 'meta', text: `С ${fmtDay(u.created_at)} · объявлений ${u.providers} · заявок ${u.bookings}` }),
        side: [
          u.is_blocked ? badge(['Заблокирован', 'bad']) : null,
          u.is_admin ? badge(u.admin_active ? ['Админ', 'ok'] : ['Админ · не активирован', 'warn']) : null,
          u.is_service ? badge(['Служебный', 'warn']) : null,
        ],
      }),
    });
    root.append(
      el('div', { class: 'head' },
        el('h2', { text: 'Пользователи' }),
        el('button', {
          class: 'btn ghost small', type: 'button', text: 'Добавить админа',
          onclick: async () => { if (await addAdmin()) list.reload(); },
        })),
      list.node);
  }

  // Что должен сделать назначенный, чтобы доступ заработал. Адрес — этой же страницы.
  const ACTIVATION = `сам откроет ${location.origin}/admin, подтвердит номер по SMS и задаст пароль`;

  /** Назначить админом номер телефона. Вернёт true, если назначили. */
  async function addAdmin() {
    const phone = plain(el('input', { type: 'tel', name: 'admin-phone', placeholder: '+7 700 000 00 00' }));
    const name = plain(el('input', { name: 'admin-name', placeholder: 'Имя и фамилия' }));
    const done = await confirmByPassword({
      title: 'Добавить админа',
      confirmLabel: 'Назначить',
      text: `Админ видит всех пользователей и может скрывать объявления, блокировать и удалять аккаунты. Доступ появится не сразу: человек ${ACTIVATION}.`,
      fields: [
        labeled('Телефон нового админа', phone),
        labeled('Имя (если он ещё не пользовался приложением)', name),
      ],
      send: (password) => call('POST', '/admin/api/admins', {
        phone: phone.value.trim(), full_name: name.value.trim() || null, password,
      }),
    });
    if (!done) return false;
    toast(`${person(done.user.phone, done.user.full_name)} назначен. Доступ появится, когда он сам задаст пароль.`);
    return true;
  }

  const miniListing = (item, onChange) => row({
    href: '#providers/' + item.id,
    open: () => openProvider(item.id, onChange),
    title: item.name,
    image: thumb(item.thumb),
    lines: el('div', { class: 'meta', text: `${KINDS[item.kind] || ''} · ${item.category} · ${item.city}` }),
    side: badge(LISTING_STATUS[item.status]),
  });

  async function openUser(id, onChange) {
    const win = modal({ title: 'Пользователь', body: el('p', { class: 'muted', text: 'Загрузка…' }) });
    const changed = () => { if (onChange) onChange(); };

    let loads = 0;   // номер загрузки: ответ на устаревшую не должен затереть свежую
    async function load(again) {
      const mine = ++loads;
      let data;
      try {
        data = await call('GET', '/admin/api/users/' + id);
      } catch (e) {
        if (mine === loads) { win.close(); if (!gone(e, again)) toast(e.message, true); }
        return;
      }
      if (mine !== loads) return;
      const u = data.user;

      const section = (title, nodes, emptyText) => [
        el('h3', { text: title }),
        nodes.length ? el('div', { class: 'list' }, nodes) : el('p', { class: 'muted', text: emptyText }),
      ];
      const body = [
        u.is_blocked ? el('div', { class: 'note' },
          `Заблокирован${u.blocked_at ? ' ' + fmtDate(u.blocked_at) : ''}. Причина: ${u.blocked_reason || 'не указана'}`) : null,
        facts([
          ['Телефон', fmtPhone(u.phone)],
          ['Имя', u.full_name || '—'],
          ['Язык приложения', u.language === 'kz' ? 'казахский' : 'русский'],
          ['Зарегистрирован', fmtDate(u.created_at)],
          // Сервер старше этого поля его не пришлёт — тогда строки нет.
          ['Условия использования', data.terms === undefined ? null
            : !data.terms.accepted ? 'не приняты'
            : `приняты ${fmtDate(data.terms.accepted.accepted_at)} · версия ${data.terms.accepted.version}`
              + (data.terms.accepted.version === data.terms.current ? '' : ` (действует ${data.terms.current})`)],
          ['Роль', [u.is_admin ? 'администратор' : null, u.is_service ? 'служебный аккаунт' : null].filter(Boolean).join(', ') || 'обычный пользователь'],
          ['Вход в админку', !u.is_admin ? null : data.admin_access
            ? `пароль задан ${fmtDate(data.admin_access.password_set_at)} · последний вход ${data.admin_access.last_login_at ? fmtDate(data.admin_access.last_login_at) : 'ещё не входил'}`
            : `ещё не активирован: доступ появится, когда он ${ACTIVATION}`],
          ['Тариф продавца', !data.plan ? null : el('span', {},
            badge(PLAN_TIER[data.plan.tier]),
            data.plan.tier === 'pro' ? ` до ${fmtDate(data.plan.paid_until)}`
              : data.plan.tier === 'trial' ? ` до ${fmtDate(data.plan.trial_ends_at)}` : '')],
          ['Активность', `заявок ${data.counts.bookings} · отзывов ${data.counts.reviews} · переписок ${data.counts.chats} · сообщений ${data.counts.messages}`],
          ['Жалобы', `на него ${data.counts.complaints_on}` + (data.counts.complaints_on_new ? ` (новых ${data.counts.complaints_on_new})` : '') + ` · от него ${data.counts.complaints_by}`],
          // Страница бывает новее сервера: её он читает с диска при каждом
          // запросе, а свой код меняет только с перезапуском. Без счётчиков в
          // ответе строку не показываем — иначе в ней стояло бы «undefined».
          ['Чёрные списки', data.counts.peer_blocks_on === undefined || data.counts.peer_blocks_by === undefined ? null
            : `в чёрном списке у ${data.counts.peer_blocks_on} чел. · сам внёс ${data.counts.peer_blocks_by}`],
        ]),
        section('Объявления', data.providers.map((p) => miniListing(p, () => { load(true); changed(); })), 'Объявлений нет'),
        data.payments === undefined ? null : section('Оплаты тарифа', data.payments.map((pay) => el('div', { class: 'item' },
          el('div', { class: 'grow' },
            el('div', { class: 'title', text: `Pro на ${pay.months} мес. · ${fmtMoney(pay.amount)}` }),
            el('div', { class: 'meta', text: `${GATEWAYS[pay.gateway] || pay.gateway} · ${fmtDate(pay.paid_at || pay.created_at)}` + (pay.note ? ` · ${pay.note}` : '') })),
          el('div', { class: 'side' }, badge(PAYMENT_STATUS[pay.status])))), 'Оплат не было'),
        section('Последние заявки', data.bookings.map((b) => el('div', { class: 'item' },
          el('div', { class: 'grow' },
            el('div', { class: 'title', text: b.subject || '—' }),
            el('div', { class: 'meta', text: `к ${fmtDay(b.event_date)}` + (b.address ? ` · ${b.address}` : '') + ` · создана ${fmtDate(b.created_at)}` })),
          el('div', { class: 'side' }, badge(BOOKING_STATUS[b.status])))), 'Заявок нет'),
        section('Последние отзывы', data.reviews.map((r) => el('div', { class: 'item' },
          el('div', { class: 'grow' },
            el('div', { class: 'title', text: `${stars(r.rating)} ${r.subject || ''}` }),
            el('div', { class: 'meta', text: fmtDate(r.created_at) }),
            r.text ? el('div', { class: 'quote', text: r.text }) : null))), 'Отзывов нет'),
      ];

      const foot = [];
      if (u.is_blocked) {
        foot.push(el('button', {
          class: 'btn', type: 'button', text: 'Разблокировать',
          onclick: async () => {
            const sure = await confirmAction({
              title: 'Разблокировать?', confirmLabel: 'Разблокировать',
              text: 'Человек снова сможет войти, а его объявления, скрытые вместе с блокировкой, вернутся в поиск.',
            });
            if (sure && await run(() => call('POST', `/admin/api/users/${id}/unblock`), 'Разблокирован')) { load(true); changed(); }
          },
        }));
      } else if (!u.is_admin) {
        foot.push(el('button', {
          class: 'btn danger', type: 'button', text: 'Заблокировать',
          onclick: async () => {
            const reason = await askReason({
              title: 'Заблокировать пользователя?', confirmLabel: 'Заблокировать',
              text: 'Он не сможет войти в приложение, а все его объявления пропадут из поиска. Это можно отменить.',
              hint: REASON_FOR_ADMINS + ' Самому человеку приложение скажет только, что аккаунт заблокирован, и даст адрес поддержки.',
              placeholder: 'Например: мошенничество, жалобы клиентов',
            });
            if (reason && await run(() => call('POST', `/admin/api/users/${id}/block`, { reason }), 'Заблокирован')) { load(true); changed(); }
          },
        }));
      }
      if (u.is_admin && u.id !== me.id) {
        foot.push(el('button', {
          class: 'btn danger', type: 'button', text: 'Снять права админа',
          onclick: async () => {
            const done = await confirmByPassword({
              title: 'Снять права админа?', confirmLabel: 'Снять права', danger: true,
              text: `${person(u.phone, u.full_name)} сразу потеряет доступ в админку, а его пароль сотрётся. Аккаунт в приложении останется. Назначить снова можно будет в любой момент — пароль он задаст заново.`,
              send: (password) => call('POST', `/admin/api/users/${id}/revoke-admin`, { password }),
            });
            if (done) { toast('Права админа сняты'); load(true); changed(); }
          },
        }));
      } else if (!u.is_admin && !u.is_service && !u.is_blocked) {
        foot.push(el('button', {
          class: 'btn ghost', type: 'button', text: 'Сделать админом',
          onclick: async () => {
            const done = await confirmByPassword({
              title: 'Сделать админом?', confirmLabel: 'Назначить',
              text: `${person(u.phone, u.full_name)} будет видеть всех пользователей и сможет скрывать объявления, блокировать и удалять аккаунты. Доступ появится, когда он ${ACTIVATION}.`,
              send: (password) => call('POST', '/admin/api/admins', { phone: u.phone, password }),
            });
            if (done) { toast('Назначен. Доступ появится, когда он сам задаст пароль.'); load(true); changed(); }
          },
        }));
      }
      if (data.plan && !u.is_service) {
        foot.push(el('button', {
          class: 'btn ghost', type: 'button', text: 'Подарить Pro',
          onclick: async () => {
            const months = plain(el('input', { type: 'number', name: 'pro-months', min: 1, max: 12, value: 1 }));
            const reason = await askReason({
              title: 'Подарить Pro?', confirmLabel: 'Подарить',
              text: 'Pro продлится от конца уже оплаченного срока (или с сегодняшнего дня). В оплатах появится строка с суммой 0.',
              hint: REASON_FOR_ADMINS,
              placeholder: 'Например: компенсация за сбой, оплата по счёту',
              extra: labeled('Месяцев (1–12)', months),
              calm: true,
            });
            const n = Math.trunc(Number(months.value));
            if (reason && !(n >= 1 && n <= 12)) { toast('Срок — от 1 до 12 месяцев', true); return; }
            if (reason && await run(() => call('POST', `/admin/api/users/${id}/grant-pro`, { months: n, reason }), 'Pro продлён')) { load(true); changed(); }
          },
        }));
      }
      if (!u.is_admin) {
        foot.push(el('button', {
          class: 'btn danger solid', type: 'button', text: 'Удалить аккаунт',
          onclick: async () => {
            const sure = await confirmAction({
              title: 'Удалить аккаунт насовсем?', confirmLabel: 'Удалить', danger: true, mustType: 'УДАЛИТЬ',
              text: `${person(u.phone, u.full_name)}: будут удалены его объявления с фото, заявки, переписки, отзывы и избранное. Вернуть это нельзя. Если нужно лишь убрать человека из сервиса — заблокируйте.`,
            });
            if (sure && await run(() => call('DELETE', '/admin/api/users/' + id), 'Аккаунт удалён')) { win.close(); changed(); }
          },
        }));
      }
      win.fill(body, foot);
      win.node.querySelector('h2').textContent = person(u.phone, u.full_name);
    }
    load();
  }

  function photoGrid(photos, deletePath, afterDelete) {
    if (!photos.length) return el('p', { class: 'muted', text: 'Фотографий нет' });
    return el('div', { class: 'photos' }, photos.map((p) => el('div', { class: 'photo' },
      el('a', { href: p.file_path, target: '_blank', rel: 'noopener' },
        el('img', { src: p.thumb_path, alt: 'Фото объявления', loading: 'lazy', width: 400, height: 300 })),
      el('button', {
        type: 'button', text: 'Удалить',
        onclick: async () => {
          const sure = await confirmAction({
            title: 'Удалить фото?', confirmLabel: 'Удалить', danger: true,
            text: 'Фото исчезнет из объявления насовсем. Владельцу об этом никто не сообщит.',
          });
          if (sure && await run(() => call('DELETE', deletePath + p.id), 'Фото удалено')) afterDelete();
        },
      }))));
  }

  function hiddenNote(item) {
    if (item.status === 'owner_blocked') return el('div', { class: 'note', text: 'Владелец заблокирован — объявление не видно в поиске.' });
    if (item.hidden_at) return el('div', { class: 'note', text: `Скрыто модератором ${fmtDate(item.hidden_at)}. Причина: ${item.hidden_reason || 'не указана'}` });
    return null;
  }

  const ownerLink = (item, onChange) => entityLink(
    person(item.owner_phone, item.owner_name), '#users/' + item.owner_id, () => openUser(item.owner_id, onChange));

  // ---- Объявления: магазины и бригады --------------------------------------------------------

  function viewProviders(root) {
    const list = listView({
      filters: [
        { type: 'search', name: 'q', placeholder: 'Название, адрес или телефон владельца' },
        { type: 'select', name: 'kind', label: 'Вид', options: [['all', 'Магазины и бригады'], ['material', 'Магазины'], ['service', 'Бригады']] },
        { type: 'select', name: 'category_id', label: 'Категория', options: [['all', 'Все категории'], ...dicts.categories.map((c) => [c.id, c.name_ru])] },
        { type: 'select', name: 'city_id', label: 'Город', options: cityOptions() },
        { type: 'select', name: 'status', label: 'Статус', options: STATUS_OPTIONS },
      ],
      fetchPage: (p) => call('GET', '/admin/api/providers' + query(p)),
      emptyText: 'Объявлений не нашлось',
      renderItem: (p, reload) => row({
        href: '#providers/' + p.id,
        open: () => openProvider(p.id, reload),
        title: p.name,
        image: thumb(p.thumb),
        lines: [
          el('div', { class: 'meta', text: `${KINDS[p.kind] || ''} · ${p.category} · ${p.city} · ${person(p.owner_phone, p.owner_name)}` }),
          el('div', { class: 'meta', text: `${p.price_from ? 'от ' + fmtMoney(p.price_from) + ' ' + perUnit(p.price_unit) : 'цена не указана'} · позиций ${p.items} · фото ${p.photos} · добавлено ${fmtDay(p.created_at)}` }),
        ],
        side: badge(LISTING_STATUS[p.status]),
      }),
    });
    root.append(el('h2', { text: 'Объявления' }), list.node);
  }

  async function openProvider(id, onChange) {
    const win = modal({ title: 'Объявление', body: el('p', { class: 'muted', text: 'Загрузка…' }) });
    const changed = () => { if (onChange) onChange(); };

    let loads = 0;
    async function load(again) {
      const mine = ++loads;
      let p;
      try {
        p = (await call('GET', '/admin/api/providers/' + id)).provider;
      } catch (e) {
        if (mine === loads) { win.close(); if (!gone(e, again)) toast(e.message, true); }
        return;
      }
      if (mine !== loads) return;

      const body = [
        hiddenNote(p),
        photoGrid(p.photo_list, '/admin/api/provider-photos/', () => { load(true); changed(); }),
        facts([
          ['Статус', badge(LISTING_STATUS[p.status])],
          ['Вид, категория, город', `${KINDS[p.kind] || ''}, ${p.category}, ${p.city}`],
          ['Адрес', p.address],
          ['Владелец', ownerLink(p, () => { load(true); changed(); })],
          ['Телефон в объявлении', p.phone ? fmtPhone(p.phone) : null],
          ['Цена', p.price_from ? `от ${fmtMoney(p.price_from)} ${perUnit(p.price_unit)}` : 'не указана'],
          ['Условия', p.attrs.join(', ')],
          ['Прайс', p.item_list.length
            ? el('div', {}, p.item_list.map((it) => el('div', { text: `${it.name} — ${it.price == null ? 'договорная' : fmtMoney(it.price) + ' ' + perUnit(it.unit)}` })))
            : 'не заполнен'],
          ['Описание', p.description],
          ['Заявок и отзывов', `заявок ${p.counts.bookings} · отзывов ${p.counts.reviews}` + (p.counts.reviews ? ` · оценка ${p.counts.rating}` : '')],
          p.counts.complaints ? ['Жалоб', `${p.counts.complaints}` + (p.counts.complaints_new ? ` (новых ${p.counts.complaints_new})` : '')] : ['Жалоб', null],
          ['БИН/ИИН', !p.bin ? 'не присылал'
            : el('span', {}, p.bin + ' ', p.verified_at
              ? badge([`Проверен ${fmtDay(p.verified_at)}`, 'ok'])
              : badge([`Ждёт проверки с ${fmtDay(p.verify_requested_at)}`, 'warn']))],
          ['Добавлен', fmtDate(p.created_at)],
        ]),
      ];
      const foot = [];
      if (p.bin && !p.verified_at) {
        foot.push(el('button', {
          class: 'btn', type: 'button', text: 'БИН сверен — «Проверенный»',
          onclick: async () => {
            const sure = await confirmAction({
              title: 'Отметить «Проверенный»?', confirmLabel: 'Отметить',
              text: `Сначала сверьте БИН/ИИН ${p.bin} с реестром (stat.gov.kz или kgd.gov.kz): название и вид деятельности должны совпадать с объявлением. Значок клиенты увидят, пока у владельца оплачен Pro.`,
            });
            if (sure && await run(() => call('POST', `/admin/api/providers/${id}/verify`), 'Отмечено «Проверенный»')) { load(true); changed(); }
          },
        }));
      } else if (p.verified_at) {
        foot.push(el('button', {
          class: 'btn ghost', type: 'button', text: 'Снять «Проверенный»',
          onclick: async () => {
            const reason = await askReason({
              title: 'Снять отметку «Проверенный»?', confirmLabel: 'Снять',
              text: 'Значок пропадёт у объявления в поиске и на карточке. Продавец сможет прислать БИН/ИИН снова.',
              hint: REASON_FOR_ADMINS,
            });
            if (reason && await run(() => call('POST', `/admin/api/providers/${id}/unverify`, { reason }), 'Отметка снята')) { load(true); changed(); }
          },
        }));
      }
      if (p.status !== 'owner_blocked') {
        foot.push(p.hidden_at
          ? el('button', {
            class: 'btn', type: 'button', text: 'Вернуть в поиск',
            onclick: async () => {
              if (await run(() => call('POST', `/admin/api/providers/${id}/unhide`), 'Объявление возвращено')) { load(true); changed(); }
            },
          })
          : el('button', {
            class: 'btn danger solid', type: 'button', text: 'Скрыть из поиска',
            onclick: async () => {
              const reason = await askReason({
                title: 'Скрыть объявление из поиска?', confirmLabel: 'Скрыть',
                text: 'Объявление пропадёт из поиска и перестанет принимать заявки. Владелец увидит его снятым с публикации и не сможет опубликовать сам, пока вы не вернёте.',
                hint: REASON_FOR_OWNER,
              });
              if (reason && await run(() => call('POST', `/admin/api/providers/${id}/hide`, { reason }), 'Объявление скрыто')) { load(true); changed(); }
            },
          }));
      }
      win.fill(body, foot);
      win.node.querySelector('h2').textContent = p.name;
    }
    load();
  }

  // ---- Жалобы ----------------------------------------------------------------

  const COMPLAINT_STATUS = {
    new: ['Новая', 'warn'],
    resolved: ['Меры приняты', 'ok'],
    rejected: ['Отклонена', ''],
  };

  // Сколько жалоб ждёт разбора — число на вкладке. Обновляется каждым ответом
  // списка жалоб и один раз при входе.
  let complaintsNew = 0;
  const complaintsTabTitle = () => (complaintsNew ? `Жалобы · ${complaintsNew}` : 'Жалобы');
  function setComplaintsNew(n) {
    complaintsNew = n;
    const tab = $('tabs').querySelector('[data-tab="complaints"]');
    if (tab) tab.textContent = complaintsTabTitle();
  }

  /** Что сейчас с тем, на что пожаловались: метка статуса или «удалено». */
  function targetState(c) {
    if (c.target_state === null) return badge(['Удалено', '']);
    return LISTING_STATUS[c.target_state] ? badge(LISTING_STATUS[c.target_state]) : null;
  }

  function viewComplaints(root) {
    const list = listView({
      filters: [
        { type: 'search', name: 'q', placeholder: 'Название, текст жалобы, телефон или имя' },
        // keepAll: «Все» здесь — настоящий отбор, без параметра сервер отдаёт только новые.
        { type: 'select', name: 'status', label: 'Статус', keepAll: true, options: [
          ['new', 'Новые'], ['resolved', 'Меры приняты'], ['rejected', 'Отклонены'], ['all', 'Все'],
        ] },
        { type: 'select', name: 'target_type', label: 'На что жалоба', options: [
          ['all', 'На что угодно'], ['provider', 'Объявления'], ['review', 'Отзывы'], ['chat', 'Переписка'],
        ] },
      ],
      fetchPage: async (p) => {
        const data = await call('GET', '/admin/api/complaints' + query(p));
        setComplaintsNew(data.new_total);
        return data;
      },
      emptyText: 'Жалоб нет',
      renderItem: (c, reload) => row({
        href: '#complaints/' + c.id,
        open: () => openComplaint(c.id, reload),
        title: `${c.target_type_label}: ${c.target_label || '—'}`,
        lines: [
          el('div', { class: 'meta', text: `${c.reason_label} · ${fmtDate(c.created_at)} · от ${person(c.reporter_phone, c.reporter_name)}` }),
          c.comment ? el('div', { class: 'quote', text: c.comment }) : null,
        ],
        side: [
          badge(COMPLAINT_STATUS[c.status]),
          c.status === 'new' && c.same_target_open > 1 ? badge([`жалоб на это: ${c.same_target_open}`, 'bad']) : null,
        ],
      }),
    });
    root.append(el('h2', { text: 'Жалобы' }),
      el('p', { class: 'muted', text: 'Жалобы из приложения на объявления, отзывы и собеседников. Сама жалоба ничего не меняет: откройте то, на что пожаловались, решите, что делать, и закройте жалобу с пометкой.' }),
      list.node);
  }

  /** Пометка к закрытию жалобы. Вернёт { note, same } или null, если передумали. */
  function askNote({ title, text, confirmLabel, danger, others, othersByDefault }) {
    return new Promise((resolve) => {
      let answer = null;
      const input = el('textarea', { maxLength: 500, placeholder: 'Например: объявление скрыто, владелец предупреждён' });
      const same = others ? el('input', { type: 'checkbox', checked: Boolean(othersByDefault) }) : null;
      const win = modal({
        title,
        slim: true,
        body: [
          el('p', { text }),
          labeled('Пометка (необязательно)', input),
          el('p', { class: 'muted small', text: 'Пометку увидят только админы — здесь и в журнале действий.' }),
          same ? el('label', { class: 'check' }, same, `Закрыть так же остальные жалобы на это же: ${others}`) : null,
        ],
        foot: [
          el('button', { class: 'btn ghost', type: 'button', text: 'Отмена', onclick: () => win.close() }),
          el('button', {
            class: 'btn' + (danger ? ' danger solid' : ''), type: 'button', text: confirmLabel,
            onclick: () => { answer = { note: input.value.trim(), same: same ? same.checked : false }; win.close(); },
          }),
        ],
        onClose: () => resolve(answer),
      });
      input.focus();
    });
  }

  async function openComplaint(id, onChange) {
    const win = modal({ title: 'Жалоба', body: el('p', { class: 'muted', text: 'Загрузка…' }) });
    const changed = () => { if (onChange) onChange(); };

    let loads = 0;
    async function load(again) {
      const mine = ++loads;
      let c;
      try {
        c = (await call('GET', '/admin/api/complaints/' + id)).complaint;
      } catch (e) {
        if (mine === loads) { win.close(); if (!gone(e, again)) toast(e.message, true); }
        return;
      }
      if (mine !== loads) return;

      const refresh = () => { load(true); changed(); };
      const userLink = (phone, name, userId) => entityLink(person(phone, name), '#users/' + userId, () => openUser(userId, refresh));

      // На что жалоба: объявление открывается из жалобы, пока оно существует.
      const listing = c.provider_id
        ? entityLink(c.target_label || 'Объявление', '#providers/' + c.provider_id, () => openProvider(c.provider_id, refresh))
        : (c.target_label || '—');
      const about = c.target_type === 'review' ? ['Отзыв об объявлении «', listing, '»']
        : c.target_type === 'chat' ? ['Переписка об объявлении «', listing, '»']
        : [listing];

      const body = [
        facts([
          ['Статус', badge(COMPLAINT_STATUS[c.status])],
          ['Причина', c.reason_label],
          ['Что написал заявитель', c.comment || '—'],
          ['На что', [...about, ' ', targetState(c)]],
          c.target_type === 'review' ? ['Текст отзыва', c.target_text || 'без текста'] : null,
          ['На кого', c.target_user_phone
            ? [userLink(c.target_user_phone, c.target_user_name, c.target_user_id),
              c.target_user_blocked ? [' ', badge(['Заблокирован', 'bad'])] : null]
            : 'аккаунт удалён'],
          ['Кто пожаловался', c.reporter_phone
            ? userLink(c.reporter_phone, c.reporter_name, c.reporter_id)
            : 'аккаунт удалён'],
          ['Подана', fmtDate(c.created_at)],
          c.status === 'new' && c.same_target_open > 1 ? ['Ещё жалоб на это же', String(c.same_target_open - 1)] : null,
          c.status !== 'new' ? ['Закрыта', `${fmtDate(c.resolved_at)}${c.resolved_by_phone ? ' · ' + fmtPhone(c.resolved_by_phone) : ''}`] : null,
          c.status !== 'new' ? ['Пометка', c.resolution || '—'] : null,
        ].filter(Boolean)),
        c.target_type === 'chat'
          ? el('p', { class: 'muted small', text: 'Саму переписку админка не показывает. Если слов заявителя мало — напишите ему и попросите снимки экрана.' })
          : null,
      ];

      const closeWith = (outcome, title, text, confirmLabel, done, danger) => async () => {
        const answer = await askNote({
          title, text, confirmLabel, danger,
          others: c.same_target_open > 1 ? c.same_target_open - 1 : 0,
          // Меры приняты к самому объявлению — значит, по всем жалобам на него.
          // А отклонить не глядя остальные, с другими причинами, — нет.
          othersByDefault: outcome === 'resolved',
        });
        if (!answer) return;
        // same_target_upto — последняя жалоба, которую здесь видели: пришедшая
        // позже останется новой.
        const sent = { outcome, note: answer.note || null, same_target_upto: answer.same ? c.same_target_last : null };
        if (await run(() => call('POST', `/admin/api/complaints/${id}/close`, sent), done)) { win.close(); changed(); return; }
        // Не вышло — скорее всего, жалобу уже закрыл другой админ: показываем, как есть сейчас.
        load(true);
        changed();
      };

      const foot = [];
      if (c.target_type === 'review' && c.target_state === 'exists') {
        foot.push(el('button', {
          class: 'btn danger', type: 'button', text: 'Удалить отзыв',
          onclick: async () => {
            const sure = await confirmAction({
              title: 'Удалить отзыв?', confirmLabel: 'Удалить', danger: true,
              text: 'Отзыв исчезнет насовсем, оценка объявления пересчитается, а оставить новый по той же заявке автор не сможет. Жалобу после этого закройте отдельно.',
            });
            if (sure && await run(() => call('DELETE', '/admin/api/reviews/' + c.target_id), 'Отзыв удалён')) refresh();
          },
        }));
      }
      if (c.status === 'new') {
        foot.push(el('button', {
          class: 'btn ghost', type: 'button', text: 'Отклонить жалобу',
          onclick: closeWith('rejected', 'Отклонить жалобу?', 'Жалоба не подтвердилась: ничего менять не нужно.', 'Отклонить', 'Жалоба отклонена'),
        }));
        foot.push(el('button', {
          class: 'btn', type: 'button', text: 'Меры приняты',
          onclick: closeWith('resolved', 'Закрыть жалобу?', 'Вы уже сделали, что нужно: скрыли объявление, удалили отзыв или заблокировали человека.', 'Закрыть', 'Жалоба закрыта'),
        }));
      }
      win.fill(body, foot);
      win.node.querySelector('h2').textContent = `Жалоба №${c.id}`;
    }
    load();
  }

  // ---- Заявки ---------------------------------------------------------------

  function viewBookings(root) {
    const list = listView({
      filters: [
        { type: 'search', name: 'q', placeholder: 'Объявление, адрес или телефон клиента' },
        { type: 'select', name: 'status', label: 'Статус', options: [
          ['all', 'Любой статус'], ['pending', 'Ожидают ответа'], ['confirmed', 'Приняты'],
          ['rejected', 'Отклонены'], ['cancelled', 'Отменены клиентом'],
        ] },
      ],
      fetchPage: (p) => call('GET', '/admin/api/bookings' + query(p)),
      emptyText: 'Заявок не нашлось',
      renderItem: (b) => el('div', { class: 'item' },
        el('div', { class: 'grow' },
          el('div', { class: 'title', text: b.subject || '—' }),
          el('div', { class: 'meta', text: `к ${fmtDay(b.event_date)}` + (b.address ? ` · ${b.address}` : '') }),
          el('div', { class: 'meta' }, 'Клиент: ',
            entityLink(person(b.client_phone, b.client_name), '#users/' + b.client_id, () => openUser(b.client_id)),
            ` · создана ${fmtDate(b.created_at)}`),
          b.comment ? el('div', { class: 'quote', text: b.comment }) : null,
          b.rejected_reason ? el('div', { class: 'quote', text: 'Причина отказа: ' + b.rejected_reason }) : null),
        el('div', { class: 'side' }, badge(BOOKING_STATUS[b.status]))),
    });
    root.append(el('h2', { text: 'Заявки' }),
      el('p', { class: 'muted', text: 'Только просмотр: отвечает на заявку владелец, отменяет — клиент.' }), list.node);
  }

  // ---- Отзывы ---------------------------------------------------------------

  function viewReviews(root) {
    const list = listView({
      filters: [
        { type: 'search', name: 'q', placeholder: 'Текст отзыва, объявление или автор' },
        { type: 'select', name: 'rating', label: 'Оценка', options: [['all', 'Любая оценка'], [5, '5 звёзд'], [4, '4 звезды'], [3, '3 звезды'], [2, '2 звезды'], [1, '1 звезда']] },
      ],
      fetchPage: (p) => call('GET', '/admin/api/reviews' + query(p)),
      emptyText: 'Отзывов не нашлось',
      renderItem: (r, reload) => el('div', { class: 'item' },
        el('div', { class: 'grow' },
          el('div', { class: 'title', text: `${stars(r.rating)} ${r.subject || '—'}` }),
          el('div', { class: 'meta' },
            entityLink(person(r.author_phone, r.author_name), '#users/' + r.author_id, () => openUser(r.author_id, reload)),
            ` · ${fmtDate(r.created_at)}`),
          r.text ? el('div', { class: 'quote', text: r.text }) : el('div', { class: 'meta', text: 'Без текста' }),
          r.owner_reply ? el('div', { class: 'quote', text: 'Ответ владельца: ' + r.owner_reply }) : null),
        el('div', { class: 'side' }, el('button', {
          class: 'btn danger small', type: 'button', text: 'Удалить',
          onclick: async () => {
            const sure = await confirmAction({
              title: 'Удалить отзыв?', confirmLabel: 'Удалить', danger: true,
              text: 'Отзыв исчезнет насовсем, оценка объявления пересчитается, а оставить новый по той же заявке автор не сможет. Текст останется в журнале действий.',
            });
            if (sure && await run(() => call('DELETE', '/admin/api/reviews/' + r.id), 'Отзыв удалён')) reload();
          },
        }))),
    });
    root.append(el('h2', { text: 'Отзывы' }), list.node);
  }

  // ---- Журнал ошибок ------------------------------------------------------

  function viewLogs(root) {
    const list = listView({
      filters: [
        { type: 'select', name: 'kind', label: 'Что показать', options: [
          ['back', 'Ошибки сервера'], ['front', 'Ошибки приложения'], ['warns', 'Отказы (4xx)'],
        ] },
        { type: 'search', name: 'q', placeholder: 'Текст ошибки или адрес' },
      ],
      fetchPage: (p) => call('GET', '/admin/api/logs' + query(p)),
      emptyText: 'Записей нет',
      renderItem: (entry) => {
        const title = (entry.code ? entry.code + ' · ' : '') + (entry.message || '—');
        const meta = el('div', { class: 'meta', text: [fmtDate(entry.created_at), entry.place, entry.user_phone ? fmtPhone(entry.user_phone) : null].filter(Boolean).join(' · ') });
        if (!entry.details) {
          return el('div', { class: 'item' }, el('div', { class: 'grow' }, el('div', { class: 'title', text: title }), meta));
        }
        const details = el('pre', { class: 'pre', id: `log-details-${entry.id}`, text: entry.details });
        details.hidden = true;
        // Раскрывает кнопка в заголовке: до неё доходит Tab, а диктор говорит,
        // раскрыты ли подробности. Мышью можно нажать в любое место строки.
        const toggle = el('button', {
          class: 'title disclose', type: 'button', text: title,
          'aria-expanded': 'false', 'aria-controls': details.id,
        });
        const node = el('div', {
          class: 'item click',
          onclick: (e) => {
            // Нажатие внутри раскрытых подробностей строку не сворачивает. Не
            // сворачивает её и нажатие, которым закончили выделять текст в
            // этой строке: иначе текст ошибки было бы не скопировать. Кнопки в
            // заголовке это не касается — по ней нажимают, чтобы свернуть, —
            // и нажатия с клавиатуры тоже (у него e.detail — ноль).
            if (e.target.closest('pre')) return;
            const selection = window.getSelection();
            if (e.detail && !e.target.closest('button') && !selection.isCollapsed
                && node.contains(selection.anchorNode)) return;
            details.hidden = !details.hidden;
            toggle.setAttribute('aria-expanded', String(!details.hidden));
          },
        }, el('div', { class: 'grow' }, toggle, meta, details));
        return node;
      },
    });
    root.append(el('h2', { text: 'Журнал ошибок' }),
      el('p', { class: 'muted', text: 'Ошибки сервера — сбои на бэке, ошибки приложения — что прислали телефоны, отказы — ответы «нельзя» и «не найдено». Нажмите на строку, чтобы увидеть подробности.' }),
      list.node);
  }

  // ---- Действия админов ---------------------------------------------------

  function viewActions(root) {
    const list = listView({
      fetchPage: (p) => call('GET', '/admin/api/actions' + query(p)),
      emptyText: 'Действий пока не было',
      renderItem: (a) => {
        // Запись без названия — обезличенная: человек, о котором она была, удалил аккаунт.
        const about = a.target_label
          || (a.target_type === 'user' && a.target_id ? `аккаунт №${a.target_id}` : 'данные удалены вместе с аккаунтом');
        return el('div', { class: 'item' },
          el('div', { class: 'grow' },
            el('div', { class: 'title', text: `${ACTIONS[a.action] || a.action}: ${about}` }),
            el('div', { class: 'meta', text: `${fmtDate(a.created_at)} · ${a.admin_phone ? fmtPhone(a.admin_phone) : 'админ, чей аккаунт удалён'}` }),
            a.details ? el('div', { class: 'quote', text: a.details }) : null));
      },
    });
    root.append(el('h2', { text: 'Действия админов' }),
      el('p', { class: 'muted', text: 'Кто из администраторов что скрыл, заблокировал или удалил — и почему. Когда человек удаляет аккаунт, его номер, имя и названия объявлений из записей стираются; остаётся само действие и причина.' }),
      list.node);
  }

  // ---- Служебные аккаунты -------------------------------------------------

  async function viewService(root) {
    const listNode = el('div', { class: 'list' });
    // Это не данные самого админа: подставлять его номер и имя браузеру незачем.
    const phone = plain(el('input', { type: 'tel', name: 'service-phone', placeholder: '+7 700 000 00 01' }));
    const name = plain(el('input', { name: 'service-name', placeholder: 'Google Play review' }));
    const code = plain(el('input', { name: 'service-code', inputMode: 'numeric', maxLength: 4, placeholder: '1234' }));
    const error = el('div', { class: 'error', role: 'alert' });

    const patch = (u, body, done) => run(() => call('PATCH', '/admin/api/service-users/' + u.id, body), done).then((ok) => { if (ok) load(); });

    const item = (u) => el('div', { class: 'item' },
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, entityLink(fmtPhone(u.phone), '#users/' + u.id, () => openUser(u.id, load),
          { title: 'Открыть аккаунт: объявления, заявки, удаление' })),
        el('div', { class: 'meta', text: u.full_name || '—' }),
        el('div', { class: 'row' },
          el('button', {
            class: 'btn ghost small', type: 'button', text: 'Сменить код',
            onclick: async () => {
              const next = plain(el('input', { inputMode: 'numeric', maxLength: 4, placeholder: '4 цифры' }));
              const problem = el('div', { class: 'error', role: 'alert' });
              let value = null;
              const win = modal({
                title: 'Новый код', slim: true,
                body: [el('p', { text: `${fmtPhone(u.phone)}: старый код сразу перестанет работать.` }), labeled('Новый код', next), problem],
                foot: [
                  el('button', { class: 'btn ghost', type: 'button', text: 'Отмена', onclick: () => win.close() }),
                  el('button', {
                    class: 'btn', type: 'button', text: 'Сменить',
                    onclick: () => {
                      if (!/^\d{4}$/.test(next.value.trim())) { problem.textContent = 'Код — ровно 4 цифры'; next.focus(); return; }
                      value = next.value.trim();
                      win.close();
                    },
                  }),
                ],
                onClose: () => { if (value !== null) patch(u, { code: value }, 'Код изменён'); },
              });
              next.focus();
            },
          }),
          el('button', {
            class: 'btn small ' + (u.is_blocked ? 'ghost' : 'danger'), type: 'button', text: u.is_blocked ? 'Включить' : 'Отключить',
            onclick: async () => {
              const sure = await confirmAction({
                title: (u.is_blocked ? 'Включить ' : 'Отключить ') + fmtPhone(u.phone) + '?',
                confirmLabel: u.is_blocked ? 'Включить' : 'Отключить', danger: !u.is_blocked,
                text: u.is_blocked
                  ? 'Этим номером и кодом снова можно будет войти, а объявления аккаунта вернутся в поиск.'
                  : 'Вход и уже открытые сессии этого аккаунта перестанут работать, а его объявления пропадут из поиска.',
              });
              if (sure) patch(u, { is_blocked: !u.is_blocked }, u.is_blocked ? 'Включён' : 'Отключён');
            },
          }))),
      el('div', { class: 'side' },
        el('div', { class: 'code', text: u.code || '—' }),
        badge(u.is_blocked ? ['отключён', 'bad'] : ['активен', 'ok'])));

    async function load() {
      try {
        const data = await call('GET', '/admin/api/service-users');
        listNode.replaceChildren(...(data.items.length
          ? data.items.map(item)
          : [el('div', { class: 'empty', text: 'Пока нет ни одного служебного аккаунта' })]));
      } catch (e) { toast(e.message, true); }
    }

    const create = el('button', {
      class: 'btn', type: 'button', text: 'Создать',
      onclick: async () => {
        error.textContent = '';
        const body = { phone: phone.value.trim(), full_name: name.value.trim() };
        if (code.value.trim()) body.code = code.value.trim();
        if (!body.phone || !body.full_name) { error.textContent = 'Заполните телефон и имя'; return; }
        create.disabled = true;
        try {
          await call('POST', '/admin/api/service-users', body);
          phone.value = ''; name.value = ''; code.value = '';
          toast('Аккаунт создан');
          load();
        } catch (e) { error.textContent = e.message; } finally { create.disabled = false; }
      },
    });

    root.append(
      el('h2', { text: 'Служебные аккаунты' }),
      el('p', { class: 'muted', text: 'Входят в приложение по постоянному коду, без SMS. Для проверяющих Google Play и App Store и для проверки приложения на своих устройствах.' }),
      el('div', { class: 'panel' },
        el('strong', { text: 'Новый аккаунт' }),
        labeled('Телефон', phone),
        labeled('Имя', name),
        labeled('Код (4 цифры; пусто — придумаем сами)', code),
        el('div', { class: 'row' }, create), error),
      listNode,
    );
    load();
  }

  // ===================================================================
  // Разделы и вход
  // ===================================================================

  const TABS = [
    ['overview', 'Обзор', viewOverview],
    ['complaints', 'Жалобы', viewComplaints],
    ['users', 'Пользователи', viewUsers],
    ['providers', 'Объявления', viewProviders],
    ['bookings', 'Заявки', viewBookings],
    ['reviews', 'Отзывы', viewReviews],
    ['logs', 'Журнал ошибок', viewLogs],
    ['actions', 'Действия', viewActions],
    ['service', 'Служебные', viewService],
    ['settings', 'Настройки', viewSettings],
  ];

  // ---- Настройки: ключи интеграций ----------------------------------------

  const SETTING_SOURCE = {
    db: ['Задано здесь', 'ok'],
    env: ['Из .env', ''],
    none: ['Не задано', 'warn'],
    unreadable: ['Не расшифровывается', 'bad'],
  };
  const SETTINGS_NOTE = 'Ключ кассы или SMS в чужих руках — это деньги: без пароля его не поменяет тот, кому достался только ваш открытый вход.';

  async function viewSettings(root) {
    const list = el('div');
    const draw = (items) => {
      const groups = [];
      for (const s of items) {
        let g = groups.find((x) => x.name === s.group);
        if (!g) { g = { name: s.group, items: [] }; groups.push(g); }
        g.items.push(s);
      }
      list.replaceChildren(...groups.map((g) => el('div', { class: 'panel' },
        el('h3', { text: g.name }),
        el('div', { class: 'list' }, g.items.map((s) => el('div', { class: 'item' },
          el('div', { class: 'grow' },
            el('div', { class: 'title', text: s.label }),
            el('div', { class: 'meta', text: s.value == null ? 'значения нет' : s.kind === 'bool' ? (s.value === '1' ? 'включено' : 'выключено') : s.value }),
            s.hint ? el('div', { class: 'meta', text: s.hint }) : null,
            s.source === 'unreadable' ? el('div', { class: 'meta', text: 'Значение в базе зашифровано другим ключом (сменили SETTINGS_KEY или JWT_SECRET). Задайте его заново.' }) : null,
            s.updated_at ? el('div', { class: 'meta', text: `изменено ${fmtDate(s.updated_at)}${s.updated_by ? ' · ' + s.updated_by : ''}` }) : null),
          el('div', { class: 'side' },
            badge(SETTING_SOURCE[s.source]),
            el('div', { class: 'row' },
              el('button', { class: 'btn ghost small', type: 'button', text: 'Изменить', onclick: () => edit(s) }),
              s.source === 'db' || s.source === 'unreadable'
                ? el('button', { class: 'btn ghost small', type: 'button', text: 'Сбросить', onclick: () => reset(s) })
                : null))))))));
    };
    async function edit(s) {
      const input = s.kind === 'bool'
        ? el('select', { name: 'setting-value', 'data-first': '' }, el('option', { value: '1', text: 'Включено' }), el('option', { value: '0', text: 'Выключено' }))
        : plain(el('input', {
          name: 'setting-value',
          'data-first': '',
          type: s.secret ? 'password' : s.kind === 'int' ? 'number' : 'text',
          autocomplete: s.secret ? 'new-password' : 'off',
          value: s.secret || s.value == null ? '' : s.value,
        }));
      if (s.kind === 'bool') input.value = s.value === '1' ? '1' : '0';
      const done = await confirmByPassword({
        title: s.label,
        confirmLabel: 'Сохранить',
        text: s.secret
          ? 'Старое значение не показываем: введите новое целиком. Оно хранится зашифрованным и действует сразу, во всех процессах сервера — в течение 30 секунд.'
          : 'Новое значение действует сразу, во всех процессах сервера — в течение 30 секунд.',
        fields: [labeled(s.label, input)],
        note: SETTINGS_NOTE,
        send: (password) => call('PUT', '/admin/api/settings/' + encodeURIComponent(s.key), { value: input.value, password }),
      });
      if (done) { toast('Сохранено'); draw(done.items); }
    }
    async function reset(s) {
      const done = await confirmByPassword({
        title: 'Сбросить «' + s.label + '»?',
        confirmLabel: 'Сбросить',
        danger: true,
        text: `Значение из базы удалится, и снова будет действовать переменная ${s.env} из .env — или ничего, если её там нет.`,
        note: SETTINGS_NOTE,
        send: (password) => call('DELETE', '/admin/api/settings/' + encodeURIComponent(s.key), { password }),
      });
      if (done) { toast('Сброшено'); draw(done.items); }
    }
    draw((await call('GET', '/admin/api/settings')).items);
    root.append(
      el('h2', { text: 'Настройки' }),
      el('p', { class: 'muted', text: 'Ключи кассы, SMS, уведомлений и карт. Здесь заданное перекрывает .env на сервере; секреты хранятся в базе зашифрованными. В .env остаются только доступ к базе, JWT_SECRET и SETTINGS_KEY.' }),
      list);
  }

  // Разделы, где у записи есть своё окно: #users/57 откроет его сразу.
  const OPENERS = { users: openUser, providers: openProvider, complaints: openComplaint };

  let routeSeq = 0;
  async function route() {
    if ($('app').hidden) return;
    const [name, record] = location.hash.slice(1).split('/');
    const tab = TABS.find((t) => t[0] === name) || TABS[0];
    const strip = $('tabs');
    // Разделы — ссылки, а не кнопки: адрес раздела можно скопировать. Строим
    // их один раз и дальше только переставляем отметку: пересоздание уносило
    // бы фокус с раздела, на который только что нажали с клавиатуры.
    if (!strip.children.length) {
      strip.replaceChildren(...TABS.map(([key, title]) => el('a', {
        class: 'tab', href: '#' + key, 'data-tab': key,
        text: key === 'complaints' ? complaintsTabTitle() : title,
      })));
    }
    for (const link of strip.children) {
      if (link.dataset.tab === tab[0]) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    // Фокус стоял внутри раздела (карточка обзора) — после смены раздела он
    // пропал бы вместе с ней. Запоминаем, чтобы поставить на новое содержимое.
    const focusWasInView = $('view').contains(document.activeElement);
    // Адрес вида #complaints/41 ведёт на одну запись: так приходят из
    // уведомления о жалобе и так открывается ссылка на человека в новой вкладке.
    // Адрес сразу укорачиваем до раздела — иначе обновление страницы открывало
    // бы окно снова.
    const recordId = Number(record);
    if (record && Number.isInteger(recordId) && recordId > 0 && OPENERS[tab[0]]) {
      history.replaceState(null, '', '#' + tab[0]);
      OPENERS[tab[0]](recordId, route);
    }
    // На узком экране разделы не помещаются в ряд — открытый должен быть виден.
    // Полосу двигаем сами, а не через scrollIntoView: тот заодно переносит
    // место, с которого браузер начинает обход по Tab, и первой остановкой
    // оказывался раздел после открытого, а не кнопка «К содержимому».
    const current = strip.querySelector('[aria-current]');
    const currentEnd = current.offsetLeft + current.offsetWidth;
    if (current.offsetLeft < strip.scrollLeft) strip.scrollLeft = current.offsetLeft;
    else if (currentEnd > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = currentEnd - strip.clientWidth;
    const mine = ++routeSeq;
    const root = el('div');
    $('view').replaceChildren(el('p', { class: 'muted', text: 'Загрузка…' }));
    window.scrollTo(0, 0);
    try {
      await loadDicts();
      await tab[2](root);
      if (mine === routeSeq) {
        $('view').replaceChildren(root);
        if (focusWasInView) $('view').focus();
      }
    } catch (e) {
      if (mine === routeSeq && e.status !== 401) {
        $('view').replaceChildren(el('div', { class: 'panel' }, el('p', { class: 'error', text: e.message })));
      }
    }
  }
  window.addEventListener('hashchange', route);

  function screen(name) {
    $('login').hidden = name !== 'login';
    $('setpass').hidden = name !== 'setpass';
    $('denied').hidden = name !== 'denied';
    $('offline').hidden = name !== 'offline';
    $('app').hidden = name !== 'admin';
    $('skip').hidden = name !== 'admin';
    $('who').hidden = name === 'login' || name === 'offline';
    if (name !== 'admin') {
      [...openModals].forEach((close) => close());
      // Вышли — списков с номерами и именами на странице не остаётся и под спрятанным.
      $('view').replaceChildren();
      $('tabs').replaceChildren();
    }
    // Формы входа чистим и когда показываем вход, и когда уходим с него:
    // набранный пароль не должен оставаться в спрятанном поле. Кроме шага
    // «задать пароль» — он ещё часть входа.
    if (name !== 'setpass') resetLogin();
  }

  // Кто вошёл: по id прячем от него «снять права» с самого себя.
  let me = null;
  let loginPhone = '';
  // Токен, который сервер выдал после кода из SMS. В админку он не пускает и
  // нужен для одного — задать пароль. Живёт только в памяти страницы: в
  // хранилище лежит лишь вход по паролю.
  let smsToken = null;
  // Талон запроса кода: сервер выдаёт его вместе с «код отправлен» и проверяет
  // код только с ним. Помним и номер, на который код запрошен: поле номера
  // после запроса могли поправить.
  let smsTicket = null;

  /** Какую из двух форм входа показать: 'pass' — номер и пароль, 'sms' — код из SMS. */
  function loginForm(which) {
    $('pass-form').hidden = which !== 'pass';
    $('sms-form').hidden = which !== 'sms';
    // Пароль, набранный в первой форме, под спрятанным полем не оставляем.
    if (which === 'sms') { $('login-password').value = ''; $('login-error').textContent = ''; }
    // Набранный номер переезжает в другую форму: второй раз его не вводят.
    if (which === 'sms' && !$('phone').value) $('phone').value = $('login-phone').value;
    if (which === 'pass' && !$('login-phone').value) $('login-phone').value = $('phone').value;
    $(which === 'sms' ? 'phone' : 'login-phone').focus();
  }

  // Экран входа каждый раз начинается с чистого: без прошлого номера, пароля и поля кода.
  function resetLogin() {
    loginPhone = '';
    smsToken = null;
    smsTicket = null;
    for (const id of ['login-phone', 'login-password', 'phone', 'code', 'new-password', 'new-password2', 'setpass-phone']) $(id).value = '';
    $('code-block').hidden = true;
    $('verify').hidden = true;
    $('request').textContent = 'Получить код';
    $('request').className = 'btn';
    for (const id of ['login-error', 'sms-error', 'setpass-error']) $(id).textContent = '';
    $('pass-form').hidden = false;
    $('sms-form').hidden = true;
  }

  $('to-sms').addEventListener('click', () => loginForm('sms'));
  $('to-pass').addEventListener('click', () => loginForm('pass'));

  // ---- вход по номеру и паролю ----
  $('pass-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('login-submit');
    if (button.disabled) return;
    $('login-error').textContent = '';
    const phone = $('login-phone').value.trim();
    const password = $('login-password').value;
    if (!phone) { $('login-error').textContent = 'Введите номер'; $('login-phone').focus(); return; }
    if (!password) { $('login-error').textContent = 'Введите пароль'; $('login-password').focus(); return; }
    button.disabled = true;
    button.textContent = 'Входим…';
    try {
      const res = await api('POST', '/admin/api/login', { phone, password }, null);
      store.set(res.token);
      await enter();
    } catch (err) {
      $('login-error').textContent = err.message;
      $('login-password').focus();
      $('login-password').select();
    } finally {
      button.disabled = false;
      button.textContent = 'Войти';
    }
  });

  // ---- первый вход и смена пароля: код из SMS ----
  $('request').addEventListener('click', async () => {
    $('sms-error').textContent = '';
    loginPhone = $('phone').value.trim();
    if (!loginPhone) { $('sms-error').textContent = 'Введите номер'; $('phone').focus(); return; }
    $('request').disabled = true;
    let refused = null;
    try {
      const sent = await api('POST', '/admin/api/sms/request', { phone: loginPhone }, null);
      smsTicket = { phone: loginPhone, value: sent.ticket };
    } catch (err) {
      refused = err;
    } finally {
      $('request').disabled = false;
    }
    if (refused) $('sms-error').textContent = refused.message;
    // Отказ по лимиту поле кода не прячет, если код на этот номер здесь уже
    // запрашивали: он ещё может действовать.
    if (refused && !(refused.status === 429 && smsTicket && smsTicket.phone === loginPhone)) return;
    $('code-block').hidden = false;
    $('verify').hidden = false;
    $('request').textContent = 'Отправить ещё раз';
    $('request').className = 'btn ghost';
    $('code').focus();
  });

  // Enter в форме: пока код не запрошен — «Получить код», потом — «Продолжить».
  $('sms-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('verify').hidden) { $('request').click(); return; }
    if ($('verify').disabled) return;
    $('sms-error').textContent = '';
    const code = $('code').value.trim();
    if (!code) { $('sms-error').textContent = 'Введите код из SMS'; $('code').focus(); return; }
    if (!smsTicket) { $('sms-error').textContent = 'Получите код ещё раз'; return; }
    $('verify').disabled = true;
    try {
      // Код верный — но в админку ведёт только пароль: сервер выдаёт токен,
      // которым можно одно — задать его.
      const who = await api('POST', '/admin/api/sms/verify',
        { phone: smsTicket.phone, ticket: smsTicket.value, code }, null);
      smsToken = who.token;
      $('who-name').textContent = who.full_name || fmtPhone(who.phone);
      $('setpass-phone').value = who.phone;
      $('setpass-title').textContent = who.has_password ? 'Новый пароль' : 'Задайте пароль';
      $('setpass-text').textContent = who.has_password
        ? `${fmtPhone(who.phone)}: номер подтверждён. Задайте новый пароль — прежний перестанет действовать, а открытые входы в админку закроются.`
        : `${fmtPhone(who.phone)}: номер подтверждён. Задайте пароль для админки — дальше будете входить по номеру и паролю, без SMS.`;
      $('code').value = '';
      screen('setpass');
      $('new-password').focus();
    } catch (err) {
      $('sms-error').textContent = err.message;
    } finally {
      $('verify').disabled = false;
    }
  });

  // ---- пароль после SMS ----
  $('setpass-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('setpass-submit');
    if (button.disabled) return;
    $('setpass-error').textContent = '';
    const password = $('new-password').value;
    if (password.length < 8) {
      $('setpass-error').textContent = 'Пароль должен быть не короче 8 символов';
      $('new-password').focus();
      return;
    }
    if (password !== $('new-password2').value) {
      $('setpass-error').textContent = 'Пароли не совпадают. Наберите пароль во втором поле заново.';
      $('new-password2').focus();
      $('new-password2').select();
      return;
    }
    button.disabled = true;
    button.textContent = 'Сохраняем…';
    try {
      const res = await api('POST', '/admin/api/password', { password }, smsToken);
      store.set(res.token);
      await enter();
    } catch (err) {
      if (err.status === 401) {
        // Подтверждение по SMS устарело или уже использовано — за новым кодом.
        screen('login');
        loginForm('sms');
        $('sms-error').textContent = err.message;
        return;
      }
      if (err.status === 403) { $('who-name').textContent = ''; screen('denied'); return; }
      $('setpass-error').textContent = err.message;
      $('new-password').focus();
      $('new-password').select();
    } finally {
      button.disabled = false;
      button.textContent = 'Сохранить и войти';
    }
  });

  $('logout').addEventListener('click', () => { store.clear(); screen('login'); $('login-phone').focus(); });

  async function enter() {
    if (!store.get()) { screen('login'); return; }
    try {
      me = await api('GET', '/admin/api/me');
      $('who-name').textContent = me.full_name || fmtPhone(me.phone);
      screen('admin');
      route();
      // Число новых жалоб на вкладке — сразу, в каком бы разделе ни открыли
      // админку. Не дожидаемся и на сбой не реагируем: это только метка.
      api('GET', '/admin/api/complaints?page_size=1').then((d) => setComplaintsNew(d.new_total), () => {});
    } catch (e) {
      if (e.status === 403) { $('who-name').textContent = ''; screen('denied'); $('logout').focus(); return; }
      if (e.status === 401) { store.clear(); screen('login'); return; }
      // Сервер не ответил или ответил сбоем (выкладка, обрыв связи). Вход не
      // трогаем: он ещё действует, и пароль заново вводить незачем.
      $('offline-text').textContent = e.message;
      screen('offline');
      $('retry').focus();
    }
  }

  $('retry').addEventListener('click', enter);
  // Кнопка, а не ссылка на #view: адрес после # здесь — раздел админки.
  $('skip').addEventListener('click', () => $('view').focus());

  enter();
})();
