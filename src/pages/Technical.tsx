import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowRight, Check, ChevronLeft, ChevronRight, Clock3, LockKeyhole,
  MessageSquareText, PencilLine, Search, Send, SlidersHorizontal, X,
} from "lucide-react";
import { api, post, dateTime, errorText } from "../api";
import { Notice } from "../components/Common";
import "./technical.css";

type Field = { key: string; label: string; sourceIndex: number; targetIndex: number | null };
type Tab = { id: string; title: string; headers: string[]; rowCount: number; lastSync: string | null };
type Item = {
  tabId: string; key: string; rowNumber: number; code: string; values: string[];
  accounting: Record<string, string> | null; matchStatus: string;
  accountingRow: number | null; noteCount: number;
};
type Detail = Item & {
  notes: { id: string; authorName: string; body: string; createdAt: string }[];
  changes: { id: string; columnIndex: number; oldValue: string; newValue: string; authorName: string; createdAt: string }[];
  lockedColumns: number[];
};
type Meta = {
  configured: boolean; syncMode?: string; sheets: Tab[]; updatedAt: string | null;
  lastError: string | null; accountingFields: Field[];
};
type ListData = { total: number; items: Item[] };
const MAIN_TAB = "723255987";
const PAGE_SIZE = 40;
const FIRST_COLUMN_WIDTH = 144;
const NOTES_COLUMN_WIDTH = 92;
const OPEN_COLUMN_WIDTH = 52;

// До первой загрузки Google показываем структуру основного листа без фиктивных строк.
// После импорта берём заголовки только из снимка Google, порядок и значения не меняем.
const INITIAL_MAIN_HEADERS = [
  "Менеджер", "Дефекты / счёт", "Система кондиционирования", "Комментарий",
  "Рейтинг", "Лаборатория / год", "Код объекта", "Наименование компании",
  "ТЦ", "Наименование объекта", "Адрес", "Тема письма", "Телефон",
  "Почта", "Периодичность", "Город", "Электрики", "Стоимость в месяц",
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль",
  "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];
const MAIN_LOCKED_FALLBACK = [6, 7, 9, 10, 12, 13, 14, 15, 17];
const MAIN_LABELS: Record<number, string> = {
  6: "Код объекта", 7: "Наименование компании", 9: "Наименование объекта",
  10: "Адрес", 12: "Телефон", 13: "Почта", 14: "Периодичность",
  15: "Город", 17: "Стоимость в месяц",
};
type TableColumn = {
  id: string;
  label: string;
  index: number | null;
  accountingKey?: "irina";
  locked: boolean;
  pinned: 0 | 1 | 2;
  width: number;
};
const columnWidth = (label: string, index: number): number => {
  if (index === 0) return FIRST_COLUMN_WIDTH;
  if (index === 1) return 244;
  if (/адрес|комментар|дефект|система кондиц|ведомост|наименование работ|информац/i.test(label)) return 300;
  if (/наименование|компания|объект|почта|контакт|тема письма/i.test(label)) return 238;
  if (/месяц|оплата|стоим|дата|номер/i.test(label)) return 178;
  return 172;
};
const display = (value: string | null | undefined) => String(value ?? "").trim() || "—";
const money = (value: string | undefined) => {
  const clean = (value || "").trim();
  return /^\d+(?:[.,]\d+)?$/.test(clean)
    ? `${Number(clean.replace(",", ".")).toLocaleString("ru-RU")} ₽`
    : display(clean);
};
const status = (value: string) => {
  if (value === "linked") return ["Из бухгалтерии", "linked"];
  if (value === "ambiguous") return ["Проверить код", "warning"];
  if (value === "not-found") return ["Нет связи", "neutral"];
  if (value === "no-code") return ["Нет кода", "neutral"];
  return ["Запись", "neutral"];
};

export default function Technical() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tab, setTab] = useState(MAIN_TAB);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ListData>({ total: 0, items: [] });
  const [selected, setSelected] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [author, setAuthor] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [view, setView] = useState<"details" | "history">("details");

  const activeTab = meta?.sheets.find((sheet) => sheet.id === tab);
  const isMain = tab === MAIN_TAB;
  const pageCount = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const tableRef = useRef<HTMLDivElement>(null);
  const [scrollLimits, setScrollLimits] = useState({ left: false, right: false });
  const tableColumns = useMemo<TableColumn[]>(() => {
    const fromSource = activeTab?.headers ?? [];
    const headers = fromSource.length ? fromSource : (isMain ? INITIAL_MAIN_HEADERS : []);
    const locked = new Set<number>(isMain
      ? (meta?.accountingFields.map((field) => field.targetIndex)
          .filter((index): index is number => index !== null) ?? MAIN_LOCKED_FALLBACK)
      : (["2075067225", "1299045180", "846887197"].includes(tab) ? [0] : []));
    const order = isMain && headers.length > 7
      ? [6, 7, ...headers.map((_, index) => index).filter((index) => index !== 6 && index !== 7)]
      : headers.map((_, index) => index);
    const columns: TableColumn[] = order.map((index, position): TableColumn => {
      const sourceLabel = headers[index] || `Столбец ${index + 1}`;
      const label = isMain ? MAIN_LABELS[index] || sourceLabel : sourceLabel;
      return {
        id: `sheet:${index}`, label, index,
        locked: locked.has(index), pinned: position < 2 ? (position + 1) as 1 | 2 : 0,
        width: columnWidth(label, position),
      };
    });
    // Комментарии Ирины находятся только в бухгалтерии: сохраняем их
    // как отдельную read-only колонку, не подменяя рабочие поля техотдела.
    if (isMain) columns.splice(2, 0, {
      id: "accounting:irina", label: "Комментарии Ирины", index: null,
      accountingKey: "irina", locked: true, pinned: 0, width: 320,
    });
    return columns;
  }, [activeTab, isMain, meta?.accountingFields]);
  const tableWidth = tableColumns.reduce((sum, column) => sum + column.width, 0)
    + NOTES_COLUMN_WIDTH + OPEN_COLUMN_WIDTH;
  const tableCellValue = (item: Item, column: TableColumn): string => {
    if (column.accountingKey) return item.accounting?.[column.accountingKey] || "";
    if (column.index === null) return "";
    if (isMain && column.index === 6) return item.accounting?.code || item.values[column.index] || item.code;
    return item.values[column.index] || "";
  };
  const updateScrollLimits = useCallback(() => {
    const root = tableRef.current;
    if (!root) return;
    const next = {
      left: root.scrollLeft > 2,
      right: root.scrollLeft + root.clientWidth < root.scrollWidth - 2,
    };
    setScrollLimits((current) => current.left === next.left && current.right === next.right ? current : next);
  }, []);
  const scrollHorizontally = (direction: -1 | 1) => {
    const root = tableRef.current;
    if (!root) return;
    root.scrollBy({ left: direction * Math.max(360, Math.round(root.clientWidth * 0.7)), behavior: "smooth" });
  };
  useEffect(() => {
    const root = tableRef.current;
    if (!root) return;
    root.scrollLeft = 0;
    updateScrollLimits();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateScrollLimits) : null;
    observer?.observe(root);
    if (root.firstElementChild) observer?.observe(root.firstElementChild);
    window.addEventListener("resize", updateScrollLimits);
    return () => { observer?.disconnect(); window.removeEventListener("resize", updateScrollLimits); };
  }, [tab, tableWidth, updateScrollLimits]);

  const loadMeta = useCallback(async () => {
    try { setMeta(await api<Meta>("/technical/meta")); }
    catch (reason) { setError(errorText(reason)); }
  }, []);
  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q: debouncedQuery, offset: String(page * PAGE_SIZE),
        limit: String(PAGE_SIZE), matched: isMain ? filter : "all",
      });
      setData(await api<ListData>(`/technical/tabs/${tab}/rows?${params}`));
      setError("");
    } catch (reason) { setError(errorText(reason)); }
    finally { setLoading(false); }
  }, [tab, page, filter, isMain, debouncedQuery]);

  useEffect(() => { void loadMeta(); }, [loadMeta]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => { setPage(0); }, [tab, debouncedQuery, filter]);
  useEffect(() => { void loadRows(); }, [loadRows]);
  useEffect(() => {
    const timer = setInterval(() => { void loadMeta(); void loadRows(); }, 30000);
    return () => clearInterval(timer);
  }, [loadMeta, loadRows]);
  useEffect(() => {
    if (!selected) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (editing !== null) setEditing(null);
        else setSelected(null);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selected, editing]);

  const openDetail = async (item: Item, editIndex: number | null = null) => {
    setView("details");
    setEditing(null);
    setNote("");
    setSelected({ ...item, notes: [], changes: [], lockedColumns: [] });
    try {
      const detail = await api<Detail>(`/technical/tabs/${item.tabId}/rows/${encodeURIComponent(item.key)}`);
      setSelected(detail);
      if (editIndex !== null && editIndex >= 0 &&
          editIndex < detail.values.length && !detail.lockedColumns.includes(editIndex)) {
        setEditValue(detail.values[editIndex] || "");
        setEditing(editIndex);
      }
    } catch (reason) { setError(errorText(reason)); }
  };
  const refreshDetail = async (item: Detail) => {
    setSelected(await api<Detail>(`/technical/tabs/${item.tabId}/rows/${encodeURIComponent(item.key)}`));
    await loadRows();
  };
  const submitNote = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !note.trim()) return;
    setBusy(true); setError("");
    try {
      await post(`/technical/tabs/${selected.tabId}/rows/${encodeURIComponent(selected.key)}/notes`, {
        body: note, author: author.trim(),
      });
      setNote("");
      await refreshDetail(selected);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || editing === null) return;
    setBusy(true); setError("");
    try {
      await api(`/technical/tabs/${selected.tabId}/rows/${encodeURIComponent(selected.key)}/cells`, {
        method: "PATCH",
        body: JSON.stringify({ columnIndex: editing, value: editValue, author: author.trim() }),
      });
      setEditing(null);
      await refreshDetail(selected);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  const employeeFields = useMemo(() => {
    if (!selected || !activeTab) return [];
    return activeTab.headers.map((name, index) => ({
      name, index, value: selected.values[index] || "",
      locked: selected.lockedColumns.includes(index),
    })).filter((field) => !field.locked && field.name);
  }, [selected, activeTab]);

  return <section className="tech-page">
    <div className="tech-heading">
      <div>
        <span className="tech-eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО / ТЕХНИЧЕСКИЙ ОТДЕЛ</span>
        <h1>Техотдел<span>.</span></h1>
        <p>Объекты, дополнительные работы и заметки — всё в одном месте.</p>
      </div>
      {meta?.updatedAt && <span className="tech-sync-label"><Clock3 size={15}/> Обновлено {dateTime(meta.updatedAt)}</span>}
    </div>

    {error && <Notice tone="error">{error}</Notice>}
    {meta?.lastError && <Notice tone="error">Ошибка последней синхронизации: {meta.lastError}. Ранее загруженные данные сохранены.</Notice>}
    {!meta?.configured && <Notice tone="info">Для загрузки данных настройте отправку из Google Apps Script на сервер Boykov-services.</Notice>}
    {meta?.configured && meta?.syncMode === "apps-script" && !meta.updatedAt &&
      <Notice tone="info">Данные появятся после первой успешной отправки из Google Apps Script.</Notice>}

    <div className="tech-tabs" role="tablist" aria-label="Разделы технического отдела">
      {meta?.sheets.map((sheet) => <button key={sheet.id} type="button" role="tab"
        aria-selected={tab === sheet.id} className={`tech-tab ${tab === sheet.id ? "active" : ""}`}
        onClick={() => { setTab(sheet.id); setFilter("all"); setSelected(null); }}>
        {sheet.title}<span>{sheet.rowCount}</span>
      </button>)}
    </div>

    <div className="tech-workspace">
      <div className="tech-toolbar">
        <div className="tech-search">
          <Search size={18} aria-hidden="true"/>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Компания, объект, код, город или адрес"
            aria-label="Поиск по объектам"/>
          {query && <button className="tech-clear-search" type="button" aria-label="Очистить поиск" onClick={() => setQuery("")}><X size={15}/></button>}
        </div>
        {isMain && <div className="tech-filter">
          <SlidersHorizontal size={17} aria-hidden="true"/>
          <select aria-label="Фильтр записей" value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">Все объекты</option>
            <option value="linked">Из бухгалтерии</option>
            <option value="not-found">Без связи</option>
            <option value="ambiguous">Проверить код</option>
            <option value="no-code">Без кода</option>
          </select>
        </div>}
        <span className="tech-result-count" aria-live="polite">
          {loading ? "Загрузка…" : `${data.total.toLocaleString("ru-RU")} записей`}
        </span>
      </div>

      <div className="tech-table-scroll" ref={tableRef} onScroll={updateScrollLimits}
        role="region" aria-label={`Таблица ${activeTab?.title || "техотдела"}. Горизонтальная и вертикальная прокрутка`}
        tabIndex={0}>
        <table className="tech-table tech-table-full" style={{ width: Math.max(tableWidth, 700) }}>
          <colgroup>
            {tableColumns.map((column) => <col key={column.id} style={{ width: column.width }} />)}
            <col style={{ width: NOTES_COLUMN_WIDTH }} />
            <col style={{ width: OPEN_COLUMN_WIDTH }} />
          </colgroup>
          <thead><tr>
            {tableColumns.map((column) => <th key={column.id}
              className={`tech-table-header ${column.pinned ? `tech-sticky-${column.pinned}` : ""} ${column.locked ? "tech-locked-cell" : ""}`}
              scope="col" title={column.label}>
              <span className="tech-column-title">
                {column.locked && <LockKeyhole size={12} aria-label="Только чтение" />}
                <span>{column.label}</span>
              </span>
            </th>)}
            <th className="tech-notes-col" scope="col">Заметки</th>
            <th className="tech-open-col" scope="col" aria-label="Карточка" />
          </tr></thead>
          <tbody>
            {data.items.map((item) => {
              const [label, kind] = status(item.matchStatus);
              return <tr key={item.key}>
                {tableColumns.map((column) => {
                  const value = tableCellValue(item, column);
                  const canEdit = !column.locked && column.index !== null && column.pinned === 0;
                  const isMoney = isMain && column.index === 17;
                  const content = isMoney ? money(value) : display(value);
                  return <td key={column.id}
                    className={`tech-data-cell ${column.pinned ? `tech-sticky-${column.pinned}` : ""} ${column.locked ? "tech-locked-cell" : ""} ${isMoney ? "tech-money" : ""}`}>
                    {column.pinned ? <button type="button" className="tech-cell-link tech-cell-pinned"
                      title={value || "Открыть карточку"} onClick={() => void openDetail(item)}>
                      <span>{content}</span>
                      {column.pinned === 1 && isMain && <small className={`tech-match ${kind}`}>{label}</small>}
                    </button> : canEdit ? <button type="button" className="tech-cell-link tech-cell-editable"
                      title={`${column.label}: ${value || "Пусто"}. Нажмите, чтобы изменить`}
                      aria-label={`Изменить поле «${column.label}» в строке ${item.rowNumber}`}
                      onClick={() => void openDetail(item, column.index)}>
                      <span>{content}</span><PencilLine size={13} className="tech-pencil" aria-hidden="true" />
                    </button> : <span className="tech-cell-text" title={value}>{content}</span>}
                  </td>;
                })}
                <td className="tech-notes-col"><button className="tech-note-counter" type="button" onClick={() => void openDetail(item)}
                  aria-label={`Заметки по строке ${item.rowNumber}: ${item.noteCount}`}>
                  <MessageSquareText size={15}/> {item.noteCount || "—"}
                </button></td>
                <td className="tech-open-col"><button className="tech-open-row" type="button" onClick={() => void openDetail(item)}
                  aria-label={`Открыть карточку строки ${item.rowNumber}`}><ArrowRight size={17}/></button></td>
              </tr>;
            })}
            {!data.items.length && <tr><td className="tech-empty" colSpan={tableColumns.length + 2}>
              <strong>{meta?.updatedAt ? "Ничего не найдено" : "Пока нет данных"}</strong>
              <span>{meta?.updatedAt ? "Попробуйте изменить поиск или фильтр." : "Структура таблицы готова. Записи появятся после синхронизации с Google."}</span>
            </td></tr>}
          </tbody>
        </table>
      </div>
      <div className="tech-horizontal-controls">
        <span className="tech-horizontal-hint">
          ↔ Все {tableColumns.length - (isMain ? 1 : 0)} столбцов вкладки{isMain ? " + комментарии Ирины из бухгалтерии" : ""}
          {" · "}Прокручивайте вправо, чтобы увидеть все поля
        </span>
        <div className="tech-horizontal-buttons">
          <button type="button" aria-label="Прокрутить таблицу влево" disabled={!scrollLimits.left}
            onClick={() => scrollHorizontally(-1)}><ChevronLeft size={17}/> Левее</button>
          <button type="button" aria-label="Прокрутить таблицу вправо" disabled={!scrollLimits.right}
            onClick={() => scrollHorizontally(1)}>Правее <ChevronRight size={17}/></button>
        </div>
      </div>
      <div className="tech-pagination">
        <span>Страница {Math.min(page + 1, pageCount)} из {pageCount}</span>
        <div>
          <button className="tech-page-button" type="button" aria-label="Предыдущая страница" disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={17}/></button>
          <button className="tech-page-button" type="button" aria-label="Следующая страница" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}><ChevronRight size={17}/></button>
        </div>
      </div>
    </div>

    {selected && <div className="tech-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setSelected(null); setEditing(null); } }}>
      <aside className="tech-drawer" role="dialog" aria-modal="true" aria-label="Карточка записи">
        <div className="tech-drawer-top">
          <div><span className="tech-eyebrow">{activeTab?.title}</span><h2>{isMain ? display(selected.accounting?.object || selected.values[9] || selected.code) : display(selected.code || `Строка ${selected.rowNumber}`)}</h2>
            {selected.code && <span className="tech-drawer-code">Код: {selected.code}</span>}</div>
          <button className="tech-drawer-close" type="button" onClick={() => setSelected(null)} aria-label="Закрыть карточку"><X size={20}/></button>
        </div>
        <div className="tech-detail-tabs" role="tablist" aria-label="Сведения о записи">
          <button type="button" className={view === "details" ? "active" : ""} onClick={() => setView("details")}>Данные и заметки</button>
          <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}>История правок ({selected.changes.length})</button>
        </div>
        <div className="tech-drawer-body">
          {view === "history" ? <div className="tech-timeline">
            {selected.changes.map((change) => <div className="tech-timeline-entry" key={change.id}>
              <div><strong>{change.authorName}</strong><time>{dateTime(change.createdAt)}</time></div>
              <p>{activeTab?.headers[change.columnIndex] || `Столбец ${change.columnIndex + 1}`}</p>
              <div className="tech-history-diff"><s>{display(change.oldValue)}</s><span>{display(change.newValue)}</span></div>
            </div>)}
            {!selected.changes.length && <p className="tech-muted">Изменений пока нет.</p>}
          </div> : <>
            {isMain && <>
              <div className="tech-section-title"><LockKeyhole size={17}/> Бухгалтерские данные <span>Только просмотр</span></div>
              <div className="tech-accounting-grid">
                {meta?.accountingFields.map((field) => <div key={field.key}><small>{field.label}</small><div>{selected.accounting ? display(selected.accounting[field.key]) : "Нет связи с бухгалтерией"}</div></div>)}
              </div>
            </>}
            <div className="tech-section-title"><PencilLine size={17}/> Рабочие поля <span>Можно изменять</span></div>
            <div className="tech-fields">
              {employeeFields.map((field) => <div className="tech-field" key={field.index}>
                <small>{field.name}</small><p>{display(field.value)}</p>
                <button className="tech-edit-link" type="button" onClick={() => { setEditing(field.index); setEditValue(field.value); }}>Изменить</button>
              </div>)}
              {!employeeFields.length && <p className="tech-muted">Редактируемых полей нет.</p>}
            </div>
            <div className="tech-section-title"><MessageSquareText size={17}/> Заметки сотрудников <span>{selected.notes.length}</span></div>
            <form className="tech-note-form" onSubmit={(event) => void submitNote(event)}>
              <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={4000}
                placeholder="Напишите заметку по объекту…" aria-label="Текст заметки" required />
              <div className="tech-note-actions">
                <label className="tech-author-field"><span>Автор (необязательно)</span>
                  <input value={author} onChange={(event) => setAuthor(event.target.value)} maxLength={80} placeholder="Например, Ирина" /></label>
                <button className="button primary" disabled={busy || !note.trim()}><Send size={15}/> Добавить заметку</button>
              </div>
              <p className="tech-author-hint">Имя указывается вручную. Без имени заметка будет «Без подписи».</p>
            </form>
            <div className="tech-notes">
              {selected.notes.map((item) => <div className="tech-note" key={item.id}>
                <div><strong>{item.authorName}</strong><time>{dateTime(item.createdAt)}</time></div><p>{item.body}</p>
              </div>)}
              {!selected.notes.length && <p className="tech-muted">Заметок пока нет. Добавьте первую.</p>}
            </div>
          </>}
        </div>
        {editing !== null && <div className="tech-editor-overlay">
          <form className="tech-editor" onSubmit={(event) => void submitEdit(event)}>
            <div className="tech-editor-head"><strong>{activeTab?.headers[editing] || "Рабочее поле"}</strong>
              <button type="button" aria-label="Закрыть редактор" onClick={() => setEditing(null)}><X size={18}/></button></div>
            <textarea value={editValue} onChange={(event) => setEditValue(event.target.value)} rows={5} maxLength={10000} aria-label="Новое значение"/>
            <label className="tech-author-field"><span>Автор (необязательно)</span>
              <input value={author} onChange={(event) => setAuthor(event.target.value)} maxLength={80} placeholder="Например, Ирина" /></label>
            <p>Изменение сохранится в Boykov-services, не затрагивая бухгалтерскую таблицу.</p>
            <button className="button primary" disabled={busy}><Check size={16}/> Сохранить</button>
          </form>
        </div>}
      </aside>
    </div>}
  </section>;
}
