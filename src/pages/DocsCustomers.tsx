import { useCallback, useEffect, useRef, useState } from "react";
import {
  Building2,
  Trash2,
  RotateCcw,
  Check,
  ContactRound,
  Copy,
  Phone,
  PhoneCall,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { api, post, ApiError, dateTime, errorText, number } from "../api";
import { Empty, Loading, Notice, PageHead } from "../components/Common";
import { initials } from "../identity";
import type { AccountIdentity } from "../types";
import {
  DOCS_COMPANY_FIELDS,
  DOCS_CALL_OUTCOMES,
} from "../../shared/docs-customers.js";
import type { CompanyField } from "../../shared/docs-customers.js";
import "./DocsCustomers.css";
import DocsSales from "./DocsSales";
type Outcome = keyof typeof DOCS_CALL_OUTCOMES;
type Company = Record<CompanyField, string> & { savedAt: string };
type Call = {
  id: string;
  createdAt: string;
  outcome: Outcome;
  note: string;
  phone: string;
  actor: { id: string | null; name: string; kind: string };
  voidedAt: string | null;
  voidedBy: { name: string } | null;
  canVoid: boolean;
};
type CompanyUpdate = {
  eventId: string;
  changedAt: string;
  fields: { name: CompanyField; label: string }[];
  unread: boolean;
  reviewedAt: string | null;
};
type Customer = {
  id: string;
  externalId: string;
  name: string;
  phone: string;
  email: string;
  registeredAt: string | null;
  sourceUpdatedAt: string;
  company: Company | null;
  companyUpdate: CompanyUpdate | null;
  callCount: number;
  lastCall: Call | null;
  deletedAt: string | null;
  deletedBy: { name: string } | null;
  version: number;
};
type Listing = {
  companyUpdates: { pending: number; lastChangedAt: string | null };
  customers: Customer[];
  total: number;
  trashCount: number;
  page: number;
  pages: number;
  stats: { total: number; companies: number; uncalled: number; called: number };
};
type Detail = {
  customer: Customer;
  calls: Call[];
  companyHistory: {
    eventId: string;
    savedAt: string;
    company: Company;
    user: { id: string; name: string; email: string };
  }[];
};
type Connection = {
  configured: boolean;
  since: string;
  status: string;
  lastHeartbeatAt: string | null;
  lastReceivedAt: string | null;
  pending: number;
  rejected: number;
  canConfigure: boolean;
};
const connectionLabels: Record<string, string> = {
  unconfigured: "Ожидает подключения",
  waiting: "Ожидает первого запуска",
  online: "Доставка работает",
  syncing: "Загружаем новые данные",
  offline: "Нет связи с сайтом",
  attention: "Нужна проверка доставки",
};
const when = (value: string | null) => (value ? dateTime(value, true) : "—");
const phoneUrl = (value: string) => "tel:" + value.replace(/[^+\d]/g, "");
function Person({ call }: { call: Call }) {
  return (
    <span className="dc-person">
      <i>{initials(call.actor.name)}</i>
      {call.actor.name}
    </span>
  );
}
function CompanyFields({
  company,
  changed = [],
}: {
  company: Company;
  changed?: CompanyField[];
}) {
  return (
    <dl className="dc-fields">
      {DOCS_COMPANY_FIELDS.map((f) => (
        <div
          key={f.name}
          className={changed.includes(f.name) ? "dc-field-updated" : undefined}
        >
          <dt>
            {f.label}
            {changed.includes(f.name) && <small>Изменено</small>}
          </dt>
          <dd>{company[f.name] || "Не указано"}</dd>
        </div>
      ))}
    </dl>
  );
}
export default function DocsCustomers({
  active,
  account,
}: {
  active: boolean;
  account?: AccountIdentity;
}) {
  const [section, setSection] = useState<"customers" | "sales">("customers"),
    [salesRefresh, setSalesRefresh] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null),
    [connection, setConnection] = useState<Connection | null>(null),
    [error, setError] = useState("");
  const [query, setQuery] = useState(""),
    [debounced, setDebounced] = useState(""),
    [status, setStatus] = useState("all"),
    [company, setCompany] = useState(false),
    [mine, setMine] = useState(false),
    [sort, setSort] = useState("newest"),
    [page, setPage] = useState(1),
    [view, setView] = useState<"active" | "trash">("active"),
    [updatedOnly, setUpdatedOnly] = useState(false),
    [success, setSuccess] = useState("");
  const [selected, setSelected] = useState<string | null>(null),
    [settings, setSettings] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const id = setTimeout(() => {
      setDebounced(query.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(id);
  }, [query]);
  const refresh = useCallback(async () => {
    const n = ++generation.current;
    try {
      const params = new URLSearchParams({
        q: debounced,
        view,
        updated: updatedOnly ? "1" : "0",
        status,
        sort,
        page: String(page),
        company: company ? "1" : "0",
        mine: mine ? "1" : "0",
      });
      const [rows, link] = await Promise.all([
        api<Listing>("/docs-customers?" + params),
        api<Connection>("/docs-customers/connection"),
      ]);
      if (n !== generation.current) return;
      setListing(rows);
      setConnection(link);
      setError("");
    } catch (e) {
      if (n === generation.current) setError(errorText(e));
    }
  }, [debounced, status, sort, page, company, mine, view, updatedOnly]);
  useEffect(() => {
    if (!active || section !== "customers") return;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [active, refresh, section]);
  useEffect(() => {
    if (!active) {
      setSelected(null);
      setSettings(false);
    }
  }, [active]);
  const filter = (value: string) => {
    setStatus(value);
    setPage(1);
  };
  return (
    <div className="dc-page">
      <PageHead
        eyebrow="КЛИЕНТСКАЯ БАЗА"
        title="Клиенты BoykovDocs"
        description="Пользователи, компании, продажи инструкций и история общения."
      >
        <button
          className="button"
          onClick={() => {
            if (section === "customers") void refresh();
            else setSalesRefresh((v) => v + 1);
          }}
          aria-label={
            section === "customers" ? "Обновить клиентов" : "Обновить продажи"
          }
        >
          <RefreshCw size={17} />
          Обновить
        </button>
      </PageHead>
      <div
        className="docs-subtabs"
        role="tablist"
        aria-label="Подразделы BoykovDocs"
      >
        <button
          role="tab"
          id="docs-customers-tab"
          aria-controls="docs-customers-panel"
          aria-selected={section === "customers"}
          onClick={() => setSection("customers")}
        >
          Клиенты
        </button>
        <button
          role="tab"
          id="docs-sales-tab"
          aria-controls="docs-sales-panel"
          aria-selected={section === "sales"}
          onClick={() => setSection("sales")}
        >
          Продажи инструкций
        </button>
      </div>
      <div
        role="tabpanel"
        id="docs-customers-panel"
        aria-labelledby="docs-customers-tab"
        hidden={section !== "customers"}
      >
        {error && <Notice tone="error">{error}</Notice>}
        {success && <Notice tone="success">{success}</Notice>}
        {listing && (
          <div className="dc-metrics">
            {[
              ["Пользователи", listing.stats.total, ContactRound, "lime"],
              [
                "С данными компании",
                listing.stats.companies,
                Building2,
                "pink",
              ],
              ["Ещё не звонили", listing.stats.uncalled, Phone, ""],
              ["Звонок отмечен", listing.stats.called, PhoneCall, ""],
            ].map(([label, value, Icon, tone]) => {
              const Glyph = Icon as typeof Phone;
              return (
                <div className={"dc-metric " + tone} key={String(label)}>
                  <span>
                    {String(label)}
                    <Glyph size={19} />
                  </span>
                  <strong>{number(value as number)}</strong>
                  <div className="dc-metric-decoration" aria-hidden="true" />
                </div>
              );
            })}
          </div>
        )}
        {listing && listing.companyUpdates.pending > 0 && (
          <section
            className="dc-update-widget"
            aria-label="Непросмотренные обновления компаний"
          >
            <span className="dc-update-symbol">
              <RefreshCw size={23} />
            </span>
            <div>
              <span className="eyebrow">ИЗМЕНЕНИЯ НА BOYKOVDOCS</span>
              <h2>
                Обновлены данные компаний{" "}
                <strong>{number(listing.companyUpdates.pending)}</strong>
              </h2>
              <p>
                Проверьте изменения реквизитов. Последнее обновление:{" "}
                {when(listing.companyUpdates.lastChangedAt)} · Москва
              </p>
            </div>
            <button
              className="button"
              onClick={() => {
                setView("active");
                setUpdatedOnly(true);
                setPage(1);
                setStatus("all");
                setQuery("");
                setDebounced("");
                setCompany(false);
                setMine(false);
                setSort("newest");
              }}
            >
              Показать обновлённые
            </button>
          </section>
        )}
        <div className="dc-connection">
          <span className={"dc-health " + (connection?.status || "")}>
            <i />
            {connectionLabels[connection?.status || "unconfigured"]}
          </span>
          <span>
            Новые данные с{" "}
            {connection ? when(connection.since) : "19 ноября 2026, 00:00"} ·
            МСК
          </span>
          {connection && connection.pending > 0 && (
            <span>В очереди: {number(connection.pending)}</span>
          )}
          {connection?.canConfigure && (
            <button onClick={() => setSettings(true)}>
              <Settings2 size={16} />
              Подключение
            </button>
          )}
        </div>
        {connection && ["offline", "attention"].includes(connection.status) && (
          <Notice tone="error">
            Нет подтверждения исправной доставки BoykovDocs. Проверьте коннектор
            на сервере сайта. Последняя связь:{" "}
            {when(connection.lastHeartbeatAt)} МСК.
          </Notice>
        )}
        <section className="dc-directory" aria-label="Пользователи BoykovDocs">
          {view === "trash" && (
            <div className="dc-trash-caption">
              <Trash2 size={18} />
              <div>
                <strong>Корзина клиентов</strong>
                <p>
                  Удалённые карточки не возвращаются в рабочий список при
                  синхронизации. При необходимости их можно восстановить.
                </p>
              </div>
            </div>
          )}
          <div className="dc-toolbar">
            <label className="dc-search">
              <Search size={19} />
              <input
                aria-label="Поиск клиентов"
                placeholder="Имя, телефон, почта или ИНН"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                maxLength={300}
              />
            </label>
            <label className="dc-sort">
              Порядок
              <select
                aria-label="Порядок клиентов"
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value);
                  setPage(1);
                }}
              >
                <option value="newest">Сначала новые</option>
                <option value="oldest">Сначала ранние</option>
              </select>
            </label>
          </div>
          <div className="dc-filters">
            <div className="dc-tabs" aria-label="Фильтр по звонкам">
              {[
                ["all", "Все"],
                ["uncalled", "Не звонили"],
                ["called", "Звонили"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={status === value}
                  className={status === value ? "selected" : ""}
                  onClick={() => filter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label>
              <input
                type="checkbox"
                checked={company}
                onChange={(e) => {
                  setCompany(e.target.checked);
                  setPage(1);
                }}
              />
              С данными компании
            </label>
            {account?.id && (
              <label>
                <input
                  type="checkbox"
                  checked={mine}
                  onChange={(e) => {
                    setMine(e.target.checked);
                    setPage(1);
                  }}
                />
                Мои звонки
              </label>
            )}
            {view === "active" && (
              <label>
                <input
                  type="checkbox"
                  checked={updatedOnly}
                  onChange={(e) => {
                    setUpdatedOnly(e.target.checked);
                    setPage(1);
                  }}
                />
                Только обновления
              </label>
            )}
            <button
              className={
                "button dc-trash-toggle" + (view === "trash" ? " selected" : "")
              }
              aria-pressed={view === "trash"}
              onClick={() => {
                setView(view === "active" ? "trash" : "active");
                setStatus("all");
                setQuery("");
                setDebounced("");
                setCompany(false);
                setUpdatedOnly(false);
                setMine(false);
                setPage(1);
                setSuccess("");
              }}
            >
              <Trash2 size={16} />
              {view === "trash"
                ? "К рабочему списку"
                : `Корзина · ${listing?.trashCount || 0}`}
            </button>
          </div>
          {!listing ? (
            <Loading />
          ) : !listing.customers.length ? (
            <Empty
              title={
                query || status !== "all" || company || mine || updatedOnly
                  ? "Ничего не найдено"
                  : view === "trash"
                    ? "Корзина пуста"
                    : "Здесь появятся клиенты BoykovDocs"
              }
              text={
                query || status !== "all" || company || mine || updatedOnly
                  ? "Попробуйте изменить условия поиска."
                  : view === "trash"
                    ? "Удалённые карточки появятся здесь. Их можно будет восстановить."
                    : "Новые регистрации и сохранения данных компаний будут приходить автоматически после подключения."
              }
            />
          ) : (
            <>
              <div className="dc-list-head">
                <span>Пользователь</span>
                <span>Его компания</span>
                <span>Общение</span>
                <span />
              </div>
              <div className="dc-list">
                {listing.customers.map((c) => (
                  <article className="dc-row" key={c.id}>
                    <div className="dc-user-cell">
                      <span className="dc-avatar">{initials(c.name)}</span>
                      <div>
                        <button
                          className="dc-name"
                          onClick={() => setSelected(c.id)}
                        >
                          {c.name || "Без имени"}
                        </button>
                        <div className="dc-contact-links">
                          {c.phone && <a href={phoneUrl(c.phone)}>{c.phone}</a>}
                          {c.email && (
                            <a href={"mailto:" + encodeURIComponent(c.email)}>
                              {c.email}
                            </a>
                          )}
                        </div>
                        <small>ID {c.externalId}</small>
                      </div>
                    </div>
                    <div className="dc-company-cell">
                      {c.companyUpdate && (
                        <span
                          className={
                            "dc-update-badge" +
                            (c.companyUpdate.unread ? " unread" : "")
                          }
                        >
                          <RefreshCw size={13} />
                          {c.companyUpdate.unread
                            ? "Обновлено"
                            : "Обновление просмотрено"}
                        </span>
                      )}
                      {c.company ? (
                        <>
                          <strong>
                            {c.company.companyName || "Данные компании"}
                          </strong>
                          <span>
                            {c.company.inn
                              ? "ИНН " + c.company.inn
                              : "ИНН не указан"}
                          </span>
                          <small>Сохранено {when(c.company.savedAt)}</small>
                        </>
                      ) : (
                        <span className="dc-muted">Пока не заполнена</span>
                      )}
                    </div>
                    <div className="dc-call-cell">
                      {c.lastCall ? (
                        <>
                          <span
                            className={"dc-call-state " + c.lastCall.outcome}
                          >
                            {DOCS_CALL_OUTCOMES[c.lastCall.outcome]}
                          </span>
                          <Person call={c.lastCall} />
                          <small>{when(c.lastCall.createdAt)}</small>
                        </>
                      ) : (
                        <span className="dc-call-state uncalled">
                          Не звонили
                        </span>
                      )}
                    </div>
                    <button
                      className="button dc-open"
                      onClick={() => setSelected(c.id)}
                    >
                      {c.deletedAt ? "Посмотреть" : "Карточка"}
                    </button>
                  </article>
                ))}
              </div>
              <footer className="dc-pagination">
                <span>Найдено: {number(listing.total)}</span>
                <div>
                  <button
                    className="button"
                    disabled={listing.page <= 1}
                    onClick={() => setPage(listing.page - 1)}
                  >
                    Назад
                  </button>
                  <span>
                    {listing.page} / {listing.pages}
                  </span>
                  <button
                    className="button"
                    disabled={listing.page >= listing.pages}
                    onClick={() => setPage(listing.page + 1)}
                  >
                    Далее
                  </button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>
      <div
        role="tabpanel"
        id="docs-sales-panel"
        aria-labelledby="docs-sales-tab"
        hidden={section !== "sales"}
      >
        <DocsSales
          active={active && section === "sales"}
          refreshKey={salesRefresh}
          onOpenCustomer={setSelected}
        />
      </div>
      {selected && (
        <CustomerDialog
          key={selected}
          id={selected}
          account={account}
          onClose={() => setSelected(null)}
          onChange={() => void refresh()}
          onTrashed={(deleted) => {
            setSelected(null);
            setSuccess(
              deleted
                ? "Карточка перемещена в корзину. При необходимости её можно восстановить."
                : "Карточка восстановлена в рабочем списке.",
            );
            void refresh();
          }}
        />
      )}
      {settings && connection && (
        <ConnectionDialog
          connection={connection}
          onClose={() => setSettings(false)}
          onChange={() => void refresh()}
        />
      )}
    </div>
  );
}
function CustomerDialog({
  id,
  account,
  onClose,
  onChange,
  onTrashed,
}: {
  id: string;
  account?: AccountIdentity;
  onClose: () => void;
  onChange: () => void;
  onTrashed: (deleted: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    alive = useRef(true),
    draft = useRef<{
      requestId: string;
      version: number;
      outcome: Outcome;
      note: string;
    } | null>(null);
  const [data, setData] = useState<Detail | null>(null),
    [error, setError] = useState(""),
    [outcome, setOutcome] = useState<Outcome>("reached"),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(false),
    [message, setMessage] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false),
    [trashRetry, setTrashRetry] = useState(false);
  const trashDraft = useRef<{
    requestId: string;
    version: number;
    action: "delete" | "restore";
  } | null>(null);
  const refresh = useCallback(async () => {
    const d = await api<Detail>("/docs-customers/" + id);
    if (alive.current) setData(d);
    return d;
  }, [id]);
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    void refresh().catch((e) => setError(errorText(e)));
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  async function save() {
    if (!data || busy || data.customer.deletedAt || confirmDelete || trashRetry)
      return;
    setBusy(true);
    setError("");
    setMessage("");
    const body = draft.current || {
      requestId: crypto.randomUUID(),
      version: data.customer.version,
      outcome,
      note,
    };
    draft.current = body;
    try {
      await post("/docs-customers/" + id + "/calls", body);
      draft.current = null;
      setRetry(false);
      setNote("");
      await refresh();
      onChange();
      setMessage("Звонок сохранён. Автор и время добавлены в историю.");
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        draft.current = null;
        setRetry(false);
        if (e.status === 409) await refresh().catch(() => {});
      } else setRetry(true);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function voidCall(call: Call) {
    if (
      !data ||
      busy ||
      retry ||
      data.customer.deletedAt ||
      confirmDelete ||
      trashRetry
    )
      return;
    setBusy(true);
    setError("");
    try {
      await post("/docs-customers/" + id + "/calls/" + call.id + "/void", {
        requestId: crypto.randomUUID(),
        version: data.customer.version,
      });
      await refresh();
      onChange();
      setMessage("Отметка отменена. Запись осталась в истории.");
    } catch (e) {
      setError(errorText(e));
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function reviewUpdate() {
    const update = data?.customer.companyUpdate;
    if (
      !update ||
      !data ||
      busy ||
      retry ||
      confirmDelete ||
      trashRetry ||
      data.customer.deletedAt
    )
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await post("/docs-customers/" + id + "/company-update/seen", {
        eventId: update.eventId,
      });
      await refresh();
      onChange();
      setMessage(
        account?.id
          ? "Обновление отмечено просмотренным для вашего аккаунта."
          : "Обновление отмечено просмотренным для общего доступа.",
      );
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.status === 409)
        await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function changeTrash(action: "delete" | "restore") {
    if (!data || busy || retry) return;
    const body = trashDraft.current || {
      requestId: crypto.randomUUID(),
      version: data.customer.version,
      action,
    };
    trashDraft.current = body;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await post("/docs-customers/" + id + "/trash", body);
      trashDraft.current = null;
      setTrashRetry(false);
      onTrashed(action === "delete");
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        trashDraft.current = null;
        setTrashRetry(false);
        setConfirmDelete(false);
        if (e.status === 409) await refresh().catch(() => {});
      } else setTrashRetry(true);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const c = data?.customer;
  return (
    <dialog
      className="dc-dialog"
      aria-labelledby="dc-customer-title"
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dc-dialog-header">
        <div>
          <span className="eyebrow">BOYKOVDOCS · КАРТОЧКА КЛИЕНТА</span>
          <h2 id="dc-customer-title">{c?.name || "Пользователь"}</h2>
          <span className="dc-muted">
            ID пользователя: {c?.externalId || "…"}
          </span>
        </div>
        <div className="dc-card-actions">
          {c && (
            <button
              className={"button " + (c.deletedAt ? "" : "dc-danger")}
              disabled={busy || retry || confirmDelete || trashRetry}
              onClick={() => {
                if (c.deletedAt) void changeTrash("restore");
                else {
                  setConfirmDelete(true);
                  setError("");
                  setMessage("");
                }
              }}
            >
              {c.deletedAt ? <RotateCcw size={16} /> : <Trash2 size={16} />}
              {c.deletedAt ? "Восстановить" : "Удалить"}
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Закрыть карточку"
            disabled={busy}
            onClick={onClose}
          >
            <X size={22} />
          </button>
        </div>
      </div>
      {confirmDelete && c && (
        <div
          className="dc-delete-confirm"
          role="group"
          aria-label="Подтверждение удаления клиента"
        >
          <strong>Удалить карточку «{c.name || "Без имени"}»?</strong>
          <p>
            {c.email || c.phone || "Контакты не указаны"} · ID {c.externalId}
          </p>
          <p>
            Карточка и её данные компании переместятся в корзину Boykov
            Services. Аккаунт на BoykovDocs останется действующим.
          </p>
          {trashRetry && (
            <p>
              Ответ сервера не получен. Повторите действие: второй операции не
              возникнет.
            </p>
          )}
          <div>
            <button
              className="button dc-danger"
              disabled={busy}
              onClick={() => void changeTrash("delete")}
            >
              {busy
                ? "Перемещаем…"
                : trashRetry
                  ? "Повторить удаление"
                  : "В корзину"}
            </button>
            <button
              className="button"
              disabled={busy || trashRetry}
              onClick={() => setConfirmDelete(false)}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
      {c?.companyUpdate && (
        <section
          className={
            "dc-detail-update" + (c.companyUpdate.unread ? " unread" : "")
          }
          aria-label="Обновление данных компании"
        >
          <RefreshCw size={19} />
          <div>
            <strong>Компания обновлена</strong>
            <p>{when(c.companyUpdate.changedAt)} · Москва</p>
            <p>
              Изменились:{" "}
              {c.companyUpdate.fields.map((f) => f.label).join(", ")}
            </p>
            {!c.companyUpdate.unread && (
              <small>Просмотрено {when(c.companyUpdate.reviewedAt)}</small>
            )}
          </div>
          {c.companyUpdate.unread && !c.deletedAt && (
            <button
              className="button"
              disabled={busy || retry || confirmDelete || trashRetry}
              onClick={() => void reviewUpdate()}
            >
              <Check size={16} />
              Просмотрено
            </button>
          )}
        </section>
      )}
      {c?.deletedAt && (
        <Notice>
          Карточка в корзине с {when(c.deletedAt)} · Москва. Удалил:{" "}
          {c.deletedBy?.name || "Общий доступ"}. Чтобы продолжить работу,
          восстановите её.
        </Notice>
      )}
      {trashRetry && !confirmDelete && (
        <Notice tone="error">
          Ответ о восстановлении не получен.{" "}
          <button
            className="button"
            disabled={busy}
            onClick={() => void changeTrash("restore")}
          >
            Повторить восстановление
          </button>
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {!c ? (
        <Loading />
      ) : (
        <>
          <div className="dc-detail-grid">
            <section className="dc-contact-panel">
              <ContactRound size={25} />
              <h3>Пользователь BoykovDocs</h3>
              <dl className="dc-fields">
                <div>
                  <dt>Имя</dt>
                  <dd>{c.name || "Не указано"}</dd>
                </div>
                <div>
                  <dt>Телефон</dt>
                  <dd>
                    {c.phone ? (
                      <a href={phoneUrl(c.phone)}>{c.phone}</a>
                    ) : (
                      "Не указан"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Электронная почта</dt>
                  <dd>
                    {c.email ? (
                      <a href={"mailto:" + encodeURIComponent(c.email)}>
                        {c.email}
                      </a>
                    ) : (
                      "Не указана"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Зарегистрирован · Москва</dt>
                  <dd>{when(c.registeredAt)}</dd>
                </div>
                <div>
                  <dt>ID на сайте</dt>
                  <dd className="dc-id">{c.externalId}</dd>
                </div>
              </dl>
            </section>
            <section className="dc-company-panel">
              <Building2 size={25} />
              <h3>Компания этого пользователя</h3>
              <div className="dc-owner">
                <strong>Заполнил: {c.name || "Пользователь без имени"}</strong>
                <span>
                  {c.email || "Почта не указана"} · ID {c.externalId}
                </span>
              </div>
              {c.company ? (
                <>
                  <p className="dc-saved">
                    Данные сохранены {when(c.company.savedAt)} · Москва
                  </p>
                  <CompanyFields
                    company={c.company}
                    changed={c.companyUpdate?.fields.map((f) => f.name)}
                  />
                </>
              ) : (
                <p className="dc-muted">
                  Пользователь ещё не сохранил данные компании с начала
                  подключения.
                </p>
              )}
            </section>
          </div>
          {data!.companyHistory.length > 1 && (
            <details className="dc-versions">
              <summary>
                Предыдущие сохранения компании · {data!.companyHistory.length}
              </summary>
              {data!.companyHistory.slice(1).map((v) => (
                <section key={v.eventId}>
                  <h4>{when(v.savedAt)} · Москва</h4>
                  <p>
                    Заполнил: {v.user.name || "Без имени"} · {v.user.email} · ID{" "}
                    {v.user.id}
                  </p>
                  <CompanyFields company={v.company} />
                </section>
              ))}
            </details>
          )}
          <div className="dc-calls-grid">
            <section className="dc-call-form">
              <span className="eyebrow">ОБЩЕНИЕ С КЛИЕНТОМ</span>
              <h3>Отметить звонок</h3>
              <p>
                Ссылка на телефон открывает набор номера. Результат звонка
                сохраняется здесь.
              </p>
              {!account?.id && (
                <Notice>
                  Вы вошли через общий доступ. В истории будет указано «Общий
                  доступ». Для своего имени войдите в личный аккаунт.
                </Notice>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <fieldset
                  disabled={
                    busy ||
                    retry ||
                    !!c.deletedAt ||
                    confirmDelete ||
                    trashRetry
                  }
                >
                  <legend>Результат звонка</legend>
                  <div className="dc-outcomes">
                    {Object.entries(DOCS_CALL_OUTCOMES).map(([key, label]) => (
                      <label key={key}>
                        <input
                          type="radio"
                          name="call-outcome"
                          value={key}
                          checked={outcome === key}
                          onChange={() => setOutcome(key as Outcome)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  <label className="dc-note">
                    Комментарий
                    <textarea
                      rows={3}
                      maxLength={4000}
                      placeholder="О чём договорились, когда перезвонить…"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </label>
                </fieldset>
                <button
                  className="button primary"
                  disabled={
                    busy || !!c.deletedAt || confirmDelete || trashRetry
                  }
                  type="submit"
                >
                  <Check size={17} />
                  {busy
                    ? "Сохраняем…"
                    : retry
                      ? "Повторить сохранение"
                      : "Сохранить звонок"}
                </button>
                {retry && (
                  <p className="dc-muted">
                    Ответ сервера не получен. Повторите сохранение: второй
                    звонок не создастся.
                  </p>
                )}
              </form>
            </section>
            <section className="dc-call-history">
              <h3>
                История звонков <span>{c.callCount}</span>
              </h3>
              {!data!.calls.length ? (
                <p className="dc-muted">
                  Пока никто не отмечал звонки этому пользователю.
                </p>
              ) : (
                data!.calls.map((call) => (
                  <article
                    key={call.id}
                    className={call.voidedAt ? "dc-call voided" : "dc-call"}
                  >
                    <div>
                      <strong>{DOCS_CALL_OUTCOMES[call.outcome]}</strong>
                      <time>{when(call.createdAt)}</time>
                    </div>
                    <Person call={call} />
                    {call.note && <p>{call.note}</p>}
                    {call.voidedAt ? (
                      <small>
                        Отменено: {call.voidedBy?.name} · {when(call.voidedAt)}
                      </small>
                    ) : (
                      call.canVoid && (
                        <button
                          disabled={
                            busy ||
                            retry ||
                            !!c.deletedAt ||
                            confirmDelete ||
                            trashRetry
                          }
                          onClick={() => void voidCall(call)}
                        >
                          Отменить отметку
                        </button>
                      )
                    )}
                  </article>
                ))
              )}
            </section>
          </div>
        </>
      )}
    </dialog>
  );
}
function ConnectionDialog({
  connection,
  onClose,
  onChange,
}: {
  connection: Connection;
  onClose: () => void;
  onChange: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  async function generate() {
    setBusy(true);
    setError("");
    try {
      const r = await post<{ token: string }>(
        "/docs-customers/connection/key",
        {},
      );
      setToken(r.token);
      onChange();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      className="dc-dialog dc-settings-dialog"
      aria-labelledby="dc-connection-title"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dc-dialog-header">
        <h2 id="dc-connection-title">Подключение BoykovDocs</h2>
        <button
          className="icon-button"
          aria-label="Закрыть подключение"
          disabled={busy}
          onClick={onClose}
        >
          <X size={22} />
        </button>
      </div>
      <p>
        Коннектор читает регистрации и данные компаний на сервере BoykovDocs.
        Новые данные поступают с {when(connection.since)} по Москве.
      </p>
      <p>
        Создайте ключ, затем запустите{" "}
        <code>scripts/install-docs-customers.sh</code> на сервере BoykovDocs и
        вставьте ключ в скрытый запрос установщика.
      </p>
      {connection.configured && !token && (
        <Notice>
          Новый ключ отключит прежний коннектор до повторной настройки.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {token ? (
        <>
          <Notice>
            Ключ показывается один раз. После закрытия окна он больше не
            отображается.
          </Notice>
          <label>
            Ключ подключения
            <input type="password" readOnly value={token} autoComplete="off" />
          </label>
          <button
            className="button primary"
            onClick={() => {
              void navigator.clipboard
                .writeText(token)
                .then(() => setCopied(true))
                .catch(() =>
                  setError(
                    "Не удалось скопировать ключ. Выделите его в поле и скопируйте вручную.",
                  ),
                );
            }}
          >
            <Copy size={17} />
            {copied ? "Скопировано" : "Скопировать ключ"}
          </button>
        </>
      ) : (
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void generate()}
        >
          {busy
            ? "Создаём…"
            : connection.configured
              ? "Выпустить новый ключ"
              : "Создать ключ подключения"}
        </button>
      )}
    </dialog>
  );
}
