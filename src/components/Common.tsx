import {
  ArrowDownToLine,
  ArrowUpRight,
  CircleAlert,
  LoaderCircle,
  Inbox,
} from "lucide-react";
import { dateTime } from "../api";
import type { Job } from "../types";
const statuses: Record<string, string> = {
  queued: "В очереди",
  running: "В работе",
  waiting: "Ожидание квоты",
  exporting: "Сохраняем Excel",
  completed: "Готово",
  failed: "Ошибка",
  paused: "Приостановлен",
};
export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      <i />
      {statuses[value] || value}
    </span>
  );
}
export function Notice({
  children,
  tone = "warning",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className={`notice ${tone}`} role="status">
      <CircleAlert size={17} />
      <div>{children}</div>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={22} /> Загружаем пространство…
    </div>
  );
}
export function Empty({
  title = "Здесь появятся результаты",
  text = "Создайте первый документ или запустите сбор Wordstat.",
}: {
  title?: string;
  text?: string;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Inbox size={24} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
export function PageHead({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </header>
  );
}
export function EventList({
  events,
  onOpen,
  limit,
}: {
  events: Job[];
  onOpen: (job: Job) => void;
  limit?: number;
}) {
  if (!events.length) return <Empty />;
  return (
    <div className="table-scroll">
      <table className="events">
        <thead>
          <tr>
            <th>Задача</th>
            <th>Сервис</th>
            <th>Создано · МСК</th>
            <th>Статус</th>
            <th>
              <span className="sr-only">Действия</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {events.slice(0, limit).map((job) => (
            <tr key={`${job.service}-${job.id}`}>
              <td>
                <button className="task-title" onClick={() => onOpen(job)}>
                  {job.title}
                </button>
                {job.error && <span className="table-error">{job.error}</span>}
              </td>
              <td>
                <span className="muted">
                  {job.service === "wordstat" ? "Wordstat" : "Договоры"}
                </span>
              </td>
              <td className="nowrap muted">{dateTime(job.createdAt)}</td>
              <td>
                <Status value={job.status} />
              </td>
              <td>
                {job.downloadUrl ? (
                  <a
                    className="icon-button"
                    href={job.downloadUrl}
                    aria-label="Скачать результат"
                  >
                    <ArrowDownToLine size={17} />
                  </a>
                ) : (
                  <button
                    className="icon-button"
                    onClick={() => onOpen(job)}
                    aria-label="Открыть задачу"
                  >
                    <ArrowUpRight size={17} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
