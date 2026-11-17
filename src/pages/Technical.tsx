import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, LockKeyhole,
  MessageSquareText, PencilLine, Search, Send, SlidersHorizontal, X, Palette, RotateCcw, Eye, Plus, Trash2, Undo2, Redo2,
} from "lucide-react";
import { api, post, dateTime, errorText } from "../api";
import { Notice } from "../components/Common";
import "./technical.css";

type Field = { key: string; label: string; sourceIndex: number; targetIndex: number | null };
type CustomColumn = { id: string; title: string; sortOrder: number; createdAt: string };
type ArchivedColumn = { id: string; title: string; archivedAt: string };
type Tab = {
  id: string; title: string; headers: string[]; rowCount: number;
  lastSync: string | null; customColumns?: CustomColumn[];
  archivedCustomColumns?: ArchivedColumn[];
};
type Item = {
  tabId: string; key: string; rowNumber: number; code: string; values: string[];
  accounting: Record<string, string> | null; matchStatus: string;
  accountingRow: number | null; noteCount: number;
  customValues?: Record<string, string>;
  cellColors?: Record<string, ColumnTone>;
};
type Detail = Item & {
  notes: { id: string; authorName: string; body: string; createdAt: string }[];
  changes: { id: string; columnIndex: number; columnTitle?: string | null; oldValue: string; newValue: string; authorName: string; createdAt: string }[];
  lockedColumns: number[];
};
type Meta = {
  configured: boolean; syncMode?: string; sheets: Tab[]; updatedAt: string | null;
  lastError: string | null; accountingFields: Field[];
  columnColors?: Record<string, ColumnTone>;
};
type ListData = { total: number; items: Item[] };
const MAIN_TAB = "723255987";
const PAGE_SIZE = 100; // Ограничиваем DOM: до 100 строк вместо бесконечного роста таблицы.
const MAX_WORK_COLUMNS = 50; // Новые поля добавляются по запросу, а не создаются пустыми.
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
type ColumnTone = "none" | "amber" | "blue" | "green" | "rose";
type ColumnPreference = { width?: number };
const PREF_KEY = "boykov-services:tech-column-widths:v2";
const LEGACY_PREF_KEY = "boykov-services:tech-column-view:v1";
const WIDTH_SCALE_KEY = "boykov-services:tech-width-scale:v1";
const readWidthScales = (): Record<string, number> => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(WIDTH_SCALE_KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw)
      .filter(([,value]) => typeof value === "number" && Number.isFinite(value) && value >= .8 && value <= 1.6)) as Record<string, number>;
  } catch { return {}; }
};
const TONES: { id: ColumnTone; label: string }[] = [
  { id: "none", label: "Без цвета" },
  { id: "amber", label: "Тёплый песочный" },
  { id: "blue", label: "Серо-графитовый" },
  { id: "green", label: "Спокойный шалфей" },
  { id: "rose", label: "Фирменный пудровый" },
];
const clampedWidth = (value: number) => Math.max(120, Math.min(900, Math.round(value)));
const initialPreferences = (): Record<string, ColumnPreference> => {
  try {
    // Сохраняем ранее настроенную ширину, старые локальные цвета игнорируем.
    const value = JSON.parse(window.localStorage.getItem(PREF_KEY) ||
      window.localStorage.getItem(LEGACY_PREF_KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value)
      .map(([key, pref]) => [key, { width: (pref as ColumnPreference)?.width }])
      .filter(([, pref]) => typeof (pref as ColumnPreference).width === "number"));
  } catch { return {}; }
};
type TableColumn = {
  id: string;
  label: string;
  index: number | null;
  accountingKey?: "irina";
  customId?: string;
  locked: boolean;
  pinned: 0 | 1 | 2;
  width: number;
  tone: ColumnTone;
};
type ViewState = {
  preferences: Record<string, ColumnPreference>;
  scales: Record<string, number>;
};
type UndoAction =
  | { kind: "view"; label: string; before: ViewState; after: ViewState; mergeKey?: string; time: number }
  | { kind: "columnColor"; label: string; tabId: string; columnId: string; before: ColumnTone; after: ColumnTone }
  | { kind: "cellColor"; label: string; tabId: string; recordKey: string; columnId: string; before: ColumnTone; after: ColumnTone }
  | { kind: "cellEdit"; label: string; tabId: string; recordKey: string; index: number; before: string; after: string }
  | { kind: "customEdit"; label: string; tabId: string; recordKey: string; columnId: string; before: string; after: string }
  | { kind: "customColumn"; label: string; tabId: string; columnId: string; beforeArchived: boolean; afterArchived: boolean };
const MAX_UNDO_ACTIONS = 40;
const sameView = (a: ViewState, b: ViewState) => JSON.stringify(a) === JSON.stringify(b);

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
  const [data, setData] = useState<ListData>({ total: 0, items: [] });
  const [page, setPage] = useState(0);
  const requestVersionRef = useRef(0);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [author, setAuthor] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [view, setView] = useState<"details" | "history">("details");
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);
  const [showNewField, setShowNewField] = useState(false);
  const [newFieldTitle, setNewFieldTitle] = useState("");
  const [deleteField, setDeleteField] = useState<CustomColumn | null>(null);
  const [showArchivedColumns, setShowArchivedColumns] = useState(false);
  const [pendingRevealColumnId, setPendingRevealColumnId] = useState<string | null>(null);
  const [columnSuccess, setColumnSuccess] = useState("");
  const [columnPreferences, setColumnPreferences] = useState<Record<string, ColumnPreference>>(initialPreferences);
  const [widthScales, setWidthScales] = useState<Record<string, number>>(readWidthScales);
  const widthScale = widthScales[tab] ?? 1;
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const [activeCell, setActiveCell] = useState<{
    recordKey: string; rowNumber: number; columnId: string; label: string; color: ColumnTone;
  } | null>(null);
  // Явный режим позволяет окрасить ячейку обычным левым щелчком.
  // Правый щелчок остаётся доступен как быстрый способ.
  const [cellColorMode, setCellColorMode] = useState(false);
  const [fullText, setFullText] = useState<{ label: string; text: string } | null>(null);
  // История только действий этого браузера, не глобальная история сотрудников.
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);
  const [redoStack, setRedoStack] = useState<UndoAction[]>([]);
  const [historyStatus, setHistoryStatus] = useState("");
  const remember = (action: UndoAction) => {
    setUndoStack((previous) => {
      const recent = previous[previous.length - 1];
      if (action.kind === "view" && recent?.kind === "view" &&
          action.mergeKey && action.mergeKey === recent.mergeKey && action.time - recent.time < 650) {
        return [...previous.slice(0, -1), {...action, before: recent.before}];
      }
      return [...previous, action].slice(-MAX_UNDO_ACTIONS);
    });
    setRedoStack([]);
    setHistoryStatus("");
  };

  useEffect(() => {
    try { window.localStorage.setItem(PREF_KEY, JSON.stringify(columnPreferences)); }
    catch { /* Настройки останутся до перезагрузки при ограничениях браузера. */ }
  }, [columnPreferences]);
  useEffect(() => {
    try { window.localStorage.setItem(WIDTH_SCALE_KEY, JSON.stringify(widthScales)); }
    catch { /* Размеры сохранятся на время открытой страницы. */ }
  }, [widthScales]);
  const recordView = (label: string, after: ViewState, mergeKey?: string) => {
    const before: ViewState = {preferences: columnPreferences, scales: widthScales};
    if (sameView(before, after)) return;
    remember({kind:"view",label,before,after,mergeKey,time:Date.now()});
    setColumnPreferences(after.preferences);
    setWidthScales(after.scales);
  };
  const setWidthScale = (percent: number) => {
    const scale = Math.max(.8, Math.min(1.6, percent / 100));
    recordView("Масштаб столбцов", {preferences: columnPreferences, scales:{...widthScales,[tab]:scale}}, `scale:${tab}`);
  };
  const preferenceKey = (columnId: string) => `${tab}:${columnId}`;
  const updateColumnPreference = (columnId: string, patch: ColumnPreference) => {
    const key = preferenceKey(columnId);
    const preferences = {...columnPreferences, [key]:{...columnPreferences[key],...patch}};
    recordView("Ширина столбца", {preferences,scales:widthScales}, `width:${key}`);
  };
  // Храним базовую ширину независимо от общего масштаба.
  const changeColumnWidth = (column: TableColumn, width: number) =>
    updateColumnPreference(column.id, {width:clampedWidth(width / widthScale)});
  const resetColumnWidth = (column: TableColumn) => {
    const key = preferenceKey(column.id);
    const preferences = {...columnPreferences};
    delete preferences[key];
    recordView("Сброс ширины столбца", {preferences,scales:widthScales});
  };
  const updateSharedColor = async (column: TableColumn, color: ColumnTone) => {
    if (column.tone === color) return;
    setBusy(true);
    try {
      await api(`/technical/tabs/${tab}/columns/color`, {
        method: "PATCH", body: JSON.stringify({columnKey:column.id,color,expectedColor:column.tone}),
      });
      remember({kind:"columnColor",label:`Цвет столбца «${column.label}»`,tabId:tab,
        columnId:column.id,before:column.tone,after:color});
      await loadMeta();
      setError("");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  const selectCellForColor = (item: Item, column: TableColumn) => {
    setActiveColumnId(null);
    setActiveCell({
      recordKey:item.key, rowNumber:item.rowNumber, columnId:column.id, label:column.label,
      color:item.cellColors?.[column.id] || "none",
    });
  };
  const openCellPalette = (event: ReactMouseEvent<HTMLTableCellElement>, item: Item, column: TableColumn) => {
    event.preventDefault();
    selectCellForColor(item,column);
  };
  // Одно событие на таблицу, а не по дополнительному обработчику на каждую ячейку.
  // В режиме окрашивания отменяем открытие карточки объекта по нажатию.
  const onCellColorClickCapture = (event: ReactMouseEvent<HTMLTableElement>) => {
    if (!cellColorMode) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const cell = target.closest<HTMLTableCellElement>("td[data-tech-record-key][data-tech-column-id]");
    if (!cell || !event.currentTarget.contains(cell)) return;
    const item = data.items.find((entry)=>entry.key===cell.dataset.techRecordKey);
    const column = tableColumns.find((entry)=>entry.id===cell.dataset.techColumnId);
    if (!item || !column) return;
    event.preventDefault();
    event.stopPropagation();
    selectCellForColor(item,column);
  };
  const updateSharedCellColor = async (color: ColumnTone) => {
    if (!activeCell || activeCell.color === color) return;
    const cell = activeCell;
    setBusy(true);
    try {
      await api(`/technical/tabs/${tab}/rows/${encodeURIComponent(cell.recordKey)}/color`, {
        method:"PATCH", body:JSON.stringify({columnKey:cell.columnId,color,expectedColor:cell.color}),
      });
      remember({kind:"cellColor",label:`Цвет ячейки · ${cell.label}`,tabId:tab,
        recordKey:cell.recordKey,columnId:cell.columnId,before:cell.color,after:color});
      setData(current=>({ ...current, items:current.items.map(item=> item.key!==cell.recordKey ? item : {
        ...item, cellColors:{...(item.cellColors||{}),[cell.columnId]:color},
      })}));
      setActiveCell(current=>current?.recordKey===cell.recordKey && current.columnId===cell.columnId
        ? {...current,color} : current);
      setError("");
    } catch(reason) {setError(errorText(reason));}
    finally {setBusy(false);}
  };
  const openCreateField = () => {
    setNewFieldTitle(""); setColumnSuccess(""); setActiveColumnId(null);
    setActiveCell(null); setShowNewField(true);
  };
  const archiveField = async () => {
    if (!deleteField) return;
    setBusy(true);
    try {
      await api(`/technical/tabs/${tab}/columns/${encodeURIComponent(deleteField.id)}`, {method:"DELETE",body:JSON.stringify({expectedArchived:false})});
      const title = deleteField.title;
      remember({kind:"customColumn",label:`Удаление столбца «${title}»`,tabId:tab,
        columnId:deleteField.id,beforeArchived:false,afterArchived:true});
      setDeleteField(null); setActiveColumnId(null); setSelected(null);
      await loadMeta(); await loadRows();
      setColumnSuccess(`Столбец «${title}» убран. Его значения можно восстановить через «Удалённые поля».`);
      setError("");
    } catch (reason) {setError(errorText(reason));}
    finally {setBusy(false);}
  };
  const restoreField = async (column: ArchivedColumn) => {
    setBusy(true);
    try {
      await post(`/technical/tabs/${tab}/columns/${encodeURIComponent(column.id)}/restore`,{expectedArchived:true});
      remember({kind:"customColumn",label:`Восстановление столбца «${column.title}»`,tabId:tab,
        columnId:column.id,beforeArchived:true,afterArchived:false});
      setPendingRevealColumnId(`custom:${column.id}`);
      setShowArchivedColumns(false);
      await loadMeta(); await loadRows();
      setColumnSuccess(`Столбец «${column.title}» восстановлен вместе со значениями.`);
      setError("");
    } catch(reason){setError(errorText(reason));}
    finally{setBusy(false);}
  };
  const createNewField = async (event: FormEvent) => {
    event.preventDefault();
    if (!newFieldTitle.trim()) return;
    setBusy(true);
    try {
      const created = await post<CustomColumn>(`/technical/tabs/${tab}/columns`, {title:newFieldTitle.trim()});
      remember({kind:"customColumn",label:`Добавление столбца «${created.title}»`,tabId:tab,
        columnId:created.id,beforeArchived:true,afterArchived:false});
      setShowNewField(false); setNewFieldTitle(""); setActiveColumnId(null);
      setPendingRevealColumnId(`custom:${created.id}`);
      await loadMeta();
      await loadRows();
      setColumnSuccess(`«${created.title}» добавлено справа. Поле доступно всей команде.`);
      setError("");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  const onResizeStart = (event: ReactPointerEvent<HTMLSpanElement>, column: TableColumn) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = column.width;
    const root = tableRef.current;
    const table = root?.querySelector<HTMLTableElement>("table.tech-table-full");
    const colIndex = tableColumns.findIndex((item) => item.id === column.id);
    const col = table?.querySelectorAll<HTMLTableColElement>("colgroup col").item(colIndex);
    const secondPinned = column.pinned === 1
      ? Array.from(table?.querySelectorAll<HTMLElement>(".tech-sticky-2") || []) : [];
    let currentWidth = startWidth;
    let frame = 0;
    const preview = (width: number) => {
      currentWidth = clampedWidth(width);
      if (col) col.style.width = `${currentWidth}px`;
      if (table) table.style.width = `${Math.max(700, tableWidth - startWidth + currentWidth)}px`;
      secondPinned.forEach((el) => { el.style.left = `${currentWidth}px`; });
    };
    const onMove = (move: PointerEvent) => {
      const next = clampedWidth(startWidth + move.clientX - startX);
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = 0; preview(next); });
    };
    const finish = (endX: number, commit: boolean) => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (commit) changeColumnWidth(column, clampedWidth(startWidth + endX - startX));
      else preview(startWidth);
    };
    const onUp = (up: PointerEvent) => finish(up.clientX, true);
    const onCancel = () => finish(startX, false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, {once:true});
    window.addEventListener("pointercancel", onCancel, {once:true});
  };

  const activeTab = meta?.sheets.find((sheet) => sheet.id === tab);
  const canAddField = Boolean(meta?.updatedAt) &&
    (activeTab?.headers.length || 0) + (activeTab?.customColumns?.length || 0) < MAX_WORK_COLUMNS;
  const isMain = tab === MAIN_TAB;
  const pageCount = Math.max(1,Math.ceil(data.total/PAGE_SIZE));
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
        width: clampedWidth(Math.round((columnPreferences[`${tab}:sheet:${index}`]?.width ?? columnWidth(label, position)) * widthScale)),
        tone: meta?.columnColors?.[`${tab}:sheet:${index}`] ?? "none",
      };
    });
    // Комментарии Ирины находятся только в бухгалтерии: сохраняем их
    // как отдельную read-only колонку, не подменяя рабочие поля техотдела.
    if (isMain) columns.splice(2, 0, {
      id: "accounting:irina", label: "Комментарии Ирины", index: null,
      accountingKey: "irina", locked: true, pinned: 0,
      width: clampedWidth(Math.round((columnPreferences[`${tab}:accounting:irina`]?.width ?? 320) * widthScale)),
      tone: meta?.columnColors?.[`${tab}:accounting:irina`] ?? "none",
    });
    // Редактируемые поля, созданные сотрудниками, — только в Boykov-services.
    for (const field of activeTab?.customColumns || []) {
      const id = `custom:${field.id}`;
      columns.push({id,label:field.title,index:null,customId:field.id,locked:false,pinned:0,
        width:clampedWidth(Math.round((columnPreferences[`${tab}:${id}`]?.width ?? 220) * widthScale)),
        tone:meta?.columnColors?.[`${tab}:${id}`] ?? "none"});
    }
    return columns;
  }, [activeTab, isMain, meta?.accountingFields, meta?.columnColors, tab, columnPreferences, widthScale]);
  // Автоматически раскрываем добавленный столбец после обновления метаданных,
  // чтобы его не пришлось искать в длинной таблице.
  useEffect(() => {
    if (!pendingRevealColumnId || !tableColumns.some((c)=>c.id===pendingRevealColumnId)) return;
    const frame = requestAnimationFrame(() => {
      const table = tableRef.current;
      if (table) table.scrollLeft = table.scrollWidth - table.clientWidth;
      setPendingRevealColumnId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingRevealColumnId, tableColumns]);
  const activeColumn = tableColumns.find((column) => column.id === activeColumnId) || null;
  const firstPinnedWidth = tableColumns.find((column) => column.pinned === 1)?.width ?? FIRST_COLUMN_WIDTH;
  const autoFitColumn = (column: TableColumn) => {
    // Для длинных комментариев ширина ограничена: остальное переносится.
    const longest = Math.max(column.label.length,
      ...data.items.slice(0, 45).map((item) => tableCellValue(item, column)
        .split(/\r?\n/).reduce((maximum, line) => Math.max(maximum, line.length), 0)));
    changeColumnWidth(column, Math.min(580, Math.max(150, longest * 6.5 + 42)));
  };
  const autoFitAllColumns = () => {
    const patch: Record<string, ColumnPreference> = {};
    for (const column of tableColumns) {
      const longest = Math.max(column.label.length,
        ...data.items.slice(0, 35).map((item) => tableCellValue(item, column)
          .split(/\r?\n/).reduce((maximum, line) => Math.max(maximum, line.length), 0)));
      const width = Math.min(460, Math.max(130, longest * 6.4 + 40));
      patch[preferenceKey(column.id)] = {width:clampedWidth(width / widthScale)};
    }
    recordView("Автоширина столбцов", {preferences:{...columnPreferences,...patch},scales:widthScales});
  };
  const resetTabWidths = () => {
    const preferences = Object.fromEntries(Object.entries(columnPreferences)
      .filter(([key]) => !key.startsWith(`${tab}:`)));
    recordView("Сброс ширины таблицы", {preferences,scales:{...widthScales,[tab]:1}});
  };
  const tableWidth = tableColumns.reduce((sum, column) => sum + column.width, 0)
    + NOTES_COLUMN_WIDTH + OPEN_COLUMN_WIDTH;
  const tableCellValue = (item: Item, column: TableColumn): string => {
    if (column.accountingKey) return item.accounting?.[column.accountingKey] || "";
    if (column.customId) return item.customValues?.[column.customId] || "";
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
  }, [tab, updateScrollLimits]);
  useEffect(() => { updateScrollLimits(); }, [tableWidth, updateScrollLimits]);

  const loadMeta = useCallback(async () => {
    try { setMeta(await api<Meta>("/technical/meta")); }
    catch (reason) { setError(errorText(reason)); }
  }, []);
  // Запросы ограничены 100 строками. При смене страницы прошлые DOM-узлы
  // снимаются с экрана, поэтому длинные комментарии не замедляют прокрутку.
  const loadRows = useCallback(async () => {
    const request = ++requestVersionRef.current;
    setLoading(true);
    const params = new URLSearchParams({
      q:debouncedQuery, offset:String(page*PAGE_SIZE), limit:String(PAGE_SIZE),
      matched:isMain ? filter : "all",
    });
    try {
      const response = await api<ListData>(`/technical/tabs/${tab}/rows?${params}`);
      if (requestVersionRef.current !== request) return;
      if (page>0 && response.total>0 && response.items.length===0) {
        setPage(Math.max(0,Math.ceil(response.total/PAGE_SIZE)-1));
        return;
      }
      setData(response);
      setError("");
    } catch(reason) {
      if (requestVersionRef.current === request) setError(errorText(reason));
    } finally {
      if (requestVersionRef.current === request) setLoading(false);
    }
  },[tab,debouncedQuery,filter,isMain,page]);

  const onTableScroll = () => updateScrollLimits();
  useEffect(() => { void loadMeta(); }, [loadMeta]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => { void loadRows(); }, [loadRows]);
  useEffect(() => {
    const timer = setInterval(() => { void loadMeta(); void loadRows(); }, 30000);
    return () => clearInterval(timer);
  }, [loadMeta, loadRows]);
  useEffect(() => {
    if (tableRef.current) tableRef.current.scrollTop = 0;
  },[page,tab]);
  useEffect(() => {
    if (!selected) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (editing !== null || editingCustomId !== null) {setEditing(null);setEditingCustomId(null);}
        else setSelected(null);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selected, editing, editingCustomId]);

  const openDetail = async (item: Item, editColumn: TableColumn | null = null) => {
    setView("details");
    setEditing(null);
    setEditingCustomId(null);
    setNote("");
    setSelected({ ...item, notes: [], changes: [], lockedColumns: [] });
    try {
      const detail = await api<Detail>(`/technical/tabs/${item.tabId}/rows/${encodeURIComponent(item.key)}`);
      setSelected(detail);
      if (editColumn?.customId) {
        setEditValue(detail.customValues?.[editColumn.customId] || "");
        setEditingCustomId(editColumn.customId);
      } else if (editColumn?.index !== null && editColumn?.index !== undefined &&
          editColumn.index >= 0 && editColumn.index < detail.values.length &&
          !detail.lockedColumns.includes(editColumn.index)) {
        setEditValue(detail.values[editColumn.index] || "");
        setEditing(editColumn.index);
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
    if (!selected || (editing === null && editingCustomId === null)) return;
    setBusy(true); setError("");
    try {
      if (editingCustomId !== null) {
        const before = selected.customValues?.[editingCustomId] || "";
        if (before !== editValue) {
          await api(`/technical/tabs/${selected.tabId}/rows/${encodeURIComponent(selected.key)}/custom/${editingCustomId}`, {
            method:"PATCH",body:JSON.stringify({value:editValue,author:author.trim(),expectedValue:before}),
          });
          remember({kind:"customEdit",label:"Редактирование рабочего поля",tabId:selected.tabId,
            recordKey:selected.key,columnId:editingCustomId,before,after:editValue});
        }
      } else if (editing !== null) {
        const before = selected.values[editing] || "";
        if (before !== editValue) {
          await api(`/technical/tabs/${selected.tabId}/rows/${encodeURIComponent(selected.key)}/cells`, {
            method:"PATCH",body:JSON.stringify({columnIndex:editing,value:editValue,author:author.trim(),expectedValue:before}),
          });
          remember({kind:"cellEdit",label:`Редактирование «${activeTab?.headers[editing] || "поля"}»`,tabId:selected.tabId,
            recordKey:selected.key,index:editing,before,after:editValue});
        }
      }
      setEditing(null); setEditingCustomId(null);
      await refreshDetail(selected);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  const applyHistory = async (action: UndoAction, undo: boolean) => {
    if (action.kind === "view") {
      const next = undo ? action.before : action.after;
      setColumnPreferences(next.preferences);
      setWidthScales(next.scales);
      return;
    }
    if (action.kind === "columnColor" || action.kind === "cellColor") {
      const color = undo ? action.before : action.after;
      const expectedColor = undo ? action.after : action.before;
      const url = action.kind === "columnColor"
        ? `/technical/tabs/${action.tabId}/columns/color`
        : `/technical/tabs/${action.tabId}/rows/${encodeURIComponent(action.recordKey)}/color`;
      await api(url,{method:"PATCH",body:JSON.stringify({columnKey:action.columnId,color,expectedColor})});
      return;
    }
    if (action.kind === "cellEdit" || action.kind === "customEdit") {
      const value = undo ? action.before : action.after;
      const expectedValue = undo ? action.after : action.before;
      const url = action.kind === "cellEdit"
        ? `/technical/tabs/${action.tabId}/rows/${encodeURIComponent(action.recordKey)}/cells`
        : `/technical/tabs/${action.tabId}/rows/${encodeURIComponent(action.recordKey)}/custom/${action.columnId}`;
      await api(url,{method:"PATCH",body:JSON.stringify({
        ...(action.kind === "cellEdit" ? {columnIndex:action.index} : {}),
        value,expectedValue,author:undo?"Отмена изменения":"Повтор изменения",
      })});
      return;
    }
    const archived = undo ? action.beforeArchived : action.afterArchived;
    const expectedArchived = !archived;
    const url = `/technical/tabs/${action.tabId}/columns/${encodeURIComponent(action.columnId)}`;
    if (archived) await api(url,{method:"DELETE",body:JSON.stringify({expectedArchived})});
    else await post(`${url}/restore`,{expectedArchived});
  };
  const runHistory = async (direction: "undo" | "redo") => {
    if (busy) return;
    const undo = direction === "undo";
    const stack = undo ? undoStack : redoStack;
    const action = stack[stack.length-1];
    if (!action) return;
    setBusy(true);
    try {
      await applyHistory(action,undo);
      if (undo) {
        setUndoStack((old)=>old.slice(0,-1));
        setRedoStack((old)=>[...old,action]);
      } else {
        setRedoStack((old)=>old.slice(0,-1));
        setUndoStack((old)=>[...old,action]);
      }
      setHistoryStatus(`${undo ? "Отменено" : "Повторено"}: ${action.label}`);
      setError("");
      if (action.kind !== "view") {
        await loadMeta();
        await loadRows();
        if (selected && "recordKey" in action && selected.tabId === action.tabId && selected.key === action.recordKey)
          setSelected(await api<Detail>(`/technical/tabs/${selected.tabId}/rows/${encodeURIComponent(selected.key)}`));
        if (action.kind === "customColumn") {
          setActiveColumnId(null); setActiveCell(null); setSelected(null);
        }
        if (action.kind === "cellColor" && activeCell?.recordKey === action.recordKey && activeCell.columnId === action.columnId)
          setActiveCell((current)=>current ? {...current,color:undo ? action.before : action.after} : current);
      }
    } catch (reason) {
      setError(errorText(reason));
      setHistoryStatus("Отмена/повтор не выполнены: данные могли измениться в другой вкладке или у коллеги.");
      await Promise.all([loadMeta(),loadRows()]);
    } finally { setBusy(false); }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || busy) return;
      const node = event.target;
      if (node instanceof Element && node.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]')) return;
      const key = event.key.toLowerCase();
      if (key === "z" || key === "y") {
        const direction = key === "y" || event.shiftKey ? "redo" : "undo";
        if ((direction === "undo" ? undoStack : redoStack).length) {
          event.preventDefault(); void runHistory(direction);
        }
      }
    };
    window.addEventListener("keydown",handler);
    return () => window.removeEventListener("keydown",handler);
  },[undoStack,redoStack,busy,tab,selected,meta,data]);

  const employeeFields = useMemo(() => {
    if (!selected || !activeTab) return [];
    return tableColumns.filter((column) => column.index !== null || column.customId)
      .map((column) => ({
        name: column.label, index: column.index, customId:column.customId,
        value: column.customId ? (selected.customValues?.[column.customId] || "") :
          (selected.values[column.index as number] || ""),
        locked: column.locked || (column.index !== null && selected.lockedColumns.includes(column.index)),
      })).filter((field) => !field.locked && field.name);
  }, [selected, activeTab, tableColumns]);

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
        onClick={() => { setTab(sheet.id); setPage(0); setFilter("all"); setSelected(null); setActiveColumnId(null); setActiveCell(null); setCellColorMode(false); }}>
        {sheet.title}<span>{sheet.rowCount}</span>
      </button>)}
    </div>

    <div className="tech-workspace">
      <div className="tech-toolbar">
        <div className="tech-search">
          <Search size={18} aria-hidden="true"/>
          <input type="search" value={query} onChange={(event) => {setQuery(event.target.value);setPage(0);}}
            placeholder="Компания, объект, код, город или адрес"
            aria-label="Поиск по объектам"/>
          {query && <button className="tech-clear-search" type="button" aria-label="Очистить поиск" onClick={() => {setQuery("");setPage(0);}}><X size={15}/></button>}
        </div>
        {isMain && <div className="tech-filter">
          <SlidersHorizontal size={17} aria-hidden="true"/>
          <select aria-label="Фильтр записей" value={filter} onChange={(event) => {setFilter(event.target.value);setPage(0);}}>
            <option value="all">Все объекты</option>
            <option value="linked">Из бухгалтерии</option>
            <option value="not-found">Без связи</option>
            <option value="ambiguous">Проверить код</option>
            <option value="no-code">Без кода</option>
          </select>
        </div>}
        <button type="button" className="tech-add-field" disabled={!canAddField}
          onClick={openCreateField} title="Добавить новый столбец справа и сразу перейти к нему">
          <Plus size={16} aria-hidden="true"/> Столбец
        </button>
        <span className="tech-result-count" aria-live="polite">
          {loading ? "Загрузка…" : `${data.total.toLocaleString("ru-RU")} записей`}
        </span>
      </div>

      <div className={`tech-color-quickbar ${cellColorMode ? "is-active" : ""}`} role="group" aria-label="Подсветка ячеек">
        <button type="button" className={`tech-color-mode-button ${cellColorMode ? "is-active" : ""}`}
          aria-pressed={cellColorMode}
          onClick={() => { setCellColorMode((current)=>!current); setActiveCell(null); setActiveColumnId(null); }}>
          {cellColorMode ? <Check size={17} aria-hidden="true" /> : <Palette size={17} aria-hidden="true" />}
          {cellColorMode ? "Завершить выделение" : "Окрасить ячейку"}
        </button>
        <span className="tech-color-quickbar-hint">
          {cellColorMode ? "Выберите ячейку обычным щелчком, затем нажмите на нужный цвет." : "Для одного поля — эта кнопка. Для всего столбца — палитра в заголовке."}
        </span>
        <div className="tech-undo-redo" role="group" aria-label="История действий в таблице">
          <button type="button" disabled={busy || !undoStack.length} onClick={()=>void runHistory("undo")}
            title={undoStack.length ? `Отменить: ${undoStack[undoStack.length-1].label} · Ctrl+Z` : "Пока нечего отменять"}
            aria-label="Отменить последнее изменение"><Undo2 size={17} aria-hidden="true"/> Отменить</button>
          <button type="button" disabled={busy || !redoStack.length} onClick={()=>void runHistory("redo")}
            title={redoStack.length ? `Повторить: ${redoStack[redoStack.length-1].label} · Ctrl+Y` : "Пока нечего повторять"}
            aria-label="Повторить отменённое изменение"><Redo2 size={17} aria-hidden="true"/> Повторить</button>
          {historyStatus && <span role="status" className="tech-undo-status">{historyStatus}</span>}
        </div>
        <span className="tech-color-quickbar-shared">Цвет виден всей команде</span>
      </div>

      <div className="tech-width-layout" role="group" aria-label="Ширина таблицы">
        <span className="tech-width-title"><SlidersHorizontal size={15} aria-hidden="true" /> Ширина столбцов</span>
        <label className="tech-width-range-label" htmlFor="tech-width-range">Все сразу</label>
        <input id="tech-width-range" className="tech-width-range" type="range"
          min="80" max="160" step="10" value={Math.round(widthScale*100)}
          onChange={(event) => setWidthScale(Number(event.target.value))}
          aria-label="Изменить ширину всех столбцов" />
        <output htmlFor="tech-width-range">{Math.round(widthScale*100)}%</output>
        <button type="button" onClick={autoFitAllColumns} title="Подобрать ширину столбцов по видимым строкам">По содержимому</button>
        <button type="button" onClick={resetTabWidths} title="Сбросить размеры на этой вкладке">Сбросить</button>
        <span className="tech-width-help">Любую границу можно потянуть мышью; двойной щелчок — автоширина</span>
      </div>

      {activeCell && <div className="tech-column-toolbar tech-cell-toolbar" aria-label={`Подсветка ячейки ${activeCell.label}`}>
        <div className="tech-column-toolbar-heading">
          <Palette size={17} aria-hidden="true" />
          <span title={activeCell.label}>Ячейка · строка {activeCell.rowNumber} · {activeCell.label}</span>
        </div>
        <div className="tech-column-palette" role="group" aria-label="Цвет выбранной ячейки">
          {TONES.map((tone)=><button key={tone.id} type="button" disabled={busy}
            className={`tech-tone-button tech-tone-button-${tone.id} ${activeCell.color===tone.id ? "active" : ""}`}
            onClick={()=>void updateSharedCellColor(tone.id)} aria-pressed={activeCell.color===tone.id}
            title={tone.label} aria-label={`Ячейка: ${tone.label}`} />)}
        </div>
        <span className="tech-column-shared-hint">Ячейка имеет приоритет над цветом столбца · Цвет видят все</span>
        <button className="tech-column-toolbar-close" type="button" onClick={()=>setActiveCell(null)} aria-label="Закрыть цвет ячейки"><X size={16}/></button>
      </div>}

      {columnSuccess && <div className="tech-column-success" role="status">
        <Check size={15} aria-hidden="true"/><span>{columnSuccess}</span>
        <button type="button" onClick={() => { const table=tableRef.current; if(table) table.scrollLeft=table.scrollWidth; }}>
          Показать справа <ArrowRight size={14}/>
        </button>
        <button type="button" className="tech-column-success-close" onClick={()=>setColumnSuccess("")} aria-label="Скрыть сообщение"><X size={14}/></button>
      </div>}
      {activeColumn && <div className="tech-column-toolbar" aria-label={`Настройки столбца ${activeColumn.label}`}>
        <div className="tech-column-toolbar-heading">
          <Palette size={17} aria-hidden="true" />
          <span title={activeColumn.label}>{activeColumn.label}</span>
        </div>
        <div className="tech-column-palette" role="group" aria-label="Подсветка всего столбца">
          {TONES.map((tone) => <button key={tone.id} type="button"
            className={`tech-tone-button tech-tone-button-${tone.id} ${activeColumn.tone === tone.id ? "active" : ""}`}
            disabled={busy} onClick={() => void updateSharedColor(activeColumn, tone.id)}
            aria-pressed={activeColumn.tone === tone.id}
            title={tone.label} aria-label={tone.label} />)}
        </div>
        <div className="tech-column-width-controls" role="group" aria-label="Ширина столбца">
          <button type="button" onClick={() => changeColumnWidth(activeColumn, activeColumn.width - 90)}>Уже</button>
          <button type="button" onClick={() => changeColumnWidth(activeColumn, activeColumn.width + 90)}>Шире</button>
          <button type="button" onClick={() => autoFitColumn(activeColumn)}>Автоширина</button>
          <button type="button" title="Сбросить ширину" aria-label="Сбросить ширину"
            onClick={() => resetColumnWidth(activeColumn)}><RotateCcw size={15}/></button>
        </div>
        {activeColumn.customId && <button type="button" className="tech-delete-field-button"
          onClick={() => {
            setDeleteField({id:activeColumn.customId!,title:activeColumn.label,sortOrder:0,createdAt:""});
            setActiveColumnId(null);
          }}><X size={15} aria-hidden="true"/> Удалить столбец</button>}
        <button type="button" className="tech-column-toolbar-close" aria-label="Закрыть настройки столбца"
          onClick={() => setActiveColumnId(null)}><X size={16}/></button>
        <span className="tech-column-shared-hint">Цвет видят все · Ширина только у вас</span>
      </div>}

      <div className="tech-table-frame">
      <div className={`tech-table-scroll ${cellColorMode ? "tech-paint-mode" : ""}`} ref={tableRef} onScroll={onTableScroll}
        role="region" aria-label={`Таблица ${activeTab?.title || "техотдела"}. Горизонтальная и вертикальная прокрутка`}
        tabIndex={0}>
        <table className="tech-table tech-table-full" onClickCapture={onCellColorClickCapture}
          style={{ width: Math.max(tableWidth, 700) }}>
          <colgroup>
            {tableColumns.map((column) => <col key={column.id} style={{ width: column.width }} />)}
            <col style={{ width: NOTES_COLUMN_WIDTH }} />
            <col style={{ width: OPEN_COLUMN_WIDTH }} />
          </colgroup>
          <thead><tr>
            {tableColumns.map((column) => <th key={column.id}
              className={`tech-table-header ${column.pinned ? `tech-sticky-${column.pinned}` : ""} ${column.locked ? "tech-locked-cell" : ""} ${column.tone !== "none" ? `tech-tone-${column.tone}` : ""}`}
              style={column.pinned === 2 ? { left: firstPinnedWidth } : undefined}
              scope="col" title={column.label}>
              <span className="tech-column-title">
                {column.locked && <LockKeyhole size={12} aria-label="Только чтение" />}
                <span>{column.label}</span>
              </span>
              <button type="button" className={`tech-header-settings ${activeColumnId === column.id ? "active" : ""}`}
                onClick={() => {setActiveCell(null);setActiveColumnId((current) => current === column.id ? null : column.id);}}
                aria-label={`Окрасить весь столбец и настроить ширину: ${column.label}`} aria-pressed={activeColumnId === column.id}
                title="Окрасить весь столбец и настроить ширину"><Palette size={15}/></button>
              {column.customId && <button type="button" className="tech-header-remove"
                title={`Удалить рабочий столбец «${column.label}»`}
                aria-label={`Удалить рабочий столбец ${column.label}`}
                onClick={() => {
                  setActiveColumnId(null); setActiveCell(null);
                  setDeleteField({id:column.customId!,title:column.label,sortOrder:0,createdAt:""});
                }}><Trash2 size={14} aria-hidden="true"/></button>}
              <span role="separator" aria-label={`Изменить ширину столбца ${column.label}`} aria-orientation="vertical"
                aria-valuemin={120} aria-valuemax={900} aria-valuenow={column.width} tabIndex={0}
                className="tech-header-resize" onPointerDown={(event) => onResizeStart(event, column)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    changeColumnWidth(column, column.width + (event.key === "ArrowRight" ? 24 : -24));
                  }
                }}
                onDoubleClick={() => autoFitColumn(column)}
                title="Тяните границу столбца — ширина меняется сразу; двойной щелчок — автоширина" />
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
                  const canEdit = !column.locked && (column.index !== null || Boolean(column.customId)) && column.pinned === 0;
                  const isMoney = isMain && column.index === 17;
                  const content = isMoney ? money(value) : display(value);
                  const cellTone = item.cellColors?.[column.id] || "none";
                  return <td key={column.id}
                    data-tech-record-key={item.key} data-tech-column-id={column.id}
                    onContextMenu={(event) => openCellPalette(event,item,column)}
                    style={column.pinned === 2 ? { left: firstPinnedWidth } : undefined}
                    className={`tech-data-cell ${column.pinned ? `tech-sticky-${column.pinned}` : ""} ${column.locked ? "tech-locked-cell" : ""} ${isMoney ? "tech-money" : ""} ${column.tone !== "none" ? `tech-tone-${column.tone}` : ""} ${cellTone !== "none" ? `tech-cell-tone-${cellTone}` : ""} ${activeCell?.recordKey===item.key && activeCell?.columnId===column.id ? "tech-selected-color-cell" : ""}`}>
                    {column.pinned ? <button type="button" className="tech-cell-link tech-cell-pinned"
                      title={value || "Открыть карточку"} onClick={() => void openDetail(item)}>
                      <span>{content}</span>
                      {column.pinned === 1 && isMain && <small className={`tech-match ${kind}`}>{label}</small>}
                    </button> : canEdit ? <button type="button" className="tech-cell-link tech-cell-editable"
                      title={`${column.label}: ${value || "Пусто"}. Нажмите, чтобы изменить`}
                      aria-label={`Изменить поле «${column.label}» в строке ${item.rowNumber}`}
                      onClick={() => void openDetail(item, column)}>
                      <span>{content}</span><PencilLine size={13} className="tech-pencil" aria-hidden="true" />
                    </button> : value.length > 45 || value.includes("\n")
                      ? <button type="button" className="tech-cell-readmore"
                          title="Прочитать полный текст" aria-label={`Прочитать поле ${column.label} полностью`}
                          onClick={() => setFullText({ label: column.label, text: value })}>
                          <span className="tech-cell-text">{content}</span><Eye size={13} aria-hidden="true" />
                        </button>
                      : <span className="tech-cell-text" title={value}>{content}</span>}
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
      <button type="button" className="tech-add-side" disabled={!canAddField}
        title="Добавить столбец в конец таблицы" aria-label="Добавить столбец справа"
        onClick={openCreateField}><Plus size={17} aria-hidden="true"/><span>Столбец</span></button>
      </div>
      <div className="tech-add-bottom">
        <button type="button" disabled={!canAddField} onClick={openCreateField}>
          <Plus size={16} aria-hidden="true"/> Добавить столбец в конец
        </button>
        <span>Новый столбец появится справа у всей команды · Исходные поля Google не меняются</span>
        {(activeTab?.archivedCustomColumns?.length || 0) > 0 && <button type="button" className="tech-archived-trigger"
          onClick={()=>setShowArchivedColumns(true)}>Удалённые поля ({activeTab?.archivedCustomColumns?.length})</button>}
      </div>
      <div className="tech-horizontal-controls" aria-label="Горизонтальная навигация таблицы">
        <div className="tech-horizontal-buttons">
          <button type="button" aria-label="Прокрутить таблицу влево" disabled={!scrollLimits.left}
            onClick={() => scrollHorizontally(-1)}><ChevronLeft size={17}/> Левее</button>
          <button type="button" aria-label="Прокрутить таблицу вправо" disabled={!scrollLimits.right}
            onClick={() => scrollHorizontally(1)}>Правее <ChevronRight size={17}/></button>
        </div>
      </div>
      <div className="tech-pagination" role="navigation" aria-label="Переход между страницами таблицы">
        <div className="tech-pagination-summary" aria-live="polite">
          <span>Показаны строки</span>
          <strong>{data.total ? (page*PAGE_SIZE+1).toLocaleString("ru-RU") : "0"}–{Math.min((page+1)*PAGE_SIZE,data.total).toLocaleString("ru-RU")}</strong>
          <span>из {data.total.toLocaleString("ru-RU")}</span>
        </div>
        <div className="tech-pagination-actions">
          <button type="button" className="tech-page-step" disabled={page===0 || loading}
            onClick={()=>{setActiveCell(null);setPage(current=>Math.max(0,current-1));}} aria-label="Предыдущие 100 строк">
            <ChevronLeft size={17} aria-hidden="true"/> <span>Назад</span>
          </button>
          <label className="tech-page-range-picker" htmlFor="tech-page-range">
            <span>Перейти к строкам</span>
            <span className="tech-page-range-control">
              <select id="tech-page-range" aria-label="Перейти к диапазону строк" value={page}
                onChange={(event)=>{setActiveCell(null);setPage(Number(event.target.value));}}>
                {Array.from({length:pageCount},(_,index)=><option key={index} value={index}>
                  {data.total ? `${(index*PAGE_SIZE+1).toLocaleString("ru-RU")}–${Math.min((index+1)*PAGE_SIZE,data.total).toLocaleString("ru-RU")}` : "Нет строк"}
                </option>)}
              </select>
              <ChevronDown size={15} aria-hidden="true"/>
            </span>
          </label>
          <button type="button" className="tech-page-step tech-page-step-next" disabled={page>=pageCount-1 || loading}
            onClick={()=>{setActiveCell(null);setPage(current=>Math.min(pageCount-1,current+1));}} aria-label="Следующие 100 строк">
            <span>Далее</span> <ChevronRight size={17} aria-hidden="true"/>
          </button>
        </div>
      </div>
    </div>

    {deleteField && <div className="tech-text-preview-backdrop"
      onMouseDown={(event)=>{if(event.target===event.currentTarget) setDeleteField(null);}}>
      <section className="tech-text-preview tech-delete-field-dialog" role="alertdialog" aria-modal="true"
        aria-label={`Удалить столбец ${deleteField.title}`}>
        <header><span>Убрать столбец «{deleteField.title}»?</span>
          <button type="button" aria-label="Отмена" onClick={()=>setDeleteField(null)}><X size={18}/></button></header>
        <p>Столбец исчезнет у всех сотрудников. Значения и история правок сохранятся — их можно восстановить через «Удалённые поля». Бухгалтерские и исходные столбцы удалять нельзя.</p>
        <footer><button type="button" className="button secondary" onClick={()=>setDeleteField(null)}>Отмена</button>
          <button type="button" className="tech-confirm-delete" disabled={busy}
            onClick={()=>void archiveField()}>Убрать столбец</button></footer>
      </section>
    </div>}

    {showArchivedColumns && <div className="tech-text-preview-backdrop"
      onMouseDown={(event)=>{if(event.target===event.currentTarget) setShowArchivedColumns(false);}}>
      <section className="tech-text-preview tech-archived-dialog" role="dialog" aria-modal="true" aria-label="Удалённые поля">
        <header><span>Удалённые рабочие поля</span>
          <button type="button" aria-label="Закрыть" onClick={()=>setShowArchivedColumns(false)}><X size={18}/></button></header>
        <div className="tech-archived-list">
          {(activeTab?.archivedCustomColumns || []).map((field)=><div key={field.id}>
            <span>{field.title}</span>
            <button type="button" disabled={busy} onClick={()=>void restoreField(field)}>Восстановить</button>
          </div>)}
        </div>
      </section>
    </div>}

    {showNewField && <div className="tech-text-preview-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setShowNewField(false); }}>
      <section className="tech-text-preview tech-new-field-dialog" role="dialog" aria-modal="true" aria-label="Добавить рабочее поле">
        <header><span>Новое рабочее поле</span><button type="button" aria-label="Закрыть" onClick={() => setShowNewField(false)}><X size={18}/></button></header>
        <form onSubmit={(event) => void createNewField(event)}>
          <label htmlFor="tech-new-field-title">Название столбца</label>
          <input id="tech-new-field-title" value={newFieldTitle} onChange={(event) => setNewFieldTitle(event.target.value)}
            autoFocus maxLength={80} placeholder="Например, Дата следующего выезда" required />
          <p>После добавления таблица автоматически прокрутится к новому столбцу справа. Он появится у всей команды. Для удаления открой палитру его заголовка. Исходные Google-таблицы не изменятся.</p>
          <footer><button type="button" className="button secondary" onClick={() => setShowNewField(false)}>Отмена</button>
            <button className="button primary" disabled={busy || !newFieldTitle.trim()}><Plus size={16}/> Добавить</button></footer>
        </form>
      </section>
    </div>}

    {fullText && <div className="tech-text-preview-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setFullText(null); }}>
      <section className="tech-text-preview" role="dialog" aria-modal="true" aria-label={`Полный текст: ${fullText.label}`}>
        <header><span>{fullText.label}</span><button type="button" onClick={() => setFullText(null)} aria-label="Закрыть полный текст"><X size={18}/></button></header>
        <div>{fullText.text}</div>
        <footer><button className="button secondary" type="button" onClick={() => setFullText(null)}>Закрыть</button></footer>
      </section>
    </div>}

    {selected && <div className="tech-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setSelected(null); setEditing(null); setEditingCustomId(null); } }}>
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
              <p>{change.columnTitle || activeTab?.headers[change.columnIndex] || `Столбец ${change.columnIndex + 1}`}</p>
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
              {employeeFields.map((field) => <div className="tech-field" key={field.customId || field.index}>
                <small>{field.name}</small><p>{display(field.value)}</p>
                <button className="tech-edit-link" type="button" onClick={() => {
                  setEditing(field.index); setEditingCustomId(field.customId || null); setEditValue(field.value);
                }}>Изменить</button>
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
        {(editing !== null || editingCustomId !== null) && <div className="tech-editor-overlay">
          <form className="tech-editor" onSubmit={(event) => void submitEdit(event)}>
            <div className="tech-editor-head"><strong>{editingCustomId
              ? activeTab?.customColumns?.find((field) => field.id === editingCustomId)?.title || "Рабочее поле"
              : activeTab?.headers[editing as number] || "Рабочее поле"}</strong>
              <button type="button" aria-label="Закрыть редактор" onClick={() => {setEditing(null);setEditingCustomId(null);}}><X size={18}/></button></div>
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
