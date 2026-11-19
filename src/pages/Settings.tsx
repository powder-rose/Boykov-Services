import {
  FileText,
  Search,
  ShieldCheck,
  RotateCw,
  Check,
  CircleDashed,
} from "lucide-react";
import { Notice, PageHead } from "../components/Common";
import type { System } from "../types";
export default function Settings({
  system,
  refresh,
}: {
  system: System | null;
  refresh: () => void;
}) {
  return (
    <>
      <PageHead
        eyebrow="НАСТРОЙКИ ПРОСТРАНСТВА"
        title="Подключения и доступ"
        description="Состояние сервисов и всё, что нужно для начала работы."
      >
        <button className="button secondary" onClick={refresh}>
          <RotateCw size={16} />
          Обновить
        </button>
      </PageHead>
      <div className="settings-grid">
        <section className="panel settings-card">
          <span className="square-icon pink">
            <FileText size={23} />
          </span>
          <h2>Документы и Yandex AI</h2>
          <div className="connection-line">
            {system?.documents.available ? (
              <Check size={17} />
            ) : (
              <CircleDashed size={17} />
            )}
            Ядро документов
            <span>
              {system?.documents.available ? "Подключено" : "Недоступно"}
            </span>
          </div>
          <div className="connection-line">
            {system?.documents.aiConfigured ? (
              <Check size={17} />
            ) : (
              <CircleDashed size={17} />
            )}
            Распознавание с ИИ
            <span>
              {system?.documents.aiConfigured ? "Ключи заданы" : "Нужны ключи"}
            </span>
          </div>
          <p>
            Скопируйте env-файл бота в корень проекта под именем{" "}
            <code>.env.contracts</code>. Используются{" "}
            <code>YANDEX_FOLDER_ID</code>, <code>YANDEX_API_KEY</code> и при
            наличии <code>YANDEXGPT_API_KEY</code>.
          </p>
          <p className="muted small">
            Telegram и MAX для работы этого сервиса не требуются.
          </p>
        </section>
        <section className="panel settings-card">
          <span className="square-icon lime">
            <Search size={23} />
          </span>
          <h2>Wordstat API</h2>
          <div className="connection-line">
            {system?.wordstat.configured ? (
              <Check size={17} />
            ) : (
              <CircleDashed size={17} />
            )}
            Доступ к API
            <span>
              {system?.wordstat.configured ? "Ключи заданы" : "Нужны ключи"}
            </span>
          </div>
          <p>
            Скопируйте env-файл Wordstat в корень проекта под именем{" "}
            <code>.env.wordstat</code>. Используются <code>YANDEX_API_KEY</code>{" "}
            и <code>YANDEX_FOLDER_ID</code>.
          </p>
          <p className="muted small">
            У каждого сервиса могут быть собственные ключи Yandex Cloud. Наличие
            ключей не подтверждает их права и квоту.
          </p>
        </section>
      </div>
      <Notice tone="info">
        После изменения env-файлов перезапустите приложение. Секретные ключи не
        передаются в браузер.
      </Notice>
      <section className="panel security-card">
        <span className="square-icon neutral">
          <ShieldCheck size={24} />
        </span>
        <div>
          <h2>Персональные аккаунты и общий вход</h2>
          <p>
            В личном аккаунте действия в заявках подписываются именем
            сотрудника. Администратор управляет аккаунтами в разделе «Аккаунты».
            Общий вход остаётся доступен. Сессия действует 12 часов. Для смены
            общего пароля выполните <code>npm run setup</code> и перезапустите
            приложение.
          </p>
        </div>
        <span className="card-tag">ДОСТУП КОМАНДЫ</span>
      </section>
      {system?.documents.usage && (
        <p className="usage-note">
          Вызовы ИИ: {system.documents.usage.all_count}. Оценка расходов за
          месяц: {system.documents.usage.month_total.toFixed(2)} ₽. Расчёт по
          тарифам, заложенным в исходном ядре; это не счёт Yandex Cloud.
        </p>
      )}
    </>
  );
}
