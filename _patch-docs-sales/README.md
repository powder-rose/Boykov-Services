# Boykov Services — продажи инструкций

Патч для main 93fbf73 или совместимой версии. Добавляет подраздел «Клиенты BoykovDocs → Продажи инструкций» в стиле сервиса.

Возможности: статистика количества и суммы, периоды сегодня/7/30/90 дней/всё время, график, популярные инструкции, поиск и сортировка покупателей, отдельная история покупок каждого ID пользователя. PDF и Word — отдельные покупки, повторное скачивание не считается продажей. Источник — те же wallet purchases, что в существующей админке BoykovDocs. Пополнения и чеки исключены.

## Локальная установка PowerShell

Скачайте ZIP в Downloads, откройте PowerShell в корне локального проекта:

```powershell
$zip = Join-Path $env:USERPROFILE 'Downloads\Boykov-services_Docs_Sales_Patch.zip'
Expand-Archive -LiteralPath $zip -DestinationPath .\_patch-docs-sales -Force
powershell -ExecutionPolicy Bypass -File .\_patch-docs-sales\Install-Patch.ps1
```

Установщик сохраняет резервную копию затронутых существующих файлов в .git/boykov-patch-backups, проверяет применимость и запускает npm run check. Требуется Node.js 24. При повторном запуске патч повторно не накладывается, проверки повторяются. Существующие .env, данные и зависимости в архив не входят.

После PATCH_CHECK=OK закоммитьте файлы из FILES.txt и выполните push обычным способом. Сам каталог _patch-docs-sales и архив в Git добавлять не нужно.

## VPS Boykov Services — первым

```bash
cd /opt/boykov-services
git pull --ff-only
bash scripts/deploy-docs-customers.sh
```

Скрипт делает резервную копию SQLite и сохраняет предыдущий образ, обновляет только app и проверяет миграции и авторизацию. Ожидается DOCS_SALES_MODULE=OK, DOCS_SALES_AUTH=OK, DOCS_CUSTOMERS_DEPLOY=OK.

## VPS BoykovDocs (cv8367491) — вторым

```bash
cd /opt/boykov-services-connector
git pull --ff-only
bash scripts/install-docs-sales.sh
```

Ключ берётся из действующего коннектора клиентов автоматически: повторный ввод не требуется. Отдельный процесс только читает данные сайта и доставляет историю продаж через защищённый вебхук с собственной очередью повторных попыток. Сайт и коннектор клиентов не перезапускаются. Ожидается DOCS_SALES_CONNECTION=OK. Нового cron не нужно. Первичная история поступает порциями по 50; временно появится «Загружаем историю продаж».

Все имеющиеся покупки загружаются отдельно от CRM-клиентов, старые регистрации/компании в список клиентов не добавляются. Связь по ID, одинаковая почта не объединяет людей.

Диагностика:

```bash
docker compose -f /opt/boykovdocs-sales-delivery/compose.json ps
docker compose -f /opt/boykovdocs-sales-delivery/compose.json logs --tail 20 delivery
```

Полная документация, правила подсчёта и отката после применения: docs/BOYKOVDOCS-SALES.md.

Проверено: TypeScript/Vite, Node-тесты (165 успешны, 4 существующих PHP/MySQL-теста пропущены в среде без PHP), авторизация/ID/суммы/периоды/пагинация/повторная доставка/устойчивость очереди, интерфейс на искусственных данных, синтаксис shell. Docker-подключение к настоящему источнику проверяется установкой на VPS; прямого SSH-доступа здесь нет.
