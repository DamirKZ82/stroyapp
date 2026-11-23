/*
 * Веб-кабинет продавца StroyApp.
 *
 * Без сборки и библиотек: страница отдаётся сервером как есть. Данные — из
 * того же API, что у приложения, с обычным токеном пользователя. Текст от
 * людей (имена, заявки, сообщения) вставляется только через textContent:
 * innerHTML здесь не используется ни для чего, что пришло с сервера.
 */
(() => {
  'use strict';

  const TOKEN_KEY = 'stroyapp_cabinet_token';
  const REQUEST_TIMEOUT_MS = 30000;
  // Заявки и счётчики перечитываем раз в полминуты, открытую переписку — чаще.
  const POLL_MS = 30000;
  const CHAT_POLL_MS = 5000;

  const UNITS = [
    ['piece', 'шт'], ['m2', 'м²'], ['m3', 'м³'], ['m', 'м'], ['kg', 'кг'], ['ton', 'т'],
    ['bag', 'мешок'], ['pack', 'упак.'], ['roll', 'рулон'], ['sheet', 'лист'], ['liter', 'л'],
    ['hour', 'час'], ['day', 'день'], ['trip', 'рейс'], ['object', 'объект'], ['work', 'весь объём'],
  ];
  const UNIT_NAME = Object.fromEntries(UNITS);
  // Сокращения, с которыми прайс обычно лежит в Excel, — для вставки списком.
  const UNIT_ALIASES = {
    'шт': 'piece', 'шт.': 'piece', 'штук': 'piece', 'штука': 'piece',
    'м2': 'm2', 'м²': 'm2', 'кв.м': 'm2', 'кв м': 'm2', 'м3': 'm3', 'м³': 'm3', 'куб': 'm3', 'куб.м': 'm3',
    'м': 'm', 'м.': 'm', 'пм': 'm', 'п.м': 'm', 'кг': 'kg', 'т': 'ton', 'тн': 'ton', 'тонна': 'ton',
    'мешок': 'bag', 'меш': 'bag', 'меш.': 'bag', 'упак': 'pack', 'упак.': 'pack', 'уп': 'pack',
    'рулон': 'roll', 'рул': 'roll', 'лист': 'sheet', 'л': 'liter', 'литр': 'liter',
    'час': 'hour', 'ч': 'hour', 'день': 'day', 'рейс': 'trip', 'объект': 'object',
  };
  const ITEM_NAME_MAX = 200;

  const STATUS = {
    pending: ['Новая', 'warning'],
    confirmed: ['Принята', 'success'],
    rejected: ['Отклонена', 'danger'],
    cancelled: ['Отменена клиентом', 'muted'],
  };
  const FILTERS = [['pending', 'Новые'], ['confirmed', 'Принятые'], ['rejected', 'Отклонённые'], ['', 'Все']];
  const TIER = {
    trial: ['Пробный период', 'primary'],
    pro: ['Pro', 'success'],
    free: ['Бесплатный', 'muted'],
    none: ['Пробный период ещё не начался', 'muted'],
  };
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
    'сентября', 'октября', 'ноября', 'декабря'];

  // ---------------------------------------------------------------------
  // Мелочи
  // ---------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  /** Элемент: h('div', {class: 'x', onclick}, 'текст', child). Текст — только как текст. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /** replaceChildren, пропускающий пустые места: сам он превратил бы null в текст «null». */
  function put(el, ...children) {
    el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  }

  const store = {
    get() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return memToken; } },
    set(t) { memToken = t; try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* приватный режим */ } },
    clear() { memToken = null; try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* */ } },
  };
  let memToken = null;

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = store.get();
    if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
      });
    } catch (e) {
      throw new ApiError(0, e && e.name === 'TimeoutError'
        ? 'Сервер не ответил за полминуты. Попробуйте ещё раз.'
        : 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* ответ без тела */ }
    if (res.status === 401 && token) {
      // Вход истёк или токен отозван — на экран входа, без окна с ошибкой.
      logout();
      throw new ApiError(401, 'Вход истёк — войдите снова');
    }
    if (!res.ok) {
      const msg = res.status >= 500 || !data.message
        ? 'Что-то пошло не так. Попробуйте ещё раз.'
        : data.message;
      throw new ApiError(res.status, msg);
    }
    return data;
  }

  let toastTimer = 0;
  function toast(text, isError) {
    const el = $('toast');
    el.textContent = text;
    el.className = 'toast' + (isError ? ' err' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3000);
  }

  /** Кнопка занята, пока идёт действие; повторное нажатие ничего не шлёт. */
  async function busy(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { return await fn(); } finally { btn.disabled = false; }
  }

  function normalizePhone(raw) {
    let d = (raw || '').replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
    if (d.length === 10 && d.startsWith('7')) d = '7' + d;
    if (d.length !== 11 || !d.startsWith('77')) return null;
    return '+' + d;
  }
  function showPhone(p) {
    const d = (p || '').replace(/\D/g, '');
    if (d.length !== 11) return p || '';
    return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9)}`;
  }
  /** 'YYYY-MM-DD' → '5 декабря 2026'. */
  function showDate(s) {
    if (!s) return '';
    const [y, m, d] = s.slice(0, 10).split('-');
    return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  }
  /** Время сервера 'YYYY-MM-DD HH:MM:SS' (Казахстан) → «5 дек, 14:30» или «14:30» сегодня. */
  function showStamp(s) {
    if (!s) return '';
    const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
    const time = s.slice(11, 16);
    if (s.slice(0, 10) === today) return time;
    const [, m, d] = s.slice(0, 10).split('-');
    return `${Number(d)} ${MONTHS[Number(m) - 1].slice(0, 3)}, ${time}`;
  }
  const money = (n) => (n === null || n === undefined) ? '' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸';

  // ---------------------------------------------------------------------
  // Вход
  // ---------------------------------------------------------------------

  let me = null;
  let pendingPhone = null;

  function showLogin(step) {
    $('app').hidden = true;
    $('who').hidden = true;
    $('login').hidden = false;
    for (const id of ['phone-form', 'code-form', 'profile-form']) $(id).hidden = id !== step;
    const focus = { 'phone-form': 'phone', 'code-form': 'code', 'profile-form': me && !me.full_name ? 'full-name' : 'terms' }[step];
    setTimeout(() => $(focus).focus(), 0);
  }

  $('phone-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const phone = normalizePhone($('phone').value);
    $('phone-error').textContent = '';
    if (!phone) {
      $('phone-error').textContent = 'Введите казахстанский номер полностью, например +7 701 123 45 67';
      return;
    }
    busy($('phone-submit'), async () => {
      try {
        await api('POST', '/auth/request-otp', { phone });
      } catch (err) {
        // «Код уже отправлен» — не беда: код из прошлого запроса ещё действует.
        if (err.status !== 429 || !/уже отправлен/.test(err.message)) {
          $('phone-error').textContent = err.message;
          return;
        }
      }
      pendingPhone = phone;
      $('code-phone').textContent = showPhone(phone);
      $('code').value = '';
      $('code-error').textContent = '';
      showLogin('code-form');
    });
  });

  $('code-back').addEventListener('click', () => showLogin('phone-form'));

  $('code').addEventListener('input', () => {
    // Код из SMS вставляют целиком — отправляем сразу, без лишнего нажатия.
    if (/^\d{4}$/.test($('code').value.trim())) $('code-form').requestSubmit();
  });

  $('code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('code').value.trim();
    $('code-error').textContent = '';
    if (!/^\d{4}$/.test(code)) {
      $('code-error').textContent = 'Код — 4 цифры из SMS';
      return;
    }
    busy($('code-submit'), async () => {
      try {
        const r = await api('POST', '/auth/verify-otp', { phone: pendingPhone, code });
        store.set(r.token);
        me = r.user;
        afterLogin();
      } catch (err) {
        $('code-error').textContent = err.message;
      }
    });
  });

  $('profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('profile-error').textContent = '';
    const needName = !me.full_name;
    const name = $('full-name').value.trim();
    if (needName && !name) { $('profile-error').textContent = 'Напишите, как вас зовут'; return; }
    if (!me.terms_accepted && !$('terms').checked) {
      $('profile-error').textContent = 'Чтобы продолжить, примите условия использования';
      return;
    }
    busy($('profile-submit'), async () => {
      try {
        if (!me.terms_accepted) {
          const r = await api('POST', '/profile/terms', { version: me.terms_version });
          me = r.user || { ...me, terms_accepted: true };
        }
        if (needName) {
          const r = await api('POST', '/auth/complete-profile', { full_name: name, language: me.language || 'ru' });
          me = { ...me, ...r.user };
        }
        afterLogin();
      } catch (err) {
        $('profile-error').textContent = err.message;
      }
    });
  });

  function afterLogin() {
    if (!me.full_name || !me.terms_accepted) {
      $('name-block').hidden = !!me.full_name;
      $('terms-block').hidden = !!me.terms_accepted;
      showLogin('profile-form');
      return;
    }
    $('login').hidden = true;
    $('app').hidden = false;
    $('who').hidden = false;
    $('who-name').textContent = me.full_name;
    route();
    startPolling();
  }

  function logout() {
    store.clear();
    me = null;
    stopPolling();
    stopChatPoll();
    cache.providers = null;
    $('phone').value = '';
    showLogin('phone-form');
  }

  $('logout').addEventListener('click', () => {
    if (dirtyGuard()) return;
    logout();
  });

  async function boot() {
    if (!store.get()) { showLogin('phone-form'); return; }
    try {
      const r = await api('GET', '/profile');
      me = r.user || r;
      afterLogin();
    } catch (err) {
      if (err.status !== 401) {
        // Сервер недоступен — не выкидываем из входа, показываем ошибку.
        showLogin('phone-form');
        $('phone-error').textContent = err.message;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Разделы
  // ---------------------------------------------------------------------

  const cache = { providers: null, chats: [], plan: null };
  let current = null;
  let leaveGuard = null;   // функция: true — есть несохранённое, уходить не надо

  function dirtyGuard() {
    return !!(leaveGuard && leaveGuard() &&
      !window.confirm('В прайсе есть несохранённые изменения. Уйти без сохранения?'));
  }

  window.addEventListener('beforeunload', (e) => {
    if (leaveGuard && leaveGuard()) { e.preventDefault(); e.returnValue = ''; }
  });

  let lastHash = location.hash;
  window.addEventListener('hashchange', () => {
    if (!me) return;
    if (dirtyGuard()) {
      history.replaceState(null, '', lastHash || '#price');
      return;
    }
    route();
  });

  const VIEWS = { bookings: viewBookings, chats: viewChats, price: viewPrice, plan: viewPlan };

  function route() {
    const [name, arg] = (location.hash.slice(1) || 'bookings').split('/');
    const view = VIEWS[name] ? name : 'bookings';
    lastHash = location.hash;
    leaveGuard = null;
    stopChatPoll();
    current = view;
    for (const a of document.querySelectorAll('.tabs a')) {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const root = $('view');
    root.replaceChildren(h('div', { class: 'spin' }, 'Загрузка…'));
    VIEWS[view](root, arg ? decodeURIComponent(arg) : null).catch((err) => {
      if (err.status === 401) return;
      root.replaceChildren(errorBlock(err.message, () => route()));
    });
  }

  function errorBlock(text, retry) {
    return h('div', { class: 'empty' },
      h('b', {}, 'Не получилось загрузить'), h('p', {}, text),
      h('p', {}, h('button', { class: 'btn outline', type: 'button', onclick: retry }, 'Повторить')));
  }

  async function providers(force) {
    if (!cache.providers || force) cache.providers = (await api('GET', '/providers/my')).items;
    return cache.providers;
  }

  function noListings() {
    return h('div', { class: 'empty' },
      h('b', {}, 'У вас пока нет объявлений'),
      h('p', {}, 'Создайте магазин или бригаду в приложении StroyApp: «Профиль» → «Мои объявления». Потом здесь появятся заявки, переписка и прайс.'));
  }

  // ---------------------------------------------------------------------
  // Заявки
  // ---------------------------------------------------------------------

  let bookingFilter = 'pending';

  async function viewBookings(root) {
    const [list, provs] = await Promise.all([
      api('GET', '/bookings/incoming' + (bookingFilter ? '?status=' + bookingFilter : '')),
      providers(),
    ]);
    if (current !== 'bookings') return;
    if (!provs.length && !list.items.length) { root.replaceChildren(noListings()); return; }

    const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Статус заявок' },
      FILTERS.map(([value, label]) => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(bookingFilter === value),
        onclick: () => { bookingFilter = value; route(); },
      }, label)));

    const head = h('div', { class: 'head' }, h('h2', {}, 'Заявки'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => route() }, 'Обновить'));

    const body = list.items.length
      ? h('div', { class: 'cards' }, list.items.map(bookingCard))
      : h('div', { class: 'empty' },
          h('b', {}, bookingFilter === 'pending' ? 'Новых заявок нет' : 'Заявок нет'),
          h('p', {}, 'Новые заявки появятся здесь сами — страница проверяет их каждые полминуты.'));
    root.replaceChildren(head, chips, body);
  }

  function bookingCard(b) {
    const [label, tone] = STATUS[b.status] || [b.status, 'muted'];
    const client = b.client || {};
    const card = h('article', { class: 'card' });
    const actions = h('div', { class: 'actions' });

    const fill = () => {
      put(card,
        h('div', { class: 'who-line' },
          h('span', { class: 'name' }, client.name || 'Клиент'),
          h('span', { class: 'badge ' + tone }, label)),
        client.phone ? h('a', { class: 'meta', href: 'tel:' + client.phone }, showPhone(client.phone)) : null,
        b.ordered_by ? h('div', { class: 'meta' }, 'Оформил мастер клиента: ' +
          [b.ordered_by.name, showPhone(b.ordered_by.phone)].filter(Boolean).join(', ')) : null,
        h('div', { class: 'meta' }, (b.provider && b.provider.name) || 'Объявление удалено'),
        b.comment ? h('div', { class: 'what' }, b.comment) : null,
        h('div', { class: 'meta' }, 'К сроку: ' + showDate(b.event_date)),
        b.address ? h('div', { class: 'meta' }, 'Адрес: ' + b.address) : null,
        b.status === 'rejected' && b.rejected_reason ? h('div', { class: 'meta' }, 'Причина отказа: ' + b.rejected_reason) : null,
        h('div', { class: 'meta small' }, 'Пришла ' + showStamp(b.created_at)),
        actions,
      );
    };

    const setActions = () => {
      actions.replaceChildren();
      actions.append(h('button', { class: 'btn ghost small', type: 'button', onclick: () => openChatFor(b) }, 'Написать'));
      if (b.status === 'pending' || b.status === 'confirmed') {
        actions.append(h('button', { class: 'btn danger small', type: 'button', onclick: askReason }, 'Отклонить'));
      }
      if (b.status === 'pending') {
        const ok = h('button', { class: 'btn small', type: 'button' }, 'Принять');
        ok.addEventListener('click', () => busy(ok, async () => {
          try {
            const r = await api('POST', `/bookings/${b.guid}/confirm`);
            Object.assign(b, r.booking);
            toast('Заявка принята — клиент получил уведомление');
            refreshCard();
          } catch (err) { toast(err.message, true); }
        }));
        actions.append(ok);
      }
    };

    const askReason = () => {
      const input = h('textarea', { maxlength: 500, placeholder: 'Например: нет в наличии до конца месяца', 'aria-label': 'Причина отказа' });
      const send = h('button', { class: 'btn small', type: 'button' }, 'Отклонить заявку');
      const err = h('div', { class: 'error', role: 'alert' });
      send.addEventListener('click', () => {
        const reason = input.value.trim();
        if (!reason) { err.textContent = 'Напишите причину — клиент её увидит'; return; }
        busy(send, async () => {
          try {
            const r = await api('POST', `/bookings/${b.guid}/reject`, { reason });
            Object.assign(b, r.booking);
            toast('Заявка отклонена');
            refreshCard();
          } catch (e2) { err.textContent = e2.message; }
        });
      });
      actions.replaceChildren(h('div', { class: 'reject-box' },
        h('label', {}, 'Причина отказа — её увидит клиент'), input, err,
        h('div', { class: 'actions' },
          h('button', { class: 'btn ghost small', type: 'button', onclick: setActions }, 'Не отклонять'), send)));
      input.focus();
    };

    const refreshCard = () => {
      const [l2, t2] = STATUS[b.status] || [b.status, 'muted'];
      card.querySelector('.badge').textContent = l2;
      card.querySelector('.badge').className = 'badge ' + t2;
      fill();
      setActions();
      refreshCounts();
    };

    fill();
    setActions();
    return card;
  }

  async function openChatFor(b) {
    try {
      cache.chats = (await api('GET', '/chats')).items;
    } catch (err) { toast(err.message, true); return; }
    const chat = cache.chats.find((c) => c.booking && c.booking.guid === b.guid)
      || cache.chats.find((c) => c.is_owner && c.provider && b.provider && c.provider.guid === b.provider.guid
        && c.other_user && b.client && c.other_user.phone === b.client.phone);
    if (!chat) { toast('Переписки с этим клиентом нет', true); return; }
    location.hash = '#chats/' + encodeURIComponent(chat.guid);
  }

  // ---------------------------------------------------------------------
  // Сообщения
  // ---------------------------------------------------------------------

  let chatTimer = 0;
  function stopChatPoll() { clearInterval(chatTimer); chatTimer = 0; }

  async function viewChats(root, openGuid) {
    const r = await api('GET', '/chats');
    if (current !== 'chats') return;
    // Кабинет — для продавца: переписки, где человек сам клиент, — в приложении.
    cache.chats = r.items.filter((c) => c.is_owner);
    if (!cache.chats.length) {
      root.replaceChildren(h('div', { class: 'head' }, h('h2', {}, 'Сообщения')),
        h('div', { class: 'empty' }, h('b', {}, 'Переписок пока нет'),
          h('p', {}, 'Когда клиент напишет по вашему объявлению или отправит заявку, переписка появится здесь.')));
      return;
    }
    const layout = h('div', { class: 'chat-layout' + (openGuid ? ' open' : '') });
    const list = h('div', { class: 'chat-list', role: 'list' },
      cache.chats.map((c) => h('button', {
        class: 'chat-item', type: 'button', role: 'listitem', 'data-guid': c.guid,
        'aria-current': String(c.guid === openGuid),
        onclick: () => { location.hash = '#chats/' + encodeURIComponent(c.guid); },
      },
      h('span', { class: 'row1' },
        h('span', { class: 't' }, (c.other_user && c.other_user.name) || 'Клиент'),
        c.unread_count ? h('span', { class: 'count' }, c.unread_count) : h('span', { class: 'meta small nowrap' }, showStamp(c.last_message_at))),
      h('span', { class: 'p' }, (c.provider && c.provider.name) || ''),
      h('span', { class: 'p' }, c.last_message_preview || 'Сообщений пока нет'))));
    const thread = h('section', { class: 'thread' });
    layout.append(list, thread);
    root.replaceChildren(h('div', { class: 'head' }, h('h2', {}, 'Сообщения')), layout);

    if (!openGuid) {
      thread.append(h('div', { class: 'spin' }, 'Выберите переписку слева'));
      return;
    }
    await openThread(thread, openGuid);
  }

  async function openThread(thread, guid) {
    let data;
    try {
      data = await api('GET', '/chats/' + encodeURIComponent(guid));
    } catch (err) {
      thread.replaceChildren(h('div', { class: 'spin' }, err.message));
      return;
    }
    const chat = data.chat;
    const other = chat.other_user || {};
    const msgs = h('div', { class: 'messages', 'aria-live': 'polite' });
    let shown = 0;

    const draw = (messages, force) => {
      if (!force && messages.length === shown) return;
      const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
      msgs.replaceChildren(...(messages.length ? messages.map((m) => h('div', { class: 'msg' + (m.is_mine ? ' mine' : '') },
        m.text, h('time', {}, showStamp(m.created_at))))
        : [h('div', { class: 'spin' }, 'Сообщений пока нет — напишите первым')]));
      if (nearBottom || force || !shown) msgs.scrollTop = msgs.scrollHeight;
      shown = messages.length;
    };

    const text = h('textarea', { maxlength: 2000, placeholder: 'Сообщение', 'aria-label': 'Сообщение', disabled: !chat.can_write });
    const sendBtn = h('button', { class: 'btn', type: 'button', disabled: !chat.can_write }, 'Отправить');
    const send = () => busy(sendBtn, async () => {
      const value = text.value.trim();
      if (!value) return;
      try {
        await api('POST', `/chats/${encodeURIComponent(guid)}/messages`, { text: value });
        text.value = '';
        const item = document.querySelector(`.chat-item[data-guid="${CSS.escape(guid)}"] .p:last-child`);
        if (item) item.textContent = value.slice(0, 100);
        const fresh = await api('GET', '/chats/' + encodeURIComponent(guid));
        draw(fresh.messages, true);
      } catch (err) { toast(err.message, true); }
    });
    sendBtn.addEventListener('click', send);
    text.addEventListener('keydown', (e) => {
      // Enter — отправить, Shift+Enter — новая строка, как в мессенджерах на компьютере.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });

    thread.replaceChildren(
      h('div', { class: 'thread-head' },
        h('button', { class: 'link small chat-back', type: 'button', onclick: () => { location.hash = '#chats'; } }, '← Все переписки'),
        h('b', {}, other.name || 'Клиент'),
        h('span', { class: 'meta' }, [chat.provider && chat.provider.name, other.phone && showPhone(other.phone)].filter(Boolean).join(' · ')),
        chat.booking ? h('span', { class: 'meta' }, 'Заявка к ' + showDate(chat.booking.event_date) + ' — ' +
          ((STATUS[chat.booking.status] || [chat.booking.status])[0]).toLowerCase()) : null),
      msgs,
      chat.can_write ? h('div', { class: 'composer' }, text, sendBtn)
        : h('div', { class: 'composer meta' }, 'Писать в эту переписку нельзя: кто-то из вас заблокировал другого.'),
    );
    draw(data.messages, true);
    markRead(guid, chat.unread_count);
    if (chat.can_write) text.focus();

    stopChatPoll();
    chatTimer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const fresh = await api('GET', '/chats/' + encodeURIComponent(guid));
        draw(fresh.messages);
        markRead(guid, fresh.chat.unread_count);
      } catch (e) { /* следующий раз */ }
    }, CHAT_POLL_MS);
  }

  async function markRead(guid, unread) {
    if (!unread) return;
    try {
      await api('POST', `/chats/${encodeURIComponent(guid)}/mark-read`);
      refreshCounts();
    } catch (e) { /* не страшно */ }
  }

  // ---------------------------------------------------------------------
  // Прайс
  // ---------------------------------------------------------------------

  async function viewPrice(root, guid) {
    const [provs, sub] = await Promise.all([providers(true), api('GET', '/subscription')]);
    if (current !== 'price') return;
    if (!provs.length) { root.replaceChildren(noListings()); return; }
    const chosen = provs.find((p) => p.guid === guid) || provs[0];
    const full = (await api('GET', '/providers/' + encodeURIComponent(chosen.guid))).provider;
    if (current !== 'price') return;
    const limit = sub.plan.items_limit;
    const isPro = sub.plan.tier === 'pro' || sub.plan.tier === 'trial' || sub.plan.tier === 'none';

    // Рабочая копия прайса: правим её, сохраняем целиком (сервер так и хранит).
    let rows = full.items.map((it) => ({ name: it.name, unit: it.unit, price: it.price }));
    const saved = JSON.stringify(rows);
    leaveGuard = () => JSON.stringify(rows.map(clean)) !== saved;

    const picker = provs.length > 1 ? h('select', {
      'aria-label': 'Объявление',
      onchange: (e) => {
        if (dirtyGuard()) { e.target.value = chosen.guid; return; }
        leaveGuard = null;
        location.hash = '#price/' + encodeURIComponent(e.target.value);
      },
    }, provs.map((p) => h('option', { value: p.guid, selected: p.guid === chosen.guid }, p.name))) : null;

    const active = h('input', { type: 'checkbox', checked: chosen.is_active });
    active.addEventListener('change', async () => {
      const want = active.checked;
      active.disabled = true;
      try {
        await api('PATCH', '/providers/' + encodeURIComponent(chosen.guid), { is_active: want });
        chosen.is_active = want;
        toast(want ? 'Объявление снова в поиске' : 'Объявление снято с публикации');
      } catch (err) {
        active.checked = !want;
        toast(err.message, true);
      } finally { active.disabled = false; }
    });

    const tbody = h('tbody');
    const table = h('table', { class: 'price-table' },
      h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Название'), h('th', {}, 'Единица'), h('th', {}, 'Цена, ₸'), h('th', {}))),
      tbody);
    const counter = h('span', { class: 'meta' });
    const saveBtn = h('button', { class: 'btn', type: 'button' }, 'Сохранить прайс');
    const saveErr = h('div', { class: 'error', role: 'alert' });

    function clean(r) {
      return { name: (r.name || '').trim().replace(/\s+/g, ' '), unit: r.unit, price: r.price === '' || r.price === null || r.price === undefined ? null : Number(r.price) };
    }

    function updateCounter() {
      const n = rows.length;
      const dirty = leaveGuard();
      counter.textContent = `${n} ${plural(n, 'позиция', 'позиции', 'позиций')}` +
        (n > limit ? ` · видно в поиске первые ${limit}` : '') + (dirty ? ' · есть несохранённые изменения' : '');
    }

    function draw() {
      tbody.replaceChildren(...rows.map((r, i) => {
        const name = h('input', { value: r.name, maxlength: ITEM_NAME_MAX, 'aria-label': `Позиция ${i + 1}: название`, placeholder: 'Например: Газоблок 600×300×200' });
        name.addEventListener('input', () => { r.name = name.value; updateCounter(); });
        const unit = h('select', { 'aria-label': `Позиция ${i + 1}: единица` },
          UNITS.map(([code, label]) => h('option', { value: code, selected: code === r.unit }, label)));
        unit.addEventListener('change', () => { r.unit = unit.value; updateCounter(); });
        const price = h('input', { value: r.price ?? '', inputmode: 'numeric', 'aria-label': `Позиция ${i + 1}: цена`, placeholder: 'договорная' });
        price.addEventListener('input', () => {
          price.value = price.value.replace(/\D/g, '').slice(0, 10);
          r.price = price.value === '' ? null : Number(price.value);
          updateCounter();
        });
        const up = h('button', { class: 'icon-btn', type: 'button', title: 'Выше', 'aria-label': 'Выше', disabled: i === 0,
          onclick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); } }, '↑');
        const down = h('button', { class: 'icon-btn', type: 'button', title: 'Ниже', 'aria-label': 'Ниже', disabled: i === rows.length - 1,
          onclick: () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; draw(); } }, '↓');
        const del = h('button', { class: 'icon-btn del', type: 'button', title: 'Удалить', 'aria-label': 'Удалить позицию',
          onclick: () => { rows.splice(i, 1); draw(); } }, '✕');
        return h('tr', { class: (i >= limit ? 'hidden-row' : '') + (i === limit ? ' limit-line' : '') },
          h('td', { class: 'n' }, i + 1), h('td', { class: 'name' }, name), h('td', { class: 'unit' }, unit),
          h('td', { class: 'price' }, price), h('td', { class: 'ops' }, up, down, del));
      }));
      updateCounter();
    }

    const addBtn = h('button', { class: 'btn outline', type: 'button', onclick: () => {
      rows.push({ name: '', unit: rows.length ? rows[rows.length - 1].unit : 'piece', price: null });
      draw();
      tbody.lastElementChild.querySelector('input').focus();
    } }, '+ Добавить позицию');

    // Вставка из Excel или таблицы: строка — позиция, колонки через табуляцию
    // (или «;»): название, цена, единица. Порядок цены и единицы не важен.
    const pasteArea = h('textarea', { rows: 6, placeholder: 'Газоблок 600×300×200\t650\tшт\nЦемент М500\t2900\tмешок', 'aria-label': 'Позиции списком' });
    const pasteBox = h('div', { class: 'panel', hidden: true },
      h('h3', {}, 'Вставить списком'),
      h('p', { class: 'meta' }, 'Скопируйте колонки из Excel или Google Таблиц: название, цена, единица. Каждая строка — новая позиция в конце прайса. Без цены позиция будет «договорная», без единицы — «шт».'),
      pasteArea,
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { pasteBox.hidden = true; } }, 'Закрыть'),
        h('button', { class: 'btn', type: 'button', onclick: () => {
          const added = parsePaste(pasteArea.value);
          if (!added.length) { toast('Не нашли ни одной строки с названием', true); return; }
          rows.push(...added);
          pasteArea.value = '';
          pasteBox.hidden = true;
          draw();
          toast(`Добавлено ${added.length} ${plural(added.length, 'позиция', 'позиции', 'позиций')}. Не забудьте сохранить`);
        } }, 'Добавить в прайс')));

    saveBtn.addEventListener('click', () => busy(saveBtn, async () => {
      saveErr.textContent = '';
      const items = rows.map(clean);
      const empty = items.findIndex((it) => !it.name);
      if (empty >= 0) { saveErr.textContent = `У позиции ${empty + 1} нет названия — заполните или удалите её`; return; }
      try {
        const r = await api('PUT', `/providers/${encodeURIComponent(chosen.guid)}/items`, { items });
        rows = r.items.map((it) => ({ name: it.name, unit: it.unit, price: it.price }));
        const now = JSON.stringify(rows);
        leaveGuard = () => JSON.stringify(rows.map(clean)) !== now;
        draw();
        toast('Прайс сохранён — клиенты уже видят новые цены');
      } catch (err) { saveErr.textContent = err.message; }
    }));

    root.replaceChildren(
      h('div', { class: 'head' }, h('h2', {}, 'Прайс'), picker),
      h('div', { class: 'panel' },
        h('div', { class: 'head' },
          h('div', {}, h('h3', {}, chosen.name),
            h('div', { class: 'meta' }, [chosen.category && chosen.category.name_ru, chosen.verified ? 'Проверенный продавец' : null].filter(Boolean).join(' · '))),
          h('label', { class: 'check' }, active, h('span', {}, 'Показывать в поиске'))),
        !isPro && rows.length > limit ? h('div', { class: 'note warn' },
          `На бесплатном тарифе в поиске видны первые ${limit} позиций прайса. Остальные сохраняются и появятся с тарифом Pro. `,
          h('a', { href: '#plan' }, 'Подключить Pro')) : null,
        h('div', { class: 'note' }, 'Порядок здесь — порядок в карточке объявления. Пустая цена показывается как «договорная».'),
        table,
        h('div', { class: 'actions start' }, addBtn,
          h('button', { class: 'btn ghost', type: 'button', onclick: () => { pasteBox.hidden = false; pasteArea.focus(); } }, 'Вставить списком из Excel')),
        pasteBox,
        h('div', { class: 'sticky-save' }, counter, h('div', { class: 'actions tight' }, saveErr, saveBtn))));
    draw();
  }

  function parsePaste(text) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cols = (line.includes('\t') ? line.split('\t') : line.split(';')).map((c) => c.trim());
      const name = cols.shift().replace(/\s+/g, ' ').slice(0, ITEM_NAME_MAX);
      if (!name) continue;
      let price = null;
      let unit = 'piece';
      for (const c of cols) {
        const digits = c.replace(/[\s ₸тгTенге.,]+$/i, '').replace(/[\s ]/g, '');
        if (price === null && /^\d+([.,]\d+)?$/.test(digits)) { price = Math.round(Number(digits.replace(',', '.'))); continue; }
        const u = UNIT_ALIASES[c.toLowerCase()] || (UNIT_NAME[c] ? c : null);
        if (u) unit = u;
      }
      out.push({ name, unit, price });
    }
    return out;
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  // ---------------------------------------------------------------------
  // Тариф
  // ---------------------------------------------------------------------

  async function viewPlan(root) {
    const [sub, pays] = await Promise.all([api('GET', '/subscription'), api('GET', '/subscription/payments')]);
    if (current !== 'plan') return;
    const plan = sub.plan;
    const offer = sub.offer;
    const [tierLabel, tierTone] = TIER[plan.tier] || [plan.tier, 'muted'];

    let status;
    if (plan.tier === 'pro') status = `Pro оплачен до ${showDate(plan.paid_until)}. Прайс до ${offer.pro_items} позиций, объявления выше в поиске.`;
    else if (plan.tier === 'trial') status = `Пробный период до ${showDate(plan.trial_ends_at)}: всё как в Pro, бесплатно. Оплатите заранее — дни сложатся.`;
    else if (plan.tier === 'free') status = `Пробный период закончился. В поиске видны первые ${offer.free_items} позиций прайса, объявления не продвигаются.`;
    else status = `Пробный период на ${offer.trial_days} дней начнётся с первого объявления.`;

    const base = offer.periods.find((p) => p.months === 1);
    const plans = h('div', { class: 'plans' }, offer.periods.map((p) => {
      const perMonth = Math.round(p.amount / p.months);
      const saving = base && p.months > 1 ? base.amount * p.months - p.amount : 0;
      const btn = h('button', { class: 'btn wide' + (p.months === 1 ? ' outline' : ''), type: 'button', disabled: !offer.can_pay }, 'Оплатить картой');
      btn.addEventListener('click', () => busy(btn, async () => {
        try {
          const r = await api('POST', '/subscription/checkout', { months: p.months, back: 'cabinet' });
          location.href = r.url;
        } catch (err) { toast(err.message, true); }
      }));
      return h('div', { class: 'plan' + (p.months === 12 ? ' best' : '') },
        h('b', {}, p.months === 1 ? '1 месяц' : `${p.months} ${plural(p.months, 'месяц', 'месяца', 'месяцев')}`),
        h('div', { class: 'sum' }, money(p.amount)),
        h('div', { class: 'meta' }, p.months > 1 ? `${money(perMonth)} в месяц · выгода ${money(saving)}` : 'Без обязательств'),
        btn);
    }));

    const payRows = pays.items.length
      ? h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Дата'), h('th', {}, 'Срок'), h('th', {}, 'Сумма'), h('th', {}, 'Статус'))),
          h('tbody', {}, pays.items.map((p) => h('tr', {},
            h('td', {}, showStamp(p.paid_at || p.created_at)),
            h('td', {}, `${p.months} мес.`),
            h('td', { class: 'nowrap' }, money(p.amount)),
            h('td', {}, p.status === 'paid' ? (p.gateway === 'admin' ? 'Подарок от StroyApp' : 'Оплачено') : 'Не прошла')))))
      : h('p', { class: 'meta' }, 'Оплат пока не было.');

    root.replaceChildren(
      h('div', { class: 'head' }, h('h2', {}, 'Тариф')),
      h('div', { class: 'panel' },
        h('div', {}, h('span', { class: 'badge ' + tierTone }, tierLabel)),
        h('p', {}, status),
        h('p', { class: 'meta' }, 'Комиссии с продаж нет: клиенты платят вам напрямую. Подписка — только за размещение.')),
      h('div', { class: 'panel' },
        h('h3', {}, 'Продлить Pro'),
        offer.can_pay ? null : h('div', { class: 'note warn' }, 'Оплата картой временно недоступна. Напишите в поддержку — подключим вручную.'),
        plans,
        h('p', { class: 'meta small' }, 'Оплата через Freedom Pay. Данные карты вводятся на странице банка, к нам они не попадают. Подписка не продлевается сама.')),
      h('div', { class: 'panel' }, h('h3', {}, 'Оплаты'), payRows));
  }

  // ---------------------------------------------------------------------
  // Счётчики в разделах
  // ---------------------------------------------------------------------

  let pollTimer = 0;
  function startPolling() {
    stopPolling();
    refreshCounts();
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      refreshCounts();
    }, POLL_MS);
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = 0; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && me) refreshCounts(); });

  let knownPending = null;
  async function refreshCounts() {
    if (!me) return;
    try {
      const [pending, chats] = await Promise.all([
        api('GET', '/bookings/incoming?status=pending'),
        api('GET', '/chats'),
      ]);
      const n = pending.items.length;
      const unread = chats.items.filter((c) => c.is_owner).reduce((s, c) => s + (c.unread_count || 0), 0);
      setBadge('badge-bookings', n);
      setBadge('badge-chats', unread);
      document.title = (n + unread ? `(${n + unread}) ` : '') + 'Кабинет продавца — StroyApp';
      // Пришла новая заявка, пока открыт список новых, — перерисуем его, если
      // человек ничего в нём не набирает.
      if (knownPending !== null && n > knownPending && current === 'bookings' && bookingFilter === 'pending'
          && !document.querySelector('#view textarea')) {
        route();
        toast('Новая заявка');
      }
      knownPending = n;
    } catch (e) { /* следующий раз */ }
  }
  function setBadge(id, n) {
    const el = $(id);
    el.textContent = n > 99 ? '99+' : String(n);
    el.hidden = !n;
  }

  boot();
})();
