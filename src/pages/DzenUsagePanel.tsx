import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Coins,
  MessageCircle,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { api, dateTime, errorText, number } from "../api";
import { Empty, Loading, Notice, TitleDot } from "../components/Common";
import "./DzenUsagePanel.css";

type Period = "today" | "7" | "30" | "90" | "all";
type Request = {
  id: string;
  commentId: string | null;
  author: string;
  article: string;
  text: string;
  kind: "reply" | "preview";
  automatic: boolean;
  startedAt: string;
  outcome: string;
  model: string;
  modelVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  inputRub: number;
  outputRub: number;
  costRub: number | null;
};
type Report = {
  period: Period;
  page: number;
  pageSize: number;
  total: number;
  coverageFrom: string | null;
  requests: number;
  priced: number;
  unknown: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costRub: number;
  replyCostRub: number;
  previewCostRub: number;
  comments: number;
  averageRequestRub: number | null;
  averageCommentRub: number | null;
  daily: {
    day: string;
    costRub: number;
    requests: number;
    priced: number;
    tokens: number;
  }[];
  rows: Request[];
  model: string;
  inputRub: number;
  outputRub: number;
};
const periods: { key: Period; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7", label: "7 дней" },
  { key: "30", label: "30 дней" },
  { key: "90", label: "90 дней" },
  { key: "all", label: "Всё время" },
];
const outcomes: Record<string, string> = {
  reply: "Ответ",
  skip: "Пропущено",
  error: "Ошибка",
  pending: "В процессе",
  interrupted: "Прервано",
};
export const dzenRub = (value: number | null | undefined) =>
  value == null
    ? "—"
    : `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)} ₽`;
const shortDay = (day: string) => day.slice(8, 10) + "." + day.slice(5, 7);

export default function DzenUsagePanel({
  onSettings,
}: {
  onSettings: () => void;
}) {
  const [period, setPeriod] = useState<Period>("30");
  const [page, setPage] = useState(1);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(() => {
    let cancelled = false;
    setError("");
    api<Report>(
      "/dzen/usage?" + new URLSearchParams({ period, page: String(page) }),
    )
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [period, page, refresh]);
  useEffect(load, [load]);
  useEffect(() => {
    const timer = setInterval(() => setRefresh((v) => v + 1), 15000);
    return () => clearInterval(timer);
  }, []);
  const data =
    report?.period === period && report?.page === page ? report : null;
  const max = Math.max(
    0.0001,
    ...(data?.daily.map((row) => row.costRub) ?? []),
  );
  return (
    <div className="dz-usage">
      <div className="dz-work-head">
        <div>
          <span className="eyebrow">YANDEXGPT / РАСХОДЫ</span>
          <h2>
            Стоимость ответов
            <TitleDot />
          </h2>
          <p>Фактические токены и расчёт по тарифу на момент запроса.</p>
        </div>
        <div className="dz-usage-periods">
          {periods.map((p) => (
            <button
              key={p.key}
              type="button"
              className={period === p.key ? "active" : ""}
              aria-pressed={period === p.key}
              onClick={() => {
                setPeriod(p.key);
                setPage(1);
              }}
            >
              {p.label}
            </button>
          ))}
          <button
            className="icon-button"
            aria-label="Обновить расходы"
            onClick={() => setRefresh((v) => v + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="dz-metrics dz-usage-metrics">
            <div className="panel dz-metric">
              <span>
                Расход за период <Coins size={18} />
              </span>
              <strong>{data.priced ? dzenRub(data.costRub) : "—"}</strong>
              <small>{number(data.priced)} запросов с расчётом</small>
            </div>
            <div className="panel dz-metric">
              <span>
                На один комментарий <MessageCircle size={18} />
              </span>
              <strong>{dzenRub(data.averageCommentRub)}</strong>
              <small>{number(data.comments)} уникальных комментариев</small>
            </div>
            <div className="panel dz-metric">
              <span>
                На один запрос <Sparkles size={18} />
              </span>
              <strong>{dzenRub(data.averageRequestRub)}</strong>
              <small>Включая тесты промпта</small>
            </div>
            <div className="panel dz-metric">
              <span>
                Всего токенов <Sparkles size={18} />
              </span>
              <strong>{number(data.totalTokens)}</strong>
              <small>
                {number(data.inputTokens)} вход / {number(data.outputTokens)}{" "}
                выход
              </small>
            </div>
          </div>
          <div className="panel dz-usage-summary">
            <div>
              <span>Ответы на комментарии</span>
              <strong>{data.priced ? dzenRub(data.replyCostRub) : "—"}</strong>
            </div>
            <div>
              <span>Тесты промпта</span>
              <strong>
                {data.priced ? dzenRub(data.previewCostRub) : "—"}
              </strong>
            </div>
            <div>
              <span>Тариф за 1000 токенов</span>
              <strong>
                {dzenRub(data.inputRub)} / {dzenRub(data.outputRub)}
              </strong>
              <small>{data.model} · вход / выход</small>
            </div>
            <button className="text-button" onClick={onSettings}>
              Изменить тариф
            </button>
          </div>
          <Notice tone="info">
            {data.coverageFrom
              ? `Учёт с ${dateTime(data.coverageFrom, true)}. `
              : "Учёт начнётся с первого нового запроса. "}
            Расходы рассчитаны по возвращённым API токенам и сохранённому
            тарифу. Это не выписка биллинга Yandex Cloud.{" "}
            {data.unknown > 0
              ? `Запросов без данных о расходе: ${number(data.unknown)}. Их неизвестная стоимость не включена в итог.`
              : "Прошлые запросы до внедрения учёта не включены."}
          </Notice>
          <section className="panel dz-usage-daily">
            <div className="dz-usage-head">
              <h3>
                Динамика по дням
                <TitleDot />
              </h3>
              <span>Москва · до 90 последних дней</span>
            </div>
            {data.daily.length ? (
              <div className="dz-usage-bars">
                {data.daily.map((day) => (
                  <div className="dz-usage-bar" key={day.day}>
                    <span>{shortDay(day.day)}</span>
                    <progress max={max} value={day.costRub} />
                    <strong>{day.priced ? dzenRub(day.costRub) : "—"}</strong>
                    <small>{number(day.requests)} запр.</small>
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                title="Пока нет расходов"
                text="Они появятся после следующего запроса к YandexGPT."
              />
            )}
          </section>
          <section className="panel dz-usage-table">
            <div className="dz-usage-head">
              <h3>
                История запросов
                <TitleDot />
              </h3>
              <span>{number(data.total)} записей</span>
            </div>
            {data.rows.length ? (
              <div className="dz-usage-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Комментарий / запрос</th>
                      <th>Токены</th>
                      <th>Расход</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.id}>
                        <td>{dateTime(row.startedAt, true)}</td>
                        <td>
                          <strong>
                            {row.kind === "preview"
                              ? "Тест промпта"
                              : row.author || "Комментарий"}
                          </strong>
                          {row.article && <small>{row.article}</small>}
                          {row.text && (
                            <p>
                              {row.text.slice(0, 180)}
                              {row.text.length > 180 ? "…" : ""}
                            </p>
                          )}
                          <small>
                            {outcomes[row.outcome] || row.outcome} ·{" "}
                            {row.automatic ? "Авто" : "Вручную"}
                          </small>
                        </td>
                        <td>
                          <strong>
                            {row.totalTokens === null
                              ? "—"
                              : number(row.totalTokens)}
                          </strong>
                          <small>
                            {row.inputTokens === null
                              ? "Нет данных"
                              : `${number(row.inputTokens)} / ${number(row.outputTokens ?? 0)}`}
                          </small>
                        </td>
                        <td>
                          <strong>{dzenRub(row.costRub)}</strong>
                          <small>
                            Тариф: {dzenRub(row.inputRub)} /{" "}
                            {dzenRub(row.outputRub)}
                          </small>
                          <small>
                            {row.modelVersion
                              ? `Модель ${row.modelVersion}`
                              : row.model}
                          </small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title="История пуста"
                text="Все новые генерации и тесты будут учитываться здесь."
              />
            )}
            <div className="dz-list-footer">
              <button
                className="icon-button"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                aria-label="Предыдущая страница"
              >
                <ChevronLeft size={18} />
              </button>
              <span>
                {page} из {Math.max(1, Math.ceil(data.total / data.pageSize))}
              </span>
              <button
                className="icon-button"
                disabled={page >= Math.ceil(data.total / data.pageSize)}
                onClick={() => setPage((p) => p + 1)}
                aria-label="Следующая страница"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
