import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  FileText,
  Search,
  ShoppingBag,
  UsersRound,
  X,
} from "lucide-react";
import { api, dateTime, errorText, number } from "../api";
import { Empty, Loading, Notice, TitleDot } from "../components/Common";
import { initials } from "../identity";
import "./DocsSales.css";
type Totals = {
  count: number;
  amountMinor: number;
  buyers: number;
  instructions: number;
  pdf: number;
  docx: number;
  firstPurchaseAt: string | null;
  lastPurchaseAt: string | null;
};
type Buyer = {
  id: string;
  name: string;
  email: string;
  phone: string;
  registeredAt: string | null;
  customerId: string | null;
  customerInTrash: boolean;
};
type BuyerRow = Buyer & {
  purchaseCount: number;
  uniqueInstructions: number;
  amountMinor: number;
  lastPurchaseAt: string;
  pdf: number;
  docx: number;
};
type ChartItem = { key: string; count: number; amountMinor: number };
type Report = {
  range: {
    period: string;
    start: string | null;
    end: string;
    timeZone: string;
  };
  summary: Totals;
  format: string;
  connection: {
    status: string;
    lastHeartbeatAt: string | null;
    lastReceivedAt: string | null;
    sourceCount: number;
    storedCount: number;
    pending: number;
    rejected: number;
    errorCode: string;
  };
  chart: { unit: string; items: ChartItem[] };
  topInstructions: {
    id: string;
    title: string;
    count: number;
    amountMinor: number;
  }[];
  buyers: BuyerRow[];
  page: number;
  pages: number;
  total: number;
};
type BuyerDetail = {
  buyer: Buyer;
  range: Report["range"];
  format: string;
  summary: Totals;
  lifetime: Totals;
  purchases: {
    id: string;
    instructionId: string;
    title: string;
    format: string;
    amountMinor: number;
    createdAt: string;
  }[];
  page: number;
  pages: number;
  total: number;
};
const money = (n: number) =>
  new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: n % 100 ? 2 : 0,
  }).format(n / 100);
const counted = (n: number, forms: [string, string, string]) => {
  const hundred = n % 100,
    ten = n % 10;
  return (
    number(n) +
    " " +
    forms[
      hundred >= 11 && hundred <= 14
        ? 2
        : ten === 1
          ? 0
          : ten >= 2 && ten <= 4
            ? 1
            : 2
    ]
  );
};
const periods = [
  ["total", "Всё время"],
  ["today", "Сегодня"],
  ["7d", "7 дней"],
  ["30d", "30 дней"],
  ["90d", "90 дней"],
];
const periodName = (v: string) =>
  periods.find((p) => p[0] === v)?.[1] || "Всё время";
const statuses: Record<string, string> = {
  unconfigured: "Ожидает подключения",
  waiting: "Ожидает первого запуска",
  online: "Продажи синхронизированы",
  syncing: "Загружаем историю продаж",
  offline: "Нет связи с источником",
  attention: "Нужна проверка продаж",
};
function Contacts({ buyer }: { buyer: Buyer }) {
  return (
    <div className="dc-contact-links">
      {buyer.phone && (
        <a href={"tel:" + buyer.phone.replace(/[^+\d]/g, "")}>{buyer.phone}</a>
      )}
      {buyer.email && (
        <a href={"mailto:" + encodeURIComponent(buyer.email)}>{buyer.email}</a>
      )}
      <small>ID {buyer.id}</small>
    </div>
  );
}
function SalesChart({ chart }: { chart: Report["chart"] }) {
  const [selected, setSelected] = useState<string | null>(null),
    items = chart.items,
    max = Math.max(1, ...items.map((i) => i.count)),
    cell = 720 / Math.max(1, items.length),
    bar = Math.min(48, cell * 0.65),
    current = items.find((i) => i.key === selected) || items.at(-1);
  const label = (key: string) =>
    key.length === 7
      ? key.slice(5) + "." + key.slice(0, 4)
      : key.slice(8) + "." + key.slice(5, 7);
  return (
    <section className="ds-panel">
      <div className="ds-panel-head">
        <h3>Динамика продаж</h3>
        <span>{chart.unit === "month" ? "По месяцам" : "По дням"}</span>
      </div>
      {!items.length ? (
        <p className="ds-muted">График появится после синхронизации покупок.</p>
      ) : (
        <>
          <svg
            className="ds-chart"
            viewBox="0 0 800 205"
            role="img"
            aria-label="Количество покупок по датам"
          >
            <line x1="44" x2="764" y1="26" y2="26" className="ds-chart-grid" />
            <line
              x1="44"
              x2="764"
              y1="161"
              y2="161"
              className="ds-chart-grid"
            />
            <text x="7" y="30">
              {number(max)}
            </text>
            <text x="14" y="164">
              0
            </text>
            {items.map((i, n) => {
              const h = (i.count / max) * 135,
                x = 44 + n * cell + (cell - bar) / 2;
              return (
                <g
                  key={i.key}
                  tabIndex={0}
                  role="img"
                  aria-label={`${i.key}: покупок ${i.count}, ${money(i.amountMinor)}`}
                  onMouseEnter={() => setSelected(i.key)}
                  onFocus={() => setSelected(i.key)}
                >
                  <title>
                    {i.key}: {i.count} · {money(i.amountMinor)}
                  </title>
                  <rect
                    x={44 + n * cell}
                    y="21"
                    width={cell}
                    height="145"
                    className="ds-chart-hit"
                  />
                  <rect
                    x={x}
                    y={161 - h}
                    width={bar}
                    height={Math.max(h, 1)}
                    rx="3"
                    className={
                      "ds-chart-bar" +
                      (current?.key === i.key ? " selected" : "")
                    }
                  />
                </g>
              );
            })}
            {[
              ...new Set([
                0,
                Math.floor((items.length - 1) / 2),
                items.length - 1,
              ]),
            ].map((n) => (
              <text
                key={n}
                x={44 + n * cell + cell / 2}
                y="188"
                textAnchor="middle"
              >
                {label(items[n].key)}
              </text>
            ))}
          </svg>
          {current && (
            <div className="ds-chart-caption">
              <span>{current.key}</span>
              <strong>
                {counted(current.count, ["покупка", "покупки", "покупок"])}
              </strong>
              <span>{money(current.amountMinor)}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
export default function DocsSales({
  active,
  refreshKey,
  onOpenCustomer,
}: {
  active: boolean;
  refreshKey: number;
  onOpenCustomer: (id: string) => void;
}) {
  const [data, setData] = useState<Report | null>(null),
    [error, setError] = useState(""),
    [period, setPeriod] = useState("total"),
    [format, setFormat] = useState("all"),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [sort, setSort] = useState("purchases"),
    [page, setPage] = useState(1),
    [buyer, setBuyer] = useState<string | null>(null);
  const generation = useRef(0);
  // A failed filter request must not present the previous period as the new report.
  useEffect(() => {
    setData(null);
  }, [period, format, search, sort, page]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const refresh = useCallback(async () => {
    const n = ++generation.current;
    try {
      const params = new URLSearchParams({
          period,
          format,
          q: search,
          sort,
          page: String(page),
        }),
        r = await api<Report>("/docs-sales/report?" + params);
      if (n === generation.current) {
        setData(r);
        setError("");
      }
    } catch (e) {
      if (n === generation.current) setError(errorText(e));
    }
  }, [period, format, search, sort, page]);
  useEffect(() => {
    if (!active) {
      setBuyer(null);
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [active, refresh, refreshKey]);
  const ready =
    data &&
    (!["unconfigured", "waiting"].includes(data.connection.status) ||
      data.summary.count > 0);
  return (
    <div className="ds-page">
      <div className="ds-heading">
        <div>
          <h2>
            Продажи инструкций
            <TitleDot />
          </h2>
          <p>Покупки PDF и Word с привязкой к пользователю BoykovDocs.</p>
        </div>
        <div className="dc-tabs ds-periods" aria-label="Период продаж">
          {periods.map(([key, label]) => (
            <button
              key={key}
              aria-pressed={period === key}
              className={period === key ? "selected" : ""}
              onClick={() => {
                setPeriod(key);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="dc-metrics ds-metrics">
            {[
              [
                "Куплено инструкций",
                number(data.summary.count),
                ShoppingBag,
                "lime",
              ],
              [
                "Сумма покупок",
                money(data.summary.amountMinor),
                BookOpen,
                "pink",
              ],
              ["Покупатели", number(data.summary.buyers), UsersRound, ""],
              [
                "Уникальные инструкции",
                number(data.summary.instructions),
                FileText,
                "",
              ],
            ].map(([label, value, Icon, tone]) => {
              const Glyph = Icon as typeof ShoppingBag;
              return (
                <div
                  className={"dc-metric ds-metric " + tone}
                  key={String(label)}
                >
                  <span>
                    {String(label)}
                    <Glyph size={19} />
                  </span>
                  <strong>{ready ? String(value) : "—"}</strong>
                  <div className="dc-metric-decoration" aria-hidden="true" />
                </div>
              );
            })}
          </div>
          <div className="dc-connection ds-connection">
            <span className={"dc-health " + data.connection.status}>
              <i />
              {statuses[data.connection.status]}
            </span>
            <span>{periodName(period)} · Москва</span>
            {data.connection.lastHeartbeatAt && (
              <span>Сверено {dateTime(data.connection.lastHeartbeatAt)}</span>
            )}
            {data.connection.pending > 0 && (
              <span>В очереди: {number(data.connection.pending)}</span>
            )}
          </div>
          {["unconfigured", "waiting"].includes(data.connection.status) && (
            <Notice>
              Продажи ещё не синхронизированы. Администратор может подключить
              источник на сервере BoykovDocs.
            </Notice>
          )}
          {["attention", "offline"].includes(data.connection.status) && (
            <Notice tone="error">
              Нет подтверждения полноты статистики продаж. Проверьте доставку на
              сервере BoykovDocs. Получено покупок:{" "}
              {number(data.connection.storedCount)}, в источнике при последней
              проверке: {number(data.connection.sourceCount)}.
            </Notice>
          )}
          <p className="ds-definition">
            PDF и Word считаются отдельными покупками. Повторные скачивания не
            увеличивают продажи. Показатели за выбранный период: PDF —{" "}
            {number(data.summary.pdf)}, Word — {number(data.summary.docx)}.
          </p>
          <div className="ds-overview">
            <SalesChart chart={data.chart} />
            <section className="ds-panel">
              <div className="ds-panel-head">
                <h3>Популярные инструкции</h3>
                <span>По покупкам</span>
              </div>
              {!data.topInstructions.length ? (
                <p className="ds-muted">Покупок за этот период пока нет.</p>
              ) : (
                <div className="ds-top">
                  {data.topInstructions.map((i) => (
                    <div key={i.id}>
                      <span title={i.title}>{i.title}</span>
                      <strong>{number(i.count)}</strong>
                      <small>{money(i.amountMinor)}</small>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
          <section
            className="dc-directory ds-buyers"
            aria-label="Покупатели инструкций"
          >
            <div className="ds-buyers-heading">
              <h3>Кто и сколько купил</h3>
              <span>
                {counted(data.total, [
                  "покупатель",
                  "покупателя",
                  "покупателей",
                ])}
              </span>
            </div>
            <div className="dc-toolbar">
              <label className="dc-search">
                <Search size={19} />
                <input
                  aria-label="Поиск покупателей"
                  placeholder="Имя, телефон, почта или ID"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  maxLength={300}
                />
              </label>
              <label className="dc-sort">
                Формат
                <select
                  aria-label="Формат покупок"
                  value={format}
                  onChange={(e) => {
                    setFormat(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="all">Все форматы</option>
                  <option value="pdf">PDF</option>
                  <option value="docx">Word</option>
                </select>
              </label>
              <label className="dc-sort">
                Порядок
                <select
                  aria-label="Сортировка покупателей"
                  value={sort}
                  onChange={(e) => {
                    setSort(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="purchases">Больше покупок</option>
                  <option value="amount">Больше сумма</option>
                  <option value="recent">Последние покупки</option>
                </select>
              </label>
            </div>
            {!data.buyers.length ? (
              <Empty
                title={
                  search
                    ? "Покупатели не найдены"
                    : "Покупок за этот период нет"
                }
                text={
                  search
                    ? "Попробуйте изменить поиск."
                    : "Выберите другой период или дождитесь синхронизации."
                }
              />
            ) : (
              <>
                <div className="ds-buyer-head">
                  <span>Пользователь</span>
                  <span>Покупки</span>
                  <span>Сумма</span>
                  <span>Последняя покупка</span>
                  <span />
                </div>
                {data.buyers.map((b) => (
                  <article className="ds-buyer-row" key={b.id}>
                    <div className="dc-user-cell">
                      <span className="dc-avatar">{initials(b.name)}</span>
                      <div>
                        <button
                          className="dc-name"
                          onClick={() => setBuyer(b.id)}
                        >
                          {b.name || "Пользователь без имени"}
                        </button>
                        <Contacts buyer={b} />
                      </div>
                    </div>
                    <div className="ds-count">
                      <strong>{number(b.purchaseCount)}</strong>
                      <span>
                        {counted(b.uniqueInstructions, [
                          "уникальная",
                          "уникальные",
                          "уникальных",
                        ])}
                      </span>
                      <small>
                        PDF {number(b.pdf)} · Word {number(b.docx)}
                      </small>
                    </div>
                    <strong className="ds-amount">
                      {money(b.amountMinor)}
                    </strong>
                    <span className="ds-date">
                      {dateTime(b.lastPurchaseAt, true)}
                    </span>
                    <button className="button" onClick={() => setBuyer(b.id)}>
                      Покупки
                    </button>
                  </article>
                ))}
              </>
            )}
            <footer className="dc-pagination">
              <span>Покупатели за выбранный период</span>
              <div>
                <button
                  className="button"
                  disabled={data.page <= 1}
                  onClick={() => setPage(data.page - 1)}
                >
                  Назад
                </button>
                <span>
                  {data.page} / {data.pages}
                </span>
                <button
                  className="button"
                  disabled={data.page >= data.pages}
                  onClick={() => setPage(data.page + 1)}
                >
                  Далее
                </button>
              </div>
            </footer>
          </section>
        </>
      )}
      {buyer && (
        <PurchaseDialog
          key={buyer + period + format}
          id={buyer}
          period={period}
          format={format}
          onClose={() => setBuyer(null)}
          onOpenCustomer={(id) => {
            setBuyer(null);
            onOpenCustomer(id);
          }}
        />
      )}
    </div>
  );
}
function PurchaseDialog({
  id,
  period,
  format,
  onClose,
  onOpenCustomer,
}: {
  id: string;
  period: string;
  format: string;
  onClose: () => void;
  onOpenCustomer: (id: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    [data, setData] = useState<BuyerDetail | null>(null),
    [page, setPage] = useState(1),
    [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  useEffect(() => {
    let disposed = false;
    void api<BuyerDetail>(
      "/docs-sales/buyers/" +
        encodeURIComponent(id) +
        "?" +
        new URLSearchParams({ period, format, page: String(page) }),
    )
      .then((r) => {
        if (!disposed) {
          setData(r);
          setError("");
        }
      })
      .catch((e) => {
        if (!disposed) setError(errorText(e));
      });
    return () => {
      disposed = true;
    };
  }, [id, period, format, page]);
  return (
    <dialog
      className="dc-dialog ds-dialog"
      ref={ref}
      aria-labelledby="ds-buyer-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dc-dialog-header">
        <div>
          <span className="eyebrow">BOYKOVDOCS · ПОКУПКИ ПОЛЬЗОВАТЕЛЯ</span>
          <h2 id="ds-buyer-title">{data?.buyer.name || "Покупатель"}</h2>
          <span className="dc-muted">ID пользователя: {id}</span>
        </div>
        <button
          className="icon-button"
          aria-label="Закрыть покупки"
          onClick={onClose}
        >
          <X size={22} />
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="ds-buyer-contact">
            <Contacts buyer={data.buyer} />
            {data.buyer.customerId && (
              <button
                className="button"
                onClick={() => onOpenCustomer(data.buyer.customerId!)}
              >
                Карточка клиента
              </button>
            )}
            {data.buyer.customerInTrash && (
              <span className="dc-muted">Карточка клиента в корзине</span>
            )}
          </div>
          <div className="ds-buyer-totals">
            <div>
              <span>{periodName(period)} · покупок</span>
              <strong>{number(data.summary.count)}</strong>
            </div>
            <div>
              <span>Сумма за период</span>
              <strong>{money(data.summary.amountMinor)}</strong>
            </div>
            <div>
              <span>Всего куплено за всё время</span>
              <strong>{number(data.lifetime.count)}</strong>
            </div>
          </div>
          <div className="ds-history-heading">
            <h3>Приобретённые инструкции</h3>
            <span>
              {format === "all"
                ? "Все форматы"
                : format === "pdf"
                  ? "PDF"
                  : "Word"}{" "}
              · время Москвы
            </span>
          </div>
          {data.purchases.length ? (
            <div className="ds-purchase-list">
              {data.purchases.map((p) => (
                <article key={p.id}>
                  <div>
                    <strong>{p.title}</strong>
                    <small>
                      {dateTime(p.createdAt, true)} · ID покупки {p.id}
                    </small>
                  </div>
                  <span className={"ds-format " + p.format}>
                    {p.format === "docx" ? "Word" : "PDF"}
                  </span>
                  <strong>{money(p.amountMinor)}</strong>
                </article>
              ))}
            </div>
          ) : (
            <Empty
              title="Покупок за этот период нет"
              text="Другие покупки пользователя сохраняются в общей статистике."
            />
          )}
          <footer className="dc-pagination">
            <span>Покупок: {number(data.total)}</span>
            <div>
              <button
                className="button"
                disabled={data.page <= 1}
                onClick={() => setPage(data.page - 1)}
              >
                Назад
              </button>
              <span>
                {data.page} / {data.pages}
              </span>
              <button
                className="button"
                disabled={data.page >= data.pages}
                onClick={() => setPage(data.page + 1)}
              >
                Далее
              </button>
            </div>
          </footer>
        </>
      )}
    </dialog>
  );
}
