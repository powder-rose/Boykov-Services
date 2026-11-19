import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  Globe2,
  Inbox,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { api, ApiError, dateTime, errorText, post } from "../api";
import { Empty, Loading, Notice, PageHead } from "../components/Common";
import "./Leads.css";

type State = "new" | "working" | "processed";
type DeliveryMode = "agent" | "tilda";
type ConnectionSecret = {
  token: string;
  endpoint: string;
  deliveryMode: DeliveryMode;
};
type Site = {
  id: string;
  name: string;
  host: string;
  configured: boolean;
  deliveryMode: DeliveryMode;
  webhookVerifiedAt: string | null;
  webhookError: string | null;
  connection: string;
  stats: Record<State, number>;
  pending: number;
  rejected: number;
  scanOk: boolean;
  lastReceivedAt: string | null;
  lastHeartbeatAt: string | null;
};
type Lead = {
  id: string;
  siteId: string;
  eventId: string;
  createdAt: string;
  receivedAt: string;
  updatedAt: string;
  name: string;
  phone: string;
  email: string;
  service: string;
  message: string;
  form: string;
  pageUrl: string;
  fields: { label: string; value: string }[];
  status: State;
  note: string;
  version: number;
};
type Detail = {
  lead: Lead;
  history: {
    createdAt: string;
    status: State;
    note: string;
    version: number;
  }[];
};
type Result = { leads: Lead[]; total: number; page: number; pages: number };
type Change = {
  requestId: string;
  version: number;
  status: State;
  note: string;
};
const labels: Record<State, string> = {
  new: "Новая",
  working: "В работе",
  processed: "Обработана",
};
const plural: Record<State, string> = {
  new: "Новые",
  working: "В работе",
  processed: "Обработанные",
};
const connections: Record<string, string> = {
  unconfigured: "Не подключён",
  waiting: "Ожидаем первый сигнал",
  online: "Доставка работает",
  offline: "Нет сигнала доставки",
  attention: "Проверьте доставку",
  webhook: "Webhook подтверждён",
  webhook_waiting: "Ожидаем проверку Tilda",
};
const states: State[] = ["new", "working", "processed"];
const empty: Result = { leads: [], total: 0, page: 1, pages: 1 };

export default function Leads({
  active,
  onChange,
}: {
  active: boolean;
  onChange: () => void;
}) {
  const [sites, setSites] = useState<Site[]>([]),
    [result, setResult] = useState<Result>(empty);
  const [site, setSite] = useState(""),
    [status, setStatus] = useState(""),
    [order, setOrder] = useState("newest"),
    [page, setPage] = useState(1);
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [updated, setUpdated] = useState("");
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [detailError, setDetailError] = useState("");
  const [note, setNote] = useState(""),
    [draftStatus, setDraftStatus] = useState<State>("new"),
    [saving, setSaving] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [reviewing, setReviewing] = useState(false),
    [discard, setDiscard] = useState(false);
  const [connectSite, setConnectSite] = useState<Site | "new" | null>(null),
    [secret, setSecret] = useState<ConnectionSecret | null>(null);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("agent");
  const [sourceName, setSourceName] = useState(""),
    [host, setHost] = useState(""),
    [sourceError, setSourceError] = useState(""),
    [sourceBusy, setSourceBusy] = useState(false),
    [copied, setCopied] = useState(false);
  const listSequence = useRef(0),
    detailSequence = useRef(0),
    pending = useRef<Change | null>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    connectDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const load = useCallback(async () => {
    const sequence = ++listSequence.current;
    setLoading(true);
    try {
      const [data, sources] = await Promise.all([
        api<Result>(
          `/leads?${new URLSearchParams({ site, status, order, q: query, page: String(page) })}`,
        ),
        api<{ sites: Site[] }>("/leads/sites"),
      ]);
      if (sequence !== listSequence.current) return;
      if (page > data.pages) {
        setPage(data.pages);
        return;
      }
      setResult(data);
      setSites(sources.sites);
      setLoaded(true);
      setError("");
      setUpdated(new Date().toISOString());
    } catch (err) {
      if (sequence === listSequence.current) setError(errorText(err));
    } finally {
      if (sequence === listSequence.current) setLoading(false);
    }
  }, [site, status, order, query, page]);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    return () => {
      clearInterval(timer);
      listSequence.current++;
    };
  }, [active, load]);
  async function loadDetail(id: string, preserveDraft = false) {
    const sequence = ++detailSequence.current;
    setDetailError("");
    try {
      const value = await api<Detail>(`/leads/${id}`);
      if (sequence !== detailSequence.current) return;
      setDetail(value);
      setReviewing(preserveDraft);
      if (!preserveDraft) {
        setNote(value.lead.note);
        setDraftStatus(value.lead.status);
      }
    } catch (err) {
      if (sequence === detailSequence.current) setDetailError(errorText(err));
    }
  }
  function openLead(id: string) {
    setSelected(id);
    setDetail(null);
    setDiscard(false);
    setUncertain(false);
    setReviewing(false);
    pending.current = null;
    void loadDetail(id);
  }
  useEffect(() => {
    if (active && selected && !dialog.current?.open)
      dialog.current?.showModal();
    if (!active) dialog.current?.close();
  }, [selected, active]);
  useEffect(() => {
    if (active && connectSite && !connectDialog.current?.open)
      connectDialog.current?.showModal();
    if (!active) connectDialog.current?.close();
  }, [connectSite, active]);
  function closeLead(force = false) {
    if (saving) return;
    if (
      !force &&
      detail &&
      (uncertain ||
        note !== detail.lead.note ||
        draftStatus !== detail.lead.status)
    ) {
      setDiscard(true);
      return;
    }
    detailSequence.current++;
    setSelected(null);
    setDetail(null);
    pending.current = null;
  }
  async function save() {
    if (!detail || saving) return;
    pending.current ??= {
      requestId: crypto.randomUUID(),
      version: detail.lead.version,
      status: draftStatus,
      note,
    };
    setSaving(true);
    setDetailError("");
    try {
      const value = await api<{ lead: Lead }>(`/leads/${detail.lead.id}`, {
        method: "PATCH",
        body: JSON.stringify(pending.current),
      });
      pending.current = null;
      setUncertain(false);
      setNote(value.lead.note);
      setDraftStatus(value.lead.status);
      setDetail((d) => (d ? { ...d, lead: value.lead } : d));
      await loadDetail(value.lead.id);
      void load();
      onChange();
    } catch (err) {
      const unknown = !(err instanceof ApiError) || err.status >= 500;
      setUncertain(unknown);
      if (!unknown) pending.current = null;
      setDetailError(
        unknown
          ? "Подтверждение сохранения не получено. Повторите сохранение: изменение будет выполнено один раз."
          : errorText(err),
      );
    } finally {
      setSaving(false);
    }
  }
  function openConnection(value: Site | "new") {
    setConnectSite(value);
    setSecret(null);
    setSourceError("");
    setSourceName("");
    setHost("");
    setDeliveryMode("agent");
    setCopied(false);
  }
  async function connect() {
    if (!connectSite || sourceBusy) return;
    setSourceBusy(true);
    setSourceError("");
    try {
      const value =
        connectSite === "new"
          ? await post<ConnectionSecret>("/leads/sites", {
              name: sourceName,
              host,
              deliveryMode,
            })
          : await post<ConnectionSecret>(
              `/leads/sites/${connectSite.id}/token`,
              {},
            );
      setSecret(value);
      void load();
    } catch (err) {
      setSourceError(errorText(err));
    } finally {
      setSourceBusy(false);
    }
  }
  const currentSites = sites.filter((s) => !site || s.id === site);
  const totals = states.map((s) =>
    currentSites.reduce((sum, source) => sum + source.stats[s], 0),
  );
  const selectedSite = sites.find((s) => s.id === detail?.lead.siteId);
  const problematic = sites.filter((s) =>
    ["offline", "attention"].includes(s.connection),
  );
  return (
    <>
      <PageHead
        eyebrow="ОТДЕЛ ПРОДАЖ"
        title="Заявки"
        description="Обращения со всех сайтов. Контакты, история и следующий шаг — рядом."
      >
        <div className="button-row">
          <button
            className="button secondary"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? "spin" : ""} />
            Обновить
          </button>
          <button
            className="button primary"
            onClick={() => openConnection("new")}
          >
            <Plus size={17} />
            Добавить сайт
          </button>
        </div>
      </PageHead>
      {error && (
        <Notice tone="error">
          Не удалось обновить заявки. Показаны последние загруженные данные.{" "}
          {error}
        </Notice>
      )}
      {problematic.length > 0 && (
        <Notice tone="error">
          Нет подтверждения исправной доставки:{" "}
          {problematic.map((s) => s.host).join(", ")}. Проверьте подключения и
          журнал отправок на сайтах.
        </Notice>
      )}
      <section className="leads-stats" aria-label="Статусы заявок">
        {states.map((state, index) => (
          <button
            key={state}
            className={`leads-stat leads-stat-${state} ${status === state ? "selected" : ""}`}
            aria-pressed={status === state}
            onClick={() => {
              setStatus(status === state ? "" : state);
              setPage(1);
            }}
          >
            <span>{plural[state]}</span>
            <strong>{totals[index]}</strong>
            <span>
              {state === "new"
                ? "Ждут первого контакта"
                : state === "working"
                  ? "Продолжаем общение"
                  : "Сохранены в истории"}
            </span>
          </button>
        ))}
      </section>
      <section className="leads-sources" aria-label="Сайты">
        <button
          className={`leads-source leads-all ${site === "" ? "selected" : ""}`}
          onClick={() => {
            setSite("");
            setPage(1);
          }}
          aria-pressed={!site}
        >
          <Inbox size={20} />
          <span>
            <b>Все сайты</b>
            <small>Всего сайтов: {sites.length}</small>
          </span>
          <strong>{sites.reduce((sum, s) => sum + s.stats.new, 0)}</strong>
        </button>
        {sites.map((source) => (
          <div
            className={`leads-source-wrap ${site === source.id ? "selected" : ""}`}
            key={source.id}
          >
            <button
              className="leads-source"
              onClick={() => {
                setSite(source.id);
                setPage(1);
              }}
              aria-pressed={site === source.id}
            >
              <Globe2 size={19} />
              <span>
                <b>{source.name}</b>
                <small>{source.host}</small>
              </span>
              <strong title="Новых заявок">{source.stats.new}</strong>
            </button>
            <button
              className={`leads-connection connection-${source.connection}`}
              onClick={() => openConnection(source)}
            >
              <i />
              {connections[source.connection]}
              {source.pending > 0 && ` · в очереди ${source.pending}`}
            </button>
          </div>
        ))}
      </section>
      <section className="panel leads-panel" aria-label="Входящие заявки">
        <div className="leads-toolbar">
          <label className="leads-search">
            <Search size={17} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Имя, телефон, почта или услуга"
              aria-label="Поиск заявок"
              maxLength={200}
            />
          </label>
          <label>
            <span className="sr-only">Статус</span>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Все статусы</option>
              {states.map((s) => (
                <option key={s} value={s}>
                  {plural[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Сортировка</span>
            <select
              value={order}
              onChange={(e) => {
                setOrder(e.target.value);
                setPage(1);
              }}
            >
              <option value="newest">Сначала новые</option>
              <option value="status">Сначала необработанные</option>
              <option value="oldest">Сначала старые</option>
            </select>
          </label>
        </div>
        {!loaded && loading ? (
          <Loading />
        ) : result.leads.length ? (
          <div className="table-scroll">
            <table className="events leads-table">
              <thead>
                <tr>
                  <th>Клиент</th>
                  <th>Сайт / услуга</th>
                  <th>Поступила · МСК</th>
                  <th>Статус</th>
                  <th>
                    <span className="sr-only">Открыть</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.leads.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      <button
                        className="task-title"
                        onClick={() => openLead(lead.id)}
                      >
                        {lead.name || "Без имени"}
                      </button>
                      <span className="leads-cell-sub">
                        {lead.phone || lead.email || "Контакты не указаны"}
                      </span>
                    </td>
                    <td>
                      <span className="leads-domain">
                        {sites.find((s) => s.id === lead.siteId)?.host}
                      </span>
                      <span className="leads-cell-sub">
                        {lead.service || lead.form || "Обращение с сайта"}
                      </span>
                    </td>
                    <td className="nowrap muted">
                      {dateTime(lead.createdAt, true)}
                    </td>
                    <td>
                      <span className={`status lead-status-${lead.status}`}>
                        <i />
                        {labels[lead.status]}
                      </span>
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        onClick={() => openLead(lead.id)}
                        aria-label={`Открыть заявку ${lead.name || lead.phone || lead.email}`}
                      >
                        <ArrowUpRight size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={
              search || site || status
                ? "Заявок по этим условиям нет"
                : "Здесь будут обращения клиентов"
            }
            text={
              sites.some((s) => s.configured)
                ? "Новые заявки появятся после доставки с подключённых сайтов. Статусы подключений указаны выше."
                : "Настройте подключение сайтов. После этого обращения из форм будут появляться в этом разделе."
            }
          />
        )}
        <div className="leads-pagination">
          <span className="muted small">
            Найдено: {result.total} ·{" "}
            {updated
              ? `Обновлено ${dateTime(updated, true)} · МСК`
              : "Ожидаем загрузку"}
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
              {page} / {result.pages}
            </span>
            <button
              className="button secondary"
              disabled={page >= result.pages || loading}
              onClick={() => setPage(page + 1)}
            >
              Далее
            </button>
          </div>
        </div>
      </section>
      {selected && (
        <dialog
          ref={dialog}
          className="job-dialog lead-dialog"
          onCancel={(e) => {
            e.preventDefault();
            closeLead();
          }}
        >
          <div className="dialog-heading">
            <span className="eyebrow">КАРТОЧКА ЗАЯВКИ</span>
            <button
              className="icon-button"
              onClick={() => closeLead()}
              aria-label="Закрыть заявку"
              disabled={saving}
            >
              <X size={20} />
            </button>
          </div>
          {discard && (
            <Notice>
              Есть несохранённые изменения или неподтверждённое сохранение.
              <div className="button-row">
                <button
                  className="text-button"
                  onClick={() => setDiscard(false)}
                >
                  Продолжить работу
                </button>
                <button className="text-button" onClick={() => closeLead(true)}>
                  Закрыть карточку
                </button>
              </div>
            </Notice>
          )}
          {detailError && (
            <Notice tone="error">
              {detailError}
              <button
                className="text-button"
                disabled={saving || uncertain}
                onClick={() => void loadDetail(selected, Boolean(detail))}
              >
                Обновить карточку
              </button>
            </Notice>
          )}
          {!detail ? (
            <Loading />
          ) : (
            <>
              <h2>{detail.lead.name || "Обращение клиента"}</h2>
              <p className="muted">
                {selectedSite?.name} · {dateTime(detail.lead.createdAt, true)} ·
                МСК
              </p>
              <div className="lead-contacts">
                {detail.lead.phone && (
                  <a href={`tel:${detail.lead.phone.replace(/[^\d+]/g, "")}`}>
                    {detail.lead.phone}
                  </a>
                )}
                {detail.lead.email && (
                  <a href={`mailto:${encodeURIComponent(detail.lead.email)}`}>
                    {detail.lead.email}
                  </a>
                )}
              </div>
              {(detail.lead.service || detail.lead.form) && (
                <p>{detail.lead.service || detail.lead.form}</p>
              )}
              {detail.lead.message && (
                <p className="lead-message">{detail.lead.message}</p>
              )}
              {detail.lead.pageUrl && (
                <a
                  className="text-button lead-page-link"
                  target="_blank"
                  rel="noreferrer"
                  href={detail.lead.pageUrl}
                >
                  Страница обращения
                  <ArrowUpRight size={15} />
                </a>
              )}
              {detail.lead.fields.length > 0 && (
                <details className="lead-fields">
                  <summary>Данные формы · {detail.lead.fields.length}</summary>
                  <dl>
                    {detail.lead.fields.map((f, i) => (
                      <div key={i}>
                        <dt>{f.label}</dt>
                        <dd>{f.value || "—"}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
              <div className="lead-edit">
                {reviewing && (
                  <Notice>
                    Карточка обновлена. Проверьте сохранённые данные перед
                    повторным изменением: статус «{labels[detail.lead.status]}»,
                    комментарий:{" "}
                    <span className="lead-message">
                      {detail.lead.note || "не указан"}
                    </span>
                    . Ваш черновик остаётся в полях ниже.
                  </Notice>
                )}
                {!detail.lead.phone && !detail.lead.email && (
                  <Notice>
                    В исходной заявке не указан телефон или email. Проверьте
                    остальные данные формы.
                  </Notice>
                )}
                <label>
                  Статус
                  <select
                    value={draftStatus}
                    disabled={saving || uncertain}
                    onChange={(e) => setDraftStatus(e.target.value as State)}
                  >
                    {states.map((s) => (
                      <option key={s} value={s}>
                        {labels[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Комментарий отдела продаж
                  <textarea
                    rows={4}
                    value={note}
                    maxLength={12000}
                    disabled={saving || uncertain}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Результат звонка, договорённости и следующий шаг"
                  />
                </label>
                <button
                  className="button primary"
                  disabled={
                    saving ||
                    (!uncertain &&
                      note === detail.lead.note &&
                      draftStatus === detail.lead.status)
                  }
                  onClick={() => void save()}
                >
                  <Check size={17} />
                  {saving
                    ? "Сохраняем…"
                    : uncertain
                      ? "Повторить сохранение"
                      : "Сохранить изменения"}
                </button>
              </div>
              <details className="lead-fields">
                <summary>История обработки · {detail.history.length}</summary>
                <ol className="lead-history">
                  {detail.history.map((h) => (
                    <li key={h.version}>
                      <span className={`status lead-status-${h.status}`}>
                        <i />
                        {labels[h.status]}
                      </span>
                      <time>{dateTime(h.createdAt, true)} · МСК</time>
                      {h.note && <p>{h.note}</p>}
                    </li>
                  ))}
                </ol>
              </details>
              <p className="small muted">
                Получена в Boykov Services:{" "}
                {dateTime(detail.lead.receivedAt, true)} · МСК
                <br />
                Номер в источнике: {detail.lead.eventId}
              </p>
            </>
          )}
        </dialog>
      )}
      {connectSite && (
        <dialog
          ref={connectDialog}
          className="job-dialog"
          onCancel={(e) => {
            e.preventDefault();
            if (!sourceBusy) setConnectSite(null);
          }}
        >
          <div className="dialog-heading">
            <span className="eyebrow">ПОДКЛЮЧЕНИЕ САЙТА</span>
            <button
              className="icon-button"
              disabled={sourceBusy}
              onClick={() => setConnectSite(null)}
              aria-label="Закрыть подключение"
            >
              <X size={20} />
            </button>
          </div>
          <h2>
            {connectSite === "new" ? "Новый источник заявок" : connectSite.name}
          </h2>
          {sourceError && <Notice tone="error">{sourceError}</Notice>}
          {secret ? (
            <>
              <Notice>
                Сохраните ключ сейчас: повторно он не показывается.{" "}
                {secret.deliveryMode === "tilda"
                  ? "Укажите его в настройках Webhook в Tilda."
                  : "Установите его только на сервере сайта."}
              </Notice>
              <label className="lead-secret">
                Адрес приёма
                <input
                  readOnly
                  value={location.origin + secret.endpoint}
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <label className="lead-secret">
                {secret.deliveryMode === "tilda"
                  ? "API Key для Tilda"
                  : "Ключ доставки"}
                <input
                  readOnly
                  value={
                    secret.deliveryMode === "tilda"
                      ? `Bearer ${secret.token}`
                      : secret.token
                  }
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <button
                className="button secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      secret.deliveryMode === "tilda"
                        ? `Bearer ${secret.token}`
                        : secret.token,
                    );
                    setCopied(true);
                  } catch {
                    setSourceError("Выделите ключ и скопируйте его вручную.");
                  }
                }}
              >
                <Copy size={16} />
                {copied ? "Скопировано" : "Скопировать ключ"}
              </button>
              <p className="muted small">
                {secret.deliveryMode === "tilda"
                  ? "В Tilda: Настройки сайта → Формы → Webhook. API Method — HEADER, API Name — Authorization, API Key — значение выше целиком, включая Bearer. Сохраните, назначьте Webhook всем формам и опубликуйте страницы."
                  : "Сайт считается подключённым после первого отчёта агента доставки. Одного создания ключа недостаточно."}
              </p>
            </>
          ) : (
            <>
              {connectSite === "new" ? (
                <div className="lead-edit">
                  <label>
                    Название сайта
                    <input
                      value={sourceName}
                      maxLength={120}
                      onChange={(e) => setSourceName(e.target.value)}
                      placeholder="Название проекта"
                    />
                  </label>
                  <label>
                    Домен
                    <input
                      value={host}
                      maxLength={253}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="example.ru"
                    />
                  </label>
                  <label>
                    Способ подключения
                    <select
                      value={deliveryMode}
                      onChange={(e) =>
                        setDeliveryMode(e.target.value as DeliveryMode)
                      }
                    >
                      <option value="agent">Агент на сервере сайта</option>
                      <option value="tilda">Tilda — Webhook</option>
                    </select>
                  </label>
                </div>
              ) : (
                <>
                  <p className="muted">{connectSite.host}</p>
                  <p>
                    {connectSite.deliveryMode === "tilda"
                      ? "Ключ указывается в настройках Webhook в Tilda: API Method — HEADER, API Name — Authorization. В API Key вставьте Bearer и ключ через пробел."
                      : "Ключ нужен серверу сайта для безопасной передачи заявок. Он не должен попадать в код публичной формы."}
                  </p>
                  {connectSite.configured && (
                    <Notice>
                      Новый ключ заменит текущий. После этого обновите ключ{" "}
                      {connectSite.deliveryMode === "tilda"
                        ? "в настройках Webhook в Tilda."
                        : "в агенте на сервере сайта."}
                    </Notice>
                  )}
                  {connectSite.deliveryMode === "tilda" && (
                    <>
                      <p className="small muted">
                        {connectSite.webhookVerifiedAt
                          ? `Приём Webhook подтверждён: ${dateTime(connectSite.webhookVerifiedAt, true)} · МСК.`
                          : "Tilda ещё не подтвердила подключение Webhook."}
                        <br />
                        {connectSite.lastReceivedAt
                          ? `Последняя заявка: ${dateTime(connectSite.lastReceivedAt, true)} · МСК.`
                          : "Заявки через Webhook пока не поступали."}
                      </p>
                      <p className="small muted">
                        Проверьте отправку из каждой формы после публикации.
                        Состояние Webhook не проверяет назначение приёмщика всем
                        формам. Ошибки отправки доступны в разделе «Заявки» в
                        Tilda.
                      </p>
                      {connectSite.webhookError && (
                        <Notice tone="error">{connectSite.webhookError}</Notice>
                      )}
                    </>
                  )}
                  {connectSite.lastHeartbeatAt && (
                    <p className="small muted">
                      Последний сигнал:{" "}
                      {dateTime(connectSite.lastHeartbeatAt, true)} · МСК
                      <br />В очереди: {connectSite.pending}. Ошибок доставки:{" "}
                      {connectSite.rejected}.
                    </p>
                  )}
                </>
              )}
              <button
                className="button primary"
                disabled={
                  sourceBusy ||
                  (connectSite === "new" &&
                    (!sourceName.trim() || !host.trim()))
                }
                onClick={() => void connect()}
              >
                {sourceBusy
                  ? "Создаём…"
                  : connectSite === "new"
                    ? "Добавить сайт и создать ключ"
                    : connectSite.configured
                      ? "Создать новый ключ"
                      : "Создать ключ подключения"}
              </button>
            </>
          )}
        </dialog>
      )}
    </>
  );
}
