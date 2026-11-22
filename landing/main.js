// Ссылки на магазины приложений. Пока приложение не опубликовано, оставьте
// пустую строку: кнопка покажет «скоро» и не уведёт на пустую страницу.
const STORE_LINKS = {
  appstore: '',
  googleplay: '',
};

// Куда уходят заявки партнёров. Сервера для формы нет — открываем почту
// с готовым письмом, чтобы лендинг оставался статичным.
const PARTNER_EMAIL = 'supportstroyapp@gmail.com';

document.querySelectorAll('[data-store]').forEach((a) => {
  const url = STORE_LINKS[a.dataset.store];
  if (url) {
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
  } else {
    a.removeAttribute('href');
    a.setAttribute('aria-disabled', 'true');
    a.setAttribute('role', 'link');
    const soon = document.createElement('span');
    soon.className = 'store__soon';
    soon.textContent = 'скоро';
    a.appendChild(soon);
  }
});

const form = document.getElementById('joinForm');
form.addEventListener('submit', (e) => {
  e.preventDefault();
  let firstBad = null;
  form.querySelectorAll('[required]').forEach((el) => {
    const bad = !el.value.trim();
    el.setAttribute('aria-invalid', bad ? 'true' : 'false');
    if (bad && !firstBad) firstBad = el;
  });
  if (firstBad) {
    firstBad.focus();
    return;
  }
  const d = new FormData(form);
  const subject = `Заявка партнёра: ${d.get('name')} (${d.get('city')})`;
  const body = [
    `Кто: ${d.get('kind')}`,
    `Название / имя: ${d.get('name')}`,
    `Город: ${d.get('city')}`,
    `Телефон: ${d.get('phone')}`,
  ].join('\n');
  window.location.href =
    `mailto:${PARTNER_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});

document.getElementById('year').textContent = new Date().getFullYear();
