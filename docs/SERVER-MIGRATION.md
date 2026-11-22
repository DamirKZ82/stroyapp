# Переезд бэкенда на новый сервер (ноябрь 2026)

Переносим всё как есть: тот же домен `api.stroyapp.kz`, та же база, те же фото
и тот же `.env`. Приложение ходит на домен, а не на IP, поэтому новая сборка
приложения не нужна — в конце меняется только A-запись в DNS. Пользователи
останутся залогиненными: `JWT_SECRET` тот же.

## Как устроен старый сервер (109.235.117.132)

- Сервер общий с проектом iduken. HTTPS для `api.stroyapp.kz` держит nginx
  iduken (контейнер `iduken_edge`), его настройка —
  `/home/donik/actions-runner/runner_work/iduken/iduken/nginx/conf.d/stroyapp.conf`,
  сертификат — `/opt/iduken-secrets/certbot/conf/live/api.stroyapp.kz`.
- StroyApp запущен из `/opt/stroyapp` своим `docker-compose.yml`, переделанным
  девопсом под общий сервер (контейнеры `stroyapp-backend`, `stroyapp-pgsql`, без
  своего nginx, сеть `iduken_internal`). Эти правки и `.env` закоммичены
  прямо на сервере (коммит `36beb0a`), в GitHub их нет.
- Живые данные: том `stroyapp_pgdata` (база) и том `stroyapp_uploads` (фото).
- Бэкапы базы складываются в `/opt/stroyapp-backups`.

## Как устроен новый сервер

Один проект, всё из репозитория как есть: `docker-compose.yml` (postgres,
backend, nginx, certbot) и `nginx/nginx.conf` с HTTPS. Сертификат — в
`/opt/stroyapp/certbot/conf`. Тома называются так же, как на старом
(`stroyapp_pgdata`, `stroyapp_uploads`), потому что каталог тот же —
`/opt/stroyapp`.

## Шаги

1. **Новый сервер**: Ubuntu 24.04, Docker, файрвол (22, 80, 443).
2. **Код и `.env`**: скопировать `/opt/stroyapp` со старого сервера, затем
   поставить код из GitHub (`main`) вместо серверного, сохранив `.env`.
   Для `git pull` на новом сервере — ключ развёртывания (Deploy key) только
   на чтение в репозитории `DamirKZ82/stroyapp`.
3. **Сертификат**: скопировать `live/`, `archive/` и `renewal/` для
   `api.stroyapp.kz` и `accounts/` из `/opt/iduken-secrets/certbot/conf`
   в `/opt/stroyapp/certbot/conf`. Действует до продления; после переезда
   продлевается уже на новом сервере.
4. **Пробный перенос** базы (`pg_dump -Fc` → `pg_restore`) и фото (`tar`
   тома), запуск, проверка через `curl --resolve api.stroyapp.kz:443:НОВЫЙ_IP`.
5. **Переезд**: на старом остановить `stroyapp-backend`, снять дамп и фото
   заново, залить на новый, сверить число строк, переключить A-запись
   `api.stroyapp.kz` на новый IP. За сутки до этого снизить TTL до 300.
6. **После**: cron на продление сертификата и бэкап, проверка входа по SMS
   (если в Mobizon ограничение по IP — добавить новый), админки и Telegram.
   На старом сервере StroyApp больше не запускать; через неделю удалить его
   контейнеры, тома и дампы, а из nginx iduken — `stroyapp.conf`.

## Откат

Вернуть A-запись на старый IP и на старом сервере
`cd /opt/stroyapp && docker compose start backend`. Всё, что успели
записать на новом сервере, останется только там.
