import { useEffect, useId, useRef, useState } from "react";
import {
  CreditCard,
  RotateCcw,
  Search,
  Sparkles,
  UsersRound,
  Wallet,
  X,
} from "lucide-react";
import { api, dateTime, errorText, number } from "../../api";
import { Empty, Loading, Notice, TitleDot } from "../../components/Common";
import { initials } from "../../identity";
import { GENERATION_STATUSES } from "../../../shared/docs-commerce.js";
import "./docs-commerce.css";
type Kind = "generations" | "topups";
type Buyer = {
  id: string;
  externalId: string | null;
  name: string;
  email: string;
  phone: string;
  customerId: string | null;
  customerInTrash: boolean;
};
type Summary = {
  count: number;
  amountMinor: number;
  refundedCount: number;
  refundedAmountMinor: number;
  buyers: number;
  guestOrders: number;
  generatedCount: number;
};
type Paging = { page: number; pages: number; total: number };
type Report = Paging & {
  kind: Kind;
  summary: Summary;
  connection: {
    status: string;
    lastHeartbeatAt: string | null;
    sourceCount: number;
    storedCount: number;
    pending: number;
  };
  buyers: (Buyer & {
    operationCount: number;
    amountMinor: number;
    refundedAmountMinor: number;
    lastAt: string;
  })[];
};
type Detail = Paging & {
  buyer: Buyer;
  summary: Summary;
  operations: {
    id: string;
    title: string;
    amountMinor: number;
    occurredAt: string;
    refund: boolean;
    status: string;
    generatedAt: string | null;
  }[];
  documents: { title: string; count: number; amountMinor: number }[];
  groupsPage: number;
  groupPages: number;
  groupCount: number;
};
const money = (n: number) =>
  new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: n % 100 ? 2 : 0,
  }).format(n / 100);
const periods = [
  ["total", "Всё время"],
  ["today", "Сегодня"],
  ["7d", "7 дней"],
  ["30d", "30 дней"],
  ["90d", "90 дней"],
];
const statusLabels: Record<string, string> = {
  unconfigured: "Ожидает подключения",
  waiting: "Ожидает первого запуска",
  online: "Данные синхронизированы",
  syncing: "Загружаем операции",
  offline: "Нет связи с источником",
  attention: "Нужна проверка доставки",
};
function useCommerceData<T>(url: string, active: boolean, revision: number) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    setError("");
    if (!active) return;
    let disposed = false,
      sequence = 0,
      controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const n = ++sequence;
      try {
        const result = await api<T>(url, { signal: controller.signal });
        if (!disposed && n === sequence) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (!disposed && n === sequence) setError(errorText(e));
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 30000);
    const visible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [url, active, revision]);
  return { data, error };
}
function Contacts({ buyer }: { buyer: Buyer }) {
  return (
    <div className="dc-contact-links">
      {buyer.phone && (
        <a href={"tel:" + buyer.phone.replace(/[^+\d]/g, "")}>{buyer.phone}</a>
      )}
      {buyer.email && (
        <a href={"mailto:" + encodeURIComponent(buyer.email)}>{buyer.email}</a>
      )}
      <small>
        {buyer.externalId
          ? "ID " + buyer.externalId
          : "Без привязки к аккаунту"}
      </small>
    </div>
  );
}
function Pager({
  page,
  pages,
  onChange,
  label,
}: {
  page: number;
  pages: number;
  onChange: (n: number) => void;
  label: string;
}) {
  return (
    <footer className="dc-pagination">
      <span>{label}</span>
      <div>
        <button
          className="button"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          Назад
        </button>
        <span aria-live="polite">
          {page} / {pages}
        </span>
        <button
          className="button"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
        >
          Далее
        </button>
      </div>
    </footer>
  );
}
export default function DocsCommerce({
  kind,
  active,
  refreshKey,
  onOpenCustomer,
}: {
  kind: Kind;
  active: boolean;
  refreshKey: number;
  onOpenCustomer: (id: string) => void;
}) {
  const generation = kind === "generations",
    heading = generation ? "Продажи генераций" : "Пополнения счёта";
  const [period, setPeriod] = useState("total"),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [sort, setSort] = useState("recent"),
    [page, setPage] = useState(1),
    [buyer, setBuyer] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!active) setBuyer(null);
  }, [active]);
  const { data, error } = useCommerceData<Report>(
    "/docs-commerce/report?" +
      new URLSearchParams({
        kind,
        period,
        q: search,
        sort,
        page: String(page),
      }),
    active,
    refreshKey,
  );
  const ready =
    data &&
    (!["unconfigured", "waiting"].includes(data.connection.status) ||
      data.connection.storedCount > 0);
  const s = data?.summary;
  return (
    <div className="ds-page dcom-page">
      <div className="ds-heading">
        <div>
          <h2>
            {heading}
            <TitleDot />
          </h2>
          <p>
            {generation
              ? "Кто заказывал инструкции, какие именно и сколько раз."
              : "Кто, когда и на какую сумму пополнил счёт BoykovDocs."}
          </p>
        </div>
        <div className="dc-tabs ds-periods" aria-label={"Период: " + heading}>
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
        !error && <Loading />
      ) : (
        <>
          <div className="dc-metrics ds-metrics">
            {[
              [
                generation ? "Куплено генераций" : "Пополнений",
                number(s!.count),
                generation ? Sparkles : CreditCard,
                "lime",
              ],
              [
                generation ? "Сумма покупок" : "Зачислено на счёт",
                money(s!.amountMinor),
                Wallet,
                "pink",
              ],
              [
                generation ? "Покупатели" : "Пользователи",
                number(s!.buyers),
                UsersRound,
                "",
              ],
              ["Возвращено", money(s!.refundedAmountMinor), RotateCcw, ""],
            ].map(([label, value, Icon, tone]) => {
              const Glyph = Icon as typeof Wallet;
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
              {statusLabels[data.connection.status]}
            </span>
            <span>Итоги за период · Москва</span>
            {data.connection.lastHeartbeatAt && (
              <span>Сверено {dateTime(data.connection.lastHeartbeatAt)}</span>
            )}
            {data.connection.pending > 0 && (
              <span>В очереди: {number(data.connection.pending)}</span>
            )}
          </div>
          {["unconfigured", "waiting"].includes(data.connection.status) && (
            <Notice>
              Источник операций ещё не подключён. После обновления коннектора
              BoykovDocs здесь появятся подтверждённые покупки и пополнения.
            </Notice>
          )}
          {["attention", "offline"].includes(data.connection.status) && (
            <Notice tone="error">
              Полнота данных пока не подтверждена. Получено операций:{" "}
              {number(data.connection.storedCount)}, в источнике при последней
              проверке: {number(data.connection.sourceCount)}. Проверьте
              доставку с BoykovDocs.
            </Notice>
          )}
          <p className="ds-definition">
            {generation
              ? "Один оплаченный заказ — одна покупка генерации. Повторное скачивание не увеличивает продажи."
              : "Показаны подтверждённые зачисления. Покупки инструкций со счёта отражаются в «Продажах инструкций»."}{" "}
            После возвратов за период:{" "}
            <strong>
              {ready ? money(s!.amountMinor - s!.refundedAmountMinor) : "—"}
            </strong>
            .{" "}
            {generation && s!.guestOrders > 0 && (
              <>
                Гостевых заказов: {number(s!.guestOrders)} — они не включены в
                число покупателей с аккаунтом.
              </>
            )}
          </p>
          <section
            className="dc-directory ds-buyers"
            aria-label={
              generation
                ? "Покупатели генераций"
                : "Пополнения по пользователям"
            }
          >
            <div className="ds-buyers-heading">
              <h3>
                {generation ? "Кто и сколько купил" : "Кто и сколько пополнил"}
              </h3>
              <span>Записей: {number(data.total)}</span>
            </div>
            <div className="dc-toolbar">
              <label className="dc-search">
                <Search size={19} />
                <input
                  aria-label={"Поиск: " + heading}
                  placeholder="Имя, телефон, почта или ID"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  maxLength={300}
                />
              </label>
              <label className="dc-sort">
                Порядок
                <select
                  aria-label={"Сортировка: " + heading}
                  value={sort}
                  onChange={(e) => {
                    setSort(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="recent">Последние операции</option>
                  <option value="count">
                    Больше {generation ? "покупок" : "пополнений"}
                  </option>
                  <option value="amount">Больше сумма</option>
                </select>
              </label>
            </div>
            {!data.buyers.length ? (
              <Empty
                title={
                  search
                    ? "Пользователи не найдены"
                    : "Операций за этот период нет"
                }
                text={
                  search
                    ? "Попробуйте изменить поиск."
                    : "Выберите другой период или дождитесь синхронизации."
                }
              />
            ) : (
              <div className="dcom-table-scroll">
                <table className="dcom-table">
                  <thead>
                    <tr>
                      <th>Пользователь</th>
                      <th>{generation ? "Покупки" : "Пополнения"}</th>
                      <th>{generation ? "Сумма покупок" : "Зачислено"}</th>
                      <th>Последняя операция</th>
                      <th>
                        <span className="dcom-sr-only">История</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.buyers.map((b) => (
                      <tr key={b.id}>
                        <td>
                          <div className="dc-user-cell">
                            <span className="dc-avatar">
                              {initials(b.name || "Клиент")}
                            </span>
                            <div>
                              <button
                                className="dc-name"
                                onClick={() => setBuyer(b.id)}
                              >
                                {b.name || b.email || "Пользователь без имени"}
                              </button>
                              <Contacts buyer={b} />
                            </div>
                          </div>
                        </td>
                        <td>
                          <strong className="dcom-count">
                            {number(b.operationCount)}
                          </strong>
                        </td>
                        <td>
                          <strong className="ds-amount">
                            {money(b.amountMinor)}
                          </strong>
                          {b.refundedAmountMinor > 0 && (
                            <small className="dcom-refund-note">
                              Возврат {money(b.refundedAmountMinor)}
                            </small>
                          )}
                        </td>
                        <td className="ds-date">{dateTime(b.lastAt, true)}</td>
                        <td>
                          <button
                            className="button"
                            onClick={() => setBuyer(b.id)}
                            aria-label={
                              "История: " + (b.name || b.email || b.id)
                            }
                          >
                            История
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pager
              page={data.page}
              pages={data.pages}
              onChange={setPage}
              label="Пользователи за выбранный период"
            />
          </section>
        </>
      )}
      {active && buyer && (
        <CommerceDialog
          key={buyer + period}
          kind={kind}
          id={buyer}
          period={period}
          revision={refreshKey}
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
function CommerceDialog({
  kind,
  id,
  period,
  revision,
  onClose,
  onOpenCustomer,
}: {
  kind: Kind;
  id: string;
  period: string;
  revision: number;
  onClose: () => void;
  onOpenCustomer: (id: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    titleId = useId(),
    [page, setPage] = useState(1),
    [groupsPage, setGroupsPage] = useState(1),
    generation = kind === "generations";
  const { data, error } = useCommerceData<Detail>(
    "/docs-commerce/buyers/" +
      encodeURIComponent(id) +
      "?" +
      new URLSearchParams({
        kind,
        period,
        page: String(page),
        groupsPage: String(groupsPage),
      }),
    true,
    revision,
  );
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className="dc-dialog ds-dialog dcom-dialog"
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dc-dialog-header">
        <div>
          <span className="eyebrow">
            BOYKOVDOCS · {generation ? "ГЕНЕРАЦИИ" : "ПОПОЛНЕНИЯ"}
          </span>
          <h2 id={titleId}>
            {data?.buyer.name || data?.buyer.email || "История пользователя"}
            <TitleDot />
          </h2>
          <span className="dc-muted">
            {periods.find((p) => p[0] === period)?.[1]} · время Москвы
          </span>
        </div>
        <button
          className="icon-button"
          aria-label="Закрыть историю"
          onClick={onClose}
        >
          <X size={22} />
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!data ? (
        !error && <Loading />
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
              <span>{generation ? "Куплено генераций" : "Пополнений"}</span>
              <strong>{number(data.summary.count)}</strong>
            </div>
            <div>
              <span>{generation ? "Сумма покупок" : "Зачислено"}</span>
              <strong>{money(data.summary.amountMinor)}</strong>
            </div>
            <div>
              <span>Возвращено за период</span>
              <strong>{money(data.summary.refundedAmountMinor)}</strong>
            </div>
          </div>
          {generation && data.documents.length > 0 && (
            <section
              className="dcom-documents"
              aria-label="Что генерировал пользователь"
            >
              <div className="ds-history-heading">
                <h3>Что заказывал</h3>
                <span>Количество покупок</span>
              </div>
              <div className="ds-top">
                {data.documents.map((d) => (
                  <div key={d.title}>
                    <span>{d.title}</span>
                    <strong>{number(d.count)} ×</strong>
                    <small>{money(d.amountMinor)}</small>
                  </div>
                ))}
              </div>
              {data.groupPages > 1 && (
                <Pager
                  page={data.groupsPage}
                  pages={data.groupPages}
                  onChange={setGroupsPage}
                  label={"Документов: " + number(data.groupCount)}
                />
              )}
            </section>
          )}
          <div className="ds-history-heading">
            <h3>История операций</h3>
            <span>Сначала новые</span>
          </div>
          {data.operations.length ? (
            <div className="dcom-history">
              {data.operations.map((o) => (
                <article key={o.id + String(o.refund)}>
                  <div>
                    <strong>{o.title}</strong>
                    <small>
                      {dateTime(o.occurredAt, true)} ·{" "}
                      {generation ? "Заказ" : "Операция"} {o.id}
                    </small>
                    {generation && !o.refund && o.generatedAt && (
                      <small>
                        Документ создан {dateTime(o.generatedAt, true)}
                      </small>
                    )}
                  </div>
                  <span
                    className={
                      "dcom-status " +
                      (o.refund
                        ? "refunded"
                        : generation
                          ? o.status
                          : "confirmed")
                    }
                  >
                    {o.refund
                      ? "Возврат"
                      : generation
                        ? GENERATION_STATUSES[o.status] || o.status
                        : "Зачислено"}
                  </span>
                  <strong
                    className={
                      "dcom-operation-amount" + (o.refund ? " refunded" : "")
                    }
                  >
                    {o.refund ? "−" : ""}
                    {money(o.amountMinor)}
                  </strong>
                </article>
              ))}
            </div>
          ) : (
            <Empty
              title="Операций за этот период нет"
              text="Выберите другой период в списке пользователей."
            />
          )}
          <Pager
            page={data.page}
            pages={data.pages}
            onChange={setPage}
            label={"Операций: " + number(data.total)}
          />
        </>
      )}
    </dialog>
  );
}
