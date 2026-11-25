import {
  ArrowRight,
  ArrowUpRight,
  FileText,
  ClipboardList,
  Search,
  Sparkles,
  MoveUpRight,
  Inbox,
  MessageCircle,
} from "lucide-react";
import { Empty, EventList, PageHead } from "../components/Common";
import { number } from "../api";
import type { Dashboard, System, Page, Job } from "../types";
import templates from "../../shared/templates.json";
export default function Overview({
  dashboard,
  system,
  navigate,
  onOpen,
}: {
  dashboard: Dashboard;
  system: System | null;
  navigate: (page: Page) => void;
  onOpen: (job: Job) => void;
}) {
  return (
    <>
      <PageHead
        eyebrow="ВАШ РАБОЧИЙ СТОЛ"
        title="Всё для работы. В одном месте."
        description="Инструменты Бойков Групп, которые берут рутину на себя."
      />
      <button className="leads-overview-cta" onClick={() => navigate("leads")}>
        <Inbox size={21} />
        <span>
          <b>Заявки со всех сайтов</b>
          <small>
            {dashboard.stats.newLeads || 0} новых · перейти к обращениям
            клиентов
          </small>
        </span>
        <ArrowRight size={20} />
      </button>
      <section className="intro-banner">
        <div>
          <span className="banner-label">
            <span className="tiny-dot" /> ПРОСТРАНСТВО КОМАНДЫ
          </span>
          <h2>
            Освободите время
            <br />
            для главного<span>.</span>
          </h2>
          <p>Выберите сервис и переходите к делу.</p>
        </div>
        <div className="banner-art" aria-hidden="true">
          <div />
          <div />
          <MoveUpRight size={46} strokeWidth={1.3} />
          <span>МЕНЬШЕ ШАГОВ → БОЛЬШЕ РЕЗУЛЬТАТА</span>
        </div>
      </section>
      <div className="section-heading">
        <h2>
          Сервисы компании <span>04</span>
        </h2>
        <span className="muted small">Одно пространство. Разные задачи.</span>
      </div>
      <section className="service-grid">
        <button
          className="service-card service-pink"
          onClick={() => navigate("contracts")}
        >
          <div className="service-top">
            <span className="service-icon">
              <FileText size={25} strokeWidth={1.6} />
            </span>
            <span className="card-tag">ДОКУМЕНТЫ</span>
            <ArrowUpRight className="service-arrow" size={24} />
          </div>
          <h3>Договоры без рутины</h3>
          <p>
            Загрузите реквизиты — ИИ разберёт данные,
            <br className="desktop-break" /> а сервис подготовит документ по
            шаблону.
          </p>
          <div className="service-bottom">
            <span className="availability">
              <i className={system?.documents.available ? "good" : ""} />
              {system?.documents.available
                ? system.documents.aiConfigured
                  ? `${system.documents.templates ?? templates.length} шаблонов · ИИ подключён`
                  : `${system.documents.templates ?? templates.length} шаблонов · ИИ не подключён`
                : "Сервис недоступен"}
            </span>
            <ArrowRight size={20} />
          </div>
        </button>
        <button
          className="service-card service-lime"
          onClick={() => navigate("wordstat")}
        >
          <div className="service-top">
            <span className="service-icon">
              <Search size={25} strokeWidth={1.6} />
            </span>
            <span className="card-tag">МАРКЕТИНГ</span>
            <ArrowUpRight className="service-arrow" size={24} />
          </div>
          <h3>Семантика из Wordstat</h3>
          <p>
            Собирайте поисковые запросы и частотность.
            <br className="desktop-break" /> Результат — в удобной
            Excel-таблице.
          </p>
          <div className="service-bottom">
            <span className="availability">
              <i className={system?.wordstat.configured ? "good" : ""} />
              {system?.wordstat.configured
                ? "API подключён"
                : "Ожидает подключения API"}
            </span>
            <ArrowRight size={20} />
          </div>
        </button>
        <button
          className="service-card service-pink"
          onClick={() => navigate("technical")}
        >
          <div className="service-top">
            <span className="service-icon">
              <ClipboardList size={25} strokeWidth={1.6} />
            </span>
            <span className="card-tag">ТЕХОТДЕЛ</span>
            <ArrowUpRight className="service-arrow" size={24} />
          </div>
          <h3>Объекты и допработы</h3>
          <p>
            Семь рабочих разделов, сверка с бухгалтерией, заметки и история
            команды.
          </p>
          <div className="service-bottom">
            <span className="availability">
              Данные из Google · правки внутри сервиса
            </span>
            <ArrowRight size={20} />
          </div>
        </button>
        <button
          className="service-card service-lime"
          onClick={() => navigate("dzen")}
        >
          <div className="service-top">
            <span className="service-icon">
              <MessageCircle size={25} strokeWidth={1.6} />
            </span>
            <span className="card-tag">МАРКЕТИНГ / ZENBOT</span>
            <ArrowUpRight className="service-arrow" size={24} />
          </div>
          <h3>Диалог с читателями Дзена</h3>
          <p>
            Комментарии, ответы ИИ, настройка промпта и контроль публикаций.
          </p>
          <div className="service-bottom">
            <span className="availability">Очередь · промпт · история</span>
            <ArrowRight size={20} />
          </div>
        </button>
      </section>
      <div className="metrics">
        <div>
          <span>Документов готово</span>
          <strong>{number(dashboard.stats.documents)}</strong>
          <FileText size={18} />
        </div>
        <div>
          <span>Сборов завершено</span>
          <strong>{number(dashboard.stats.batches)}</strong>
          <Search size={18} />
        </div>
        <div>
          <span>Сейчас в работе</span>
          <strong>{number(dashboard.stats.active)}</strong>
          <Sparkles size={18} />
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Последние задачи</h2>
            <p>Результаты работы всегда под рукой</p>
          </div>
          <button className="text-button" onClick={() => navigate("history")}>
            Вся история <ArrowRight size={16} />
          </button>
        </div>
        {dashboard.events.length ? (
          <EventList events={dashboard.events} limit={5} onOpen={onOpen} />
        ) : (
          <Empty
            title="Начнём с первой задачи"
            text="Готовые документы и сборы будут сохраняться здесь."
          />
        )}
      </section>
      <div className="workspace-note">
        <span className="note-cross">+</span>
        <p>
          Пространство будет расти вместе с командой.
          <span> Новые сервисы появятся здесь.</span>
        </p>
        <span className="note-number">BG / 001</span>
      </div>
    </>
  );
}
