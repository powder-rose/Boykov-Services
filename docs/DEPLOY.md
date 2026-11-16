# Развёртывание на VPS

## Подготовка

Нужны Docker Engine + Compose, Nginx и действующий HTTPS-сертификат для вашего домена. Проект публикует порт только на loopback; замените `services.example.ru` своим доменом.

```bash
git clone https://github.com/powder-rose/boykov-services.git
cd boykov-services
npm ci
npm run setup
```

Для `setup` нужен Node.js 24. Его можно выполнить локально и безопасно перенести `.env` на сервер. Перенесите `.env.contracts` и `.env.wordstat` отдельно от Git.

В `.env` задайте `NODE_ENV='production'`, `APP_ORIGINS='https://services.example.ru'`, `COOKIE_SECURE='true'`. Значения, записанные `setup`, заключены в одинарные кавычки: это сохраняет символы `$` в scrypt-хеше при чтении Compose. Не снимайте кавычки с хеша и не заменяйте его открытым паролем.

Убедитесь, что файлы ключей доступны пользователю контейнера с UID 1000:

```bash
sudo chown 1000:1000 .env.contracts .env.wordstat
sudo chmod 600 .env .env.contracts .env.wordstat
docker compose up -d --build
docker compose ps
curl -f http://127.0.0.1:8089/healthz
```

Ожидаются два healthy-контейнера: `app` и `documents`. При отличающемся UID пользователя хоста не переносите ключи в общедоступные файлы; измените владельца либо используйте собственную конфигурацию Docker secrets.

## Nginx

Поместите блок в HTTPS server с уже настроенными `ssl_certificate` и `ssl_certificate_key`:

```nginx
server {
    listen 443 ssl;
    server_name services.example.ru;
    # ssl_certificate ...;
    # ssl_certificate_key ...;
    client_max_body_size 22m;

    location / {
        proxy_pass http://127.0.0.1:8089;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
server {
    listen 80;
    server_name services.example.ru;
    return 301 https://$host$request_uri;
}
```

С `trust proxy=false` лимит входа общий для запросов через прокси. Для небольшой команды с общим паролем это допустимо. Если нужен отдельный лимит на каждого клиента, настройте верифицированную цепочку доверенных прокси в `server/config.js`; не доверяйте любому X-Forwarded-For.

Проверьте `sudo nginx -t`, перезагрузите Nginx и откройте домен. Убедитесь, что вход, файл договора и Excel доступны после авторизации. Worker не открывайте наружу. Не используйте Vite dev server на production.

## Обновление

Перед обновлением сохраните резервную копию. Затем:

```bash
git pull --ff-only
docker compose up -d --build
docker compose ps
curl -f http://127.0.0.1:8089/healthz
```

Изменения env перечитываются при пересоздании контейнеров: `docker compose up -d --force-recreate`. Простого перезапуска Node при изменении Python-ключей недостаточно.

## Резервное копирование

Пока команда не запускает новые задачи, остановите оба сервиса для согласованной копии SQLite, счётчиков и файлов. Пример сохраняет архив в текущую папку:

```bash
docker compose stop
docker run --rm -v boykov-services_platform-data:/data:ro -v "$PWD:/backup" alpine:3.22 tar -czf /backup/boykov-data-backup.tgz -C /data .
docker compose start
```

Храните архив и три env-файла в защищённом месте вне VPS. Проверяйте восстановление. Не запускайте `docker compose down -v`: эта команда удаляет рабочий том.

## Особенности миграции

Новая платформа начинает отдельную историю и отдельные счётчики номеров. Номера договоров состоят из первых двух букв фамилии в верхнем регистре, даты и порядкового номера без дополнительного префикса. Файловые счётчики бота автоматически не синхронизируются с сайтом. Перенос существующих номеров и истории — отдельная операция с предварительной проверкой данных.

Обработка ИИ и сетевые запросы проверяются с реальными ключами после подключения. Автоматические тесты проверяют интеграцию через подменённый ответ ИИ и синтетические данные.
