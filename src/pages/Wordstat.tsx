import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  FileUp,
  LoaderCircle,
  Play,
  Search,
  RotateCw,
} from "lucide-react";
import { api, post, errorText, dateTime, number } from "../api";
import { Empty, Notice, PageHead, Status } from "../components/Common";
import type { Batch, System } from "../types";
export default function Wordstat({
  system,
  selectedId,
  onChange,
}: {
  system: System | null;
  selectedId: string | null;
  onChange: () => void;
}) {
  const [queries, setQueries] = useState("");
  const [region, setRegion] = useState("225");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [viewLimit, setViewLimit] = useState(100);
  const [loaded, setLoaded] = useState(false);
  const phrases = [
    ...new Set(
      queries
        .split(/\r?\n/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  const active = batches.some((batch) =>
    ["running", "waiting", "exporting"].includes(batch.status),
  );
  const current = batches.find((batch) => batch.id === currentId);
  useEffect(() => {
    if (selectedId) setCurrentId(selectedId);
  }, [selectedId]);
  useEffect(() => {
    let stopped = false;
    async function refresh() {
      try {
        const data = await api<{ batches: Batch[] }>("/wordstat/batches");
        if (!stopped) {
          setBatches(data.batches);
          setCurrentId((id) => id || data.batches[0]?.id || null);
          setLoaded(true);
        }
      } catch (error) {
        if (!stopped) {
          setError(errorText(error));
          setLoaded(true);
        }
      }
    }
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  // Old completed runs outside the recent list remain addressable from the common history.
  useEffect(() => {
    if (
      !currentId ||
      !loaded ||
      batches.some((batch) => batch.id === currentId)
    )
      return;
    let stopped = false;
    api<Batch>(`/wordstat/batch/${currentId}`)
      .then((batch) => {
        if (!stopped) setBatches((items) => [...items, batch]);
      })
      .catch((error) => {
        if (!stopped) setError(errorText(error));
      });
    return () => {
      stopped = true;
    };
  }, [currentId, loaded, batches]);
  async function start(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const batch = await post<Batch>("/wordstat/batch/start", {
        queries: phrases,
        regionId: region,
      });
      setBatches((old) => [batch, ...old]);
      setCurrentId(batch.id);
      setFilter("");
      onChange();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function resume() {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      const batch = await post<Batch>(
        `/wordstat/batch/${current.id}/resume`,
        {},
      );
      setBatches((old) => old.map((b) => (b.id === batch.id ? batch : b)));
      onChange();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function importText(file?: File) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError("Текстовый файл должен быть не больше 2 МБ.");
      return;
    }
    setQueries((await file.text()).replace(/^\uFEFF/, ""));
    setError("");
  }
  const rows =
    current?.items.filter((item) =>
      item.phrase.toLowerCase().includes(filter.toLowerCase()),
    ) || [];
  return (
    <>
      <PageHead
        eyebrow="МАРКЕТИНГ / 02"
        title="Семантика из Wordstat"
        description="Популярные и похожие запросы, частотность и готовая Excel-выгрузка."
      />
      <div className="wordstat-layout">
        <section className="panel query-panel">
          <div className="form-heading">
            <span className="square-icon lime">
              <Search size={21} />
            </span>
            <div>
              <h2>Новый сбор</h2>
              <p>Одна фраза — одна строка</p>
            </div>
          </div>
          {!system?.wordstat.configured && (
            <Notice>
              Для сбора подключите Wordstat API в разделе «Подключения».
            </Notice>
          )}
          <form onSubmit={start}>
            <label>
              Поисковые запросы
              <textarea
                rows={10}
                maxLength={802000}
                value={queries}
                onChange={(e) => setQueries(e.target.value)}
                placeholder={
                  "паспорт безопасности\nохрана труда\nэлектролаборатория"
                }
                required
              />
            </label>
            <div className="query-meta">
              <span>{number(phrases.length)} / 2 000 фраз</span>
              <label className="text-button import-label">
                <FileUp size={15} />
                Загрузить TXT
                <input
                  type="file"
                  accept=".txt"
                  onChange={(e) => {
                    void importText(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <label>
              Регион
              <select
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              >
                <option value="all">Все регионы</option>
                <option value="225">Россия</option>
                <option value="213">Москва</option>
                <option value="2">Санкт-Петербург</option>
              </select>
            </label>
            {phrases.length > 2000 && (
              <Notice tone="error">
                За один сбор можно обработать до 2 000 исходных фраз.
              </Notice>
            )}
            <button
              className="button primary full-button"
              disabled={
                busy ||
                active ||
                !system?.wordstat.configured ||
                !phrases.length ||
                phrases.length > 2000
              }
            >
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <Play size={16} />
              )}
              {active ? "Сбор уже выполняется" : "Начать сбор"}
              <ArrowRight size={17} />
            </button>
          </form>
          <div className="query-note">
            <Check size={15} />
            <p>
              Прогресс сохраняется на сервере.
              <br />
              Вкладку можно закрыть.
            </p>
          </div>
          <div className="limits-note">
            Данные за последние 30 дней · все устройства. До 2 000 популярных и
            похожих фраз из ответа API на каждый исходный запрос.
          </div>
        </section>
        <div className="wordstat-results">
          {error && <Notice tone="error">{error}</Notice>}
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Результат сбора</h2>
                <p>
                  {current
                    ? dateTime(current.createdAt) + " · " + current.regionName
                    : "Ваши данные появятся здесь"}
                </p>
              </div>
              {current && <Status value={current.status} />}
            </div>
            {current ? (
              <>
                <div className="batch-summary">
                  <div>
                    <span>Обработано</span>
                    <strong>
                      {current.processed}
                      <small> / {current.total}</small>
                    </strong>
                  </div>
                  <div>
                    <span>Фраз собрано</span>
                    <strong>{number(current.semanticCount)}</strong>
                  </div>
                  <div>
                    <span>Уникальных</span>
                    <strong>{number(current.uniqueCount)}</strong>
                  </div>
                </div>
                <div className="batch-progress">
                  <progress
                    max={current.total || 1}
                    value={current.processed}
                    aria-label="Прогресс сбора"
                  />
                  {current.status === "running" && (
                    <p>
                      <LoaderCircle className="spin" size={14} />
                      {current.currentQuery || "Подключаемся к Wordstat…"}
                    </p>
                  )}
                  {current.status === "waiting" && (
                    <Notice>
                      Квота API исчерпана. Сбор продолжится автоматически
                      {current.retryAt
                        ? ` после ${dateTime(current.retryAt)} МСК`
                        : ""}
                      .
                    </Notice>
                  )}
                  {current.status === "exporting" && (
                    <p>
                      <LoaderCircle className="spin" size={14} />
                      Формируем Excel-файл…
                    </p>
                  )}
                  {current.error && <Notice>{current.error}</Notice>}
                </div>
                <div className="result-actions">
                  <div className="search-field">
                    <Search size={16} />
                    <input
                      aria-label="Найти фразу в результатах"
                      placeholder="Найти фразу…"
                      value={filter}
                      onChange={(e) => {
                        setFilter(e.target.value);
                        setViewLimit(100);
                      }}
                    />
                  </div>
                  {current.downloadUrl && (
                    <a
                      className="button primary compact"
                      href={current.downloadUrl}
                    >
                      <ArrowDownToLine size={16} />
                      Excel
                    </a>
                  )}
                  {current.status === "paused" && (
                    <button
                      className="button primary compact"
                      onClick={resume}
                      disabled={busy || active}
                    >
                      <RotateCw size={16} />
                      Продолжить
                    </button>
                  )}
                </div>
                {rows.length ? (
                  <>
                    <div className="table-scroll">
                      <table className="events result-table">
                        <thead>
                          <tr>
                            <th>Исходный запрос</th>
                            <th>Частотность</th>
                            <th>Фраз</th>
                            <th>Статус</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.slice(0, viewLimit).map((item) => (
                            <tr key={item.phrase}>
                              <td>
                                {item.phrase}
                                {item.error && (
                                  <span className="table-error">
                                    {item.error}
                                  </span>
                                )}
                              </td>
                              <td className="tabular">
                                {item.status === "error"
                                  ? "—"
                                  : number(item.totalCount)}
                              </td>
                              <td className="tabular">
                                {number(item.semanticCount)}
                              </td>
                              <td>
                                <span className={`result-label ${item.status}`}>
                                  {item.status === "error"
                                    ? "Ошибка"
                                    : item.status === "empty"
                                      ? "Нет данных"
                                      : "Готово"}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {rows.length > viewLimit && (
                      <button
                        className="button secondary load-more"
                        onClick={() => setViewLimit(viewLimit + 100)}
                      >
                        Показать ещё 100
                      </button>
                    )}
                  </>
                ) : (
                  <Empty
                    title={
                      current.items.length
                        ? "Ничего не найдено"
                        : "Обрабатываем запросы"
                    }
                    text={
                      current.items.length
                        ? "Попробуйте другую фразу для поиска."
                        : "Первые результаты появятся после ответа API."
                    }
                  />
                )}
                {current.status === "completed" && (
                  <div className="limits-note result-footnote">
                    Excel содержит исходные запросы, полную семантику и сведения
                    о выгрузке. Ошибки отдельных запросов отмечены в таблице.
                    При достижении лимита API список фраз может быть неполным.
                  </div>
                )}
              </>
            ) : (
              <Empty
                title="Готовы к сбору"
                text="Добавьте поисковые фразы слева и нажмите «Начать сбор»."
              />
            )}
          </section>
          <section className="panel batch-history">
            <div className="panel-heading">
              <div>
                <h2>Предыдущие сборы</h2>
                <p>Открывайте результаты и продолжайте задачи</p>
              </div>
              <span className="count-badge">{batches.length}</span>
            </div>
            {batches.length ? (
              <div className="batch-list">
                {batches.map((batch) => (
                  <button
                    key={batch.id}
                    className={batch.id === currentId ? "selected" : ""}
                    onClick={() => {
                      setCurrentId(batch.id);
                      setFilter("");
                      setViewLimit(100);
                    }}
                  >
                    <span>
                      <strong>{batch.queries[0]}</strong>
                      <small>
                        {dateTime(batch.createdAt)} · {batch.total} фраз ·{" "}
                        {batch.regionName}
                      </small>
                    </span>
                    <Status value={batch.status} />
                  </button>
                ))}
              </div>
            ) : (
              <p className="batch-empty">Сборов пока нет</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
