Boykov Services — подключение boykovgroup.ru на Tilda

База: main 97e49cb35b420e2219c4e1ef95e3f13c10d925f2.

1. Скачайте ZIP в Downloads. В PowerShell в корне локального Boykov Services:

$zip = Join-Path $HOME 'Downloads\Boykov-services_Tilda_Patch.zip'
Expand-Archive -LiteralPath $zip -DestinationPath '.\_patch-tilda' -Force
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\_patch-tilda\Install-Patch.ps1'

Ожидается PATCH_CHECK=OK. Скрипт проверяет применимость, делает копию изменяемых
файлов в служебном каталоге Git, устанавливает патч и запускает npm run check.
Если повторно запущенный установщик показывает PATCH_ALREADY_INSTALLED,
проверку можно выполнить командой npm run check. При конфликте ничего не меняет.

2. После успешной проверки:

git add -- docs/LEADS.md docs/TILDA.md scripts/deploy-tilda.sh server/app.js server/modules/leads/index.js server/modules/leads/tilda.js src/pages/Leads.tsx src/pages/Leads.css tests/leads-tilda.test.js
git diff --cached --stat
git commit -m "feat: connect Boykov Group Tilda leads"
git push

Перед commit проверьте список подготовленных файлов. Используется ваше текущее
имя и email Git. Установщик их не меняет.

3. На VPS Boykov Services (root@cv8356425, /opt/boykov-services):

umask 022
cd /opt/boykov-services
git pull --ff-only
bash scripts/deploy-tilda.sh

При ошибке git pull не запускайте деплой, пришлите вывод. Скрипт перед сборкой
проверяет отсутствие локальных изменений в отслеживаемых файлах, сохраняет
онлайн-копию БД и старый Docker-образ. Обновляется только app. Ожидается
TILDA_MODULE=OK, TILDA_AUTH=OK, TILDA_DEPLOY=OK. Путь BACKUP нужен для отката.

4. Откройте в боевом Boykov Services: Заявки → Бойков Групп → Создать ключ.
В Tilda: boykovgroup.ru → Настройки сайта → Формы → Webhook.
Webhook URL — из карточки Boykov Services.
API Method — HEADER (передача в заголовках).
API Name — Authorization.
API Key — из карточки целиком, включая Bearer и пробел перед ключом.
Cookie и «Отправлять только после оплаты» — выключены. Сохраните. Назначьте приёмщик всем нужным формам
и опубликуйте страницы. Отправьте пробную заявку из каждой формы.
Подробности — в docs/TILDA.md, также скопированной рядом с установщиком.
Ключ и пароль Tilda не присылайте в чат.

Готовность кода подтверждена сборкой и 97 тестами, включая 9 новых Tilda.
Три старых PHP-проверки пропущены из-за отсутствия PHP в среде подготовки.
Продакшн и отправка из Tilda проверяются после выполнения шагов 3–4.

Текущую почту/CRM оставьте резервом: Tilda делает только 3 попытки доставки.
Если VPS недоступен дольше, сверяйте раздел «Заявки» и журнал ошибок в Tilda.
Старые заявки Tilda не импортируются. Время заявки — первый приём в центре.
Официальная инструкция: https://help-ru.tilda.cc/forms/webhook
