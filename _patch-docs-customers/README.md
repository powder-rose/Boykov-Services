# Клиенты BoykovDocs — патч Boykov Services

Основа: main, 8e6ec5f (нативная статистика). 14 файлов, без зависимостей, ключей и клиентских данных.

Добавлено: отдельная вкладка, контакты, данные компании с привязкой к ID пользователя, поиск и фильтры, история звонков с автором, очередь доставки с повторами. Данные загружаются с 19.11.2026 00:00 по Москве; прошлые регистрации и старые компании не импортируются. Новое сохранение компании старым пользователем создаёт связанную с ним карточку.

## Установка в PowerShell

Сохраните ZIP в «Загрузки». В корне локального boykov-services выполните:

```powershell
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\Boykov-services_Docs_Customers_Patch.zip" -DestinationPath .\_patch-docs-customers -Force
powershell -NoProfile -ExecutionPolicy Bypass -File .\_patch-docs-customers\Install-Patch.ps1
```

Установщик проверяет совместимость до изменений, сохраняет копии изменяемых файлов в каталоге резервных копий Git и запускает npm run check. Повторная установка также запускает проверки. Нужен Node.js 24. Скрипт не делает коммит и push. Папку _patch-docs-customers не добавляйте в коммит.

После PATCH_CHECK=OK сделайте обычный коммит от своего имени и push. Можно добавить ровно файлы из FILES.txt:

```powershell
$patchFiles = Get-Content .\_patch-docs-customers\FILES.txt
git add -- $patchFiles
git commit -m "feat: add BoykovDocs customers and call history"
git push
```

## Серверы

На VPS Boykov Services:

```bash
cd /opt/boykov-services
git pull --ff-only
bash scripts/deploy-docs-customers.sh
```

Затем войдите администратором → «Клиенты BoykovDocs» → «Подключение», создайте ключ и подключите сервер BoykovDocs по CONNECT-BOYKOVDOCS.md. Установка патча сама не подключает производственный источник. Запускается отдельный контейнер доставки; API BoykovDocs не меняется и не перезапускается. Cron не требуется.

## Проверено

Сборка TypeScript/Vite, полный набор из 146 тестов без пропусков (включая PHP/MySQL проверки существующих модулей), отдельные проверки очереди, авторов звонков, прав доступа, повторов доставки, ID компаний и даты начала. Браузер: список, поиск, фильтр, связь пользователя и компании, сохранение звонка, автор и отмена с сохранением истории. Файлы установщиков проверены синтаксически; фактическое подключение VPS выполняется после push.
