# Переезд бэкенда на новый сервер (ноябрь 2026)

Переносим всё как есть: тот же домен `api.toiapp.kz`, та же база, те же фото
и тот же `.env`. Приложение ходит на домен, а не на IP, поэтому новая сборка
приложения не нужна — в конце меняется только A-запись в DNS. Пользователи
останутся залогиненными: `JWT_SECRET` тот же.

## Как устроен старый сервер (109.235.117.132)

- Сервер общий с проектом iduken. HTTPS для `api.toiapp.kz` держит nginx
  iduken (контейнер `iduken_edge`), его настройка —
  `/home/donik/actions-runner/runner_work/iduken/iduken/nginx/conf.d/toiapp.conf`,
  сертификат — `/opt/iduken-secrets/certbot/conf/live/api.toiapp.kz`.
- ToiApp запущен из `/opt/toyhana` своим `docker-compose.yml`, переделанным
  девопсом под общий сервер (контейнеры `toiapp-backend`, `toiapp-pgsql`, без
  своего nginx, сеть `iduken_internal`). Эти правки и `.env` закоммичены
  прямо на сервере (коммит `36beb0a`), в GitHub их нет.
- Живые данные: том `toyhana_pgdata` (база) и том `toyhana_uploads` (фото).
- Бэкапы базы складываются в `/opt/toiapp-backups`.

## Как устроен новый сервер

Один проект, всё из репозитория как есть: `docker-compose.yml` (postgres,
backend, nginx, certbot) и `nginx/nginx.conf` с HTTPS. Сертификат — в
`/opt/toyhana/certbot/conf`. Тома называются так же, как на старом
(`toyhana_pgdata`, `toyhana_uploads`), потому что каталог тот же —
`/opt/toyhana`.

## Шаги

1. **Новый сервер**: Ubuntu 24.04, Docker, файрвол (22, 80, 443).
2. **Код и `.env`**: скопировать `/opt/toyhana` со старого сервера, затем
   поставить код из GitHub (`main`) вместо серверного, сохранив `.env`.
   Для `git pull` на новом сервере — ключ развёртывания (Deploy key) только
   на чтение в репозитории `DamirKZ82/toiapp`.
3. **Сертификат**: скопировать `live/`, `archive/` и `renewal/` для
   `api.toiapp.kz` и `accounts/` из `/opt/iduken-secrets/certbot/conf`
   в `/opt/toyhana/certbot/conf`. Действует до продления; после переезда
   продлевается уже на новом сервере.
4. **Пробный перенос** базы (`pg_dump -Fc` → `pg_restore`) и фото (`tar`
   тома), запуск, проверка через `curl --resolve api.toiapp.kz:443:НОВЫЙ_IP`.
5. **Переезд**: на старом остановить `toiapp-backend`, снять дамп и фото
   заново, залить на новый, сверить число строк, переключить A-запись
   `api.toiapp.kz` на новый IP. За сутки до этого снизить TTL до 300.
6. **После**: cron на продление сертификата и бэкап, проверка входа по SMS
   (если в Mobizon ограничение по IP — добавить новый), админки и Telegram.
   На старом сервере ToiApp больше не запускать; через неделю удалить его
   контейнеры, тома и дампы, а из nginx iduken — `toiapp.conf`.

## Откат

Вернуть A-запись на старый IP и на старом сервере
`cd /opt/toyhana && docker compose start backend`. Всё, что успели
записать на новом сервере, останется только там.
