import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  FileText,
  Inbox,
  RefreshCw,
  UserCheck,
} from "lucide-react";
import { api, dateTime, errorText } from "../api";
import { Empty, Loading, Notice, PageHead, Status } from "../components/Common";
import type { AccountIdentity, Job } from "../types";
import "./Accounts.css";

type Lead = {
  id: string;
  name: string;
  phone: string;
  email: string;
  service: string;
  form: string;
  updatedAt: string;
  status: string;
  siteId: string;
};
type LeadList = {
  status: "working" | "processed";
  leads: Lead[];
  counts: { working: number; processed: number };
  total: number;
  page: number;
  pages: number;
};
type Documents = {
  available: boolean;
  documents: Job[];
  total: number | null;
  completed: number | null;
  page: number;
  pages: number;
  error?: string;
};
export default function Cabinet({
  active,
  account,
  onOpenDocument,
  onOpenLead,
}: {
  active: boolean;
  account?: AccountIdentity;
  onOpenDocument: (job: Job) => void;
  onOpenLead: (id: string) => void;
}) {
  const [tab, setTab] = useState<"documents" | "working" | "processed">(
      "documents",
    ),
    [page, setPage] = useState(1),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [documents, setDocuments] = useState<Documents | null>(null),
    [leads, setLeads] = useState<LeadList | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const id = ++sequence.current;
    setLoading(true);
    const results = await Promise.allSettled([
      api<Documents>(`/me/documents?page=${tab === "documents" ? page : 1}`),
      api<LeadList>(
        `/me/leads?status=${tab === "processed" ? "processed" : "working"}&page=${tab === "documents" ? 1 : page}`,
      ),
    ]);
    if (id !== sequence.current) return;
    const errors: string[] = [];
    if (results[0].status === "fulfilled") setDocuments(results[0].value);
    else errors.push(errorText(results[0].reason));
    if (results[1].status === "fulfilled") setLeads(results[1].value);
    else errors.push(errorText(results[1].reason));
    const current = tab === "documents" ? results[0] : results[1];
    if (current.status === "fulfilled" && page > current.value.pages)
      setPage(current.value.pages);
    setError(errors.join(" "));
    setLoading(false);
  }, [tab, page]);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    return () => {
      clearInterval(timer);
      sequence.current++;
    };
  }, [active, load]);
  const pages = tab === "documents" ? documents?.pages || 1 : leads?.pages || 1;
  const loaded =
    tab === "documents" ? documents !== null : leads?.status === tab;
  return (
    <>
      <PageHead
        eyebrow={
          account?.role === "shared" ? "ОБЩИЙ ДОСТУП" : "ЛИЧНОЕ ПРОСТРАНСТВО"
        }
        title="Мой кабинет"
        description={
          account?.role === "shared"
            ? "Документы и заявки, закреплённые за общим входом."
            : `${account?.name || "Сотрудник"} · документы и заявки в одном месте.`
        }
      >
        <button
          className="button secondary"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? "spin" : ""} />
          Обновить
        </button>
      </PageHead>
      {error && (
        <Notice tone="error">Не удалось обновить все данные. {error}</Notice>
      )}
      <section className="cabinet-stats" aria-label="Моя работа">
        {(
          [
            {
              id: "documents",
              label: "Мои документы",
              value: documents?.available ? documents.total : "—",
              icon: FileText,
            },
            {
              id: "working",
              label: "В работе у меня",
              value: leads?.counts.working ?? "—",
              icon: Inbox,
            },
            {
              id: "processed",
              label: "Обработанные мной",
              value: leads?.counts.processed ?? "—",
              icon: UserCheck,
            },
          ] as const
        ).map((item) => (
          <button
            className={`cabinet-stat ${item.id} ${tab === item.id ? "selected" : ""}`}
            aria-pressed={tab === item.id}
            key={item.id}
            onClick={() => {
              setTab(item.id);
              setPage(1);
            }}
          >
            <span>
              <item.icon size={18} />
              {item.label}
            </span>
            <strong>{item.value}</strong>
            <small>
              {item.id === "documents"
                ? "Созданы под этим аккаунтом"
                : item.id === "working"
                  ? "Закреплены за вами"
                  : "Завершены вами"}
            </small>
          </button>
        ))}
      </section>
      {documents && !documents.available && <Notice>{documents.error}</Notice>}
      <section className="panel table-scroll">
        <div className="cabinet-heading">
          <h2>
            {tab === "documents"
              ? "Мои документы"
              : tab === "working"
                ? "Заявки в работе"
                : "Обработанные заявки"}
          </h2>
          <span className="small muted">Только работа этого аккаунта</span>
        </div>
        {!loaded ? (
          <Loading />
        ) : tab === "documents" ? (
          documents?.documents.length ? (
            <table className="events">
              <thead>
                <tr>
                  <th>Документ</th>
                  <th>Создан · МСК</th>
                  <th>Состояние</th>
                  <th>
                    <span className="sr-only">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {documents.documents.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <button
                        className="task-title"
                        onClick={() => onOpenDocument(job)}
                      >
                        {job.title}
                      </button>
                    </td>
                    <td className="nowrap muted">
                      {dateTime(job.createdAt, true)}
                    </td>
                    <td>
                      <Status value={job.status} />
                    </td>
                    <td>
                      {job.downloadUrl ? (
                        <a className="button secondary" href={job.downloadUrl}>
                          <ArrowDownToLine size={16} />
                          Скачать
                        </a>
                      ) : (
                        <button
                          className="text-button"
                          onClick={() => onOpenDocument(job)}
                        >
                          Открыть
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty
              title={
                documents?.available
                  ? "Пока нет личных документов"
                  : "История документов недоступна"
              }
              text={
                documents?.available
                  ? "Новые договоры, созданные под этим аккаунтом, появятся здесь. Старые документы остаются в общей истории."
                  : "Повторите обновление позже. Заявки доступны в соседних разделах."
              }
            />
          )
        ) : leads?.leads.length ? (
          <table className="events">
            <thead>
              <tr>
                <th>Клиент</th>
                <th>Услуга</th>
                <th>Обновлено · МСК</th>
                <th>
                  <span className="sr-only">Открыть заявку</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {leads.leads.map((lead) => (
                <tr key={lead.id}>
                  <td>
                    <button
                      className="task-title"
                      onClick={() => onOpenLead(lead.id)}
                    >
                      {lead.name || "Обращение клиента"}
                    </button>
                    <span className="leads-cell-sub">
                      {lead.phone || lead.email || "Контакты в карточке"}
                    </span>
                  </td>
                  <td>{lead.service || lead.form || "Заявка с сайта"}</td>
                  <td className="nowrap muted">
                    {dateTime(lead.updatedAt, true)}
                  </td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => onOpenLead(lead.id)}
                    >
                      Открыть заявку
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            title={
              tab === "working"
                ? "Нет заявок в работе"
                : "Пока нет обработанных заявок"
            }
            text={
              tab === "working"
                ? "Откройте заявку и нажмите «Взять в работу», чтобы закрепить её за собой."
                : "Заявки, которым вы присвоите статус «Обработана», появятся здесь."
            }
          />
        )}
        <div className="leads-pagination">
          <span className="small muted">
            {tab === "documents"
              ? `Документов: ${documents?.total ?? "—"}`
              : `Заявок: ${leads?.total ?? "—"}`}
          </span>
          <div>
            <button
              className="button secondary"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              Назад
            </button>
            <span>
              {page} / {pages}
            </span>
            <button
              className="button secondary"
              disabled={page >= pages || loading}
              onClick={() => setPage(page + 1)}
            >
              Далее
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
