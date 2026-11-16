import { useState } from "react";
import { Search } from "lucide-react";
import { EventList, PageHead, Empty, Notice } from "../components/Common";
import type { Dashboard, Job } from "../types";
export default function History({
  dashboard,
  onOpen,
}: {
  dashboard: Dashboard;
  onOpen: (job: Job) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const events = dashboard.events.filter(
    (job) =>
      (filter === "all" || job.service === filter) &&
      job.title.toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru")),
  );
  return (
    <>
      <PageHead
        eyebrow="ОБЩАЯ ИСТОРИЯ"
        title="Результаты под рукой"
        description="Документы и сборы команды сохраняются в одном месте."
      />
      {!dashboard.documentsAvailable && (
        <Notice>
          История документов временно недоступна. Показываем доступные сборы
          Wordstat.
        </Notice>
      )}
      <section className="panel">
        <div className="history-tools">
          <div className="segmented">
            {[
              ["all", "Все задачи"],
              ["contracts", "Договоры"],
              ["wordstat", "Wordstat"],
            ].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setFilter(id)}
                className={filter === id ? "active" : ""}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="search-field">
            <Search size={16} />
            <input
              id="history-search"
              placeholder="Найти задачу…"
              aria-label="Поиск по истории"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        {events.length ? (
          <EventList events={events} onOpen={onOpen} />
        ) : (
          <Empty
            title={query ? "Ничего не найдено" : "Задач пока нет"}
            text={
              query
                ? "Измените поисковую фразу или выбранный сервис."
                : "Подготовьте документ или запустите сбор Wordstat."
            }
          />
        )}
      </section>
      <p className="history-caption">
        Отображаются все документы и последние 30 завершённых сборов Wordstat, а
        также все незавершённые сборы. Более ранние выгрузки остаются в папке
        данных.
      </p>
    </>
  );
}
