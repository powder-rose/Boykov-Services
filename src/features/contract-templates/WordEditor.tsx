import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type MouseEvent,
} from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  ChevronUp,
  Eye,
  FilePenLine,
  Italic,
  Minus,
  Plus,
  Redo2,
  Search,
  Underline,
  Undo2,
} from "lucide-react";
import "./WordEditor.css";

export type Block = {
  id: string;
  text: string;
  editable: boolean;
  location: string;
  fieldsAllowed: boolean;
};
type Alignment = "left" | "center" | "right" | "justify";
export type ParagraphFormat = {
  align?: Alignment;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
};
export type Change = { text: string; format?: ParagraphFormat };
export type Changes = Record<string, Change>;
type RunStyle = Omit<ParagraphFormat, "align"> & {
  fontFamily?: string;
  color?: string;
  strike?: boolean;
};
type Run = { text: string; style: RunStyle } | { image: string; width: number };
type ParagraphStyle = {
  align?: Alignment;
  before?: number;
  after?: number;
  left?: number;
  right?: number;
  firstLine?: number;
  lineHeight?: number;
  linePoints?: number;
};
type Paragraph = {
  kind: "paragraph";
  id: string | null;
  style: ParagraphStyle;
  base: RunStyle;
  runs: Run[];
  label: string;
  breakBefore: boolean;
  breakAfter: boolean;
};
type Table = {
  kind: "table";
  widths: number[];
  border: boolean;
  rows: {
    colSpan: number;
    rowSpan: number;
    fill?: string;
    nodes: Node[];
    spacer?: boolean;
    borders?: Record<"top" | "right" | "bottom" | "left", string>;
  }[][];
};
type Node = Paragraph | Table;
type Paper = {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};
export type WordLayout = {
  sections: { paper: Paper; nodes: Node[] }[];
  extras: { label: string; nodes: Node[] }[];
  images: Record<string, { src: string; width: number; height: number }>;
  warning?: string;
};
type Page = { paper: Paper; nodes: Node[]; label?: string };

const textRun = (run: Run): run is Extract<Run, { text: string }> =>
  "text" in run;
const pt = (value = 0) => `${value}pt`;
function font(style: RunStyle): CSSProperties {
  return {
    fontFamily: `${style.fontFamily || "Times New Roman"}, "Times New Roman", serif`,
    fontSize: pt(style.fontSize || 12),
    color: style.color || "#202020",
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? "italic" : "normal",
    textDecoration:
      [style.underline ? "underline" : "", style.strike ? "line-through" : ""]
        .filter(Boolean)
        .join(" ") || "none",
  };
}
function paragraphCss(p: Paragraph, format?: ParagraphFormat): CSSProperties {
  return {
    ...font({ ...p.base, ...format }),
    textAlign: format?.align || p.style.align || "left",
    marginTop: pt(p.style.before),
    marginBottom: pt(p.style.after),
    marginLeft: pt(p.style.left),
    marginRight: pt(p.style.right),
    textIndent: pt(p.style.firstLine),
    lineHeight: p.style.linePoints
      ? pt(p.style.linePoints)
      : p.style.lineHeight || 1.15,
  };
}

function estimate(
  node: Node,
  width: number,
  images: WordLayout["images"],
): number {
  if (node.kind === "table") {
    const columns = Math.max(
      1,
      node.widths.length || node.rows[0]?.length || 1,
    );
    const total = node.widths.reduce((a, b) => a + b, 0);
    return node.rows.reduce((sum, row) => {
      let column = 0;
      const heights = row.map((cell) => {
        const span = node.widths
          .slice(column, column + cell.colSpan)
          .reduce((a, b) => a + b, 0);
        column += cell.colSpan;
        const cellWidth =
          width * (total ? span / total : cell.colSpan / columns);
        return (
          cell.nodes.reduce(
            (n, item) =>
              n + estimate(item, Math.max(32, cellWidth - 8), images),
            6,
          ) / cell.rowSpan
        );
      });
      return sum + Math.max(16, ...heights);
    }, 0);
  }
  const size = Math.max(
    node.base.fontSize || 12,
    ...node.runs.filter(textRun).map((r) => r.style.fontSize || 12),
  );
  const line = node.style.linePoints || size * (node.style.lineHeight || 1.15);
  const available = Math.max(
    32,
    width - (node.style.left || 0) - (node.style.right || 0),
  );
  const chars = Math.max(5, available / (size * 0.48));
  const value = node.runs
    .filter(textRun)
    .map((r) => r.text)
    .join("");
  const lines = value
    .split("\n")
    .reduce(
      (sum, part) => sum + Math.max(1, Math.ceil(part.length / chars)),
      0,
    );
  const pictures = node.runs.reduce((sum, run) => {
    if (textRun(run)) return sum;
    const image = images[run.image];
    return (
      sum +
      (image
        ? (Math.min(available, run.width) * image.height) / image.width
        : 0)
    );
  }, 0);
  return (
    line * lines + (node.style.before || 0) + (node.style.after || 0) + pictures
  );
}

// Respect stored Word page/section breaks and approximate unseen page breaks.
// Overflow is never clipped; Word's exact printer/font layout remains authoritative.
function paginate(layout: WordLayout): Page[] {
  const pages: Page[] = [];
  for (const section of layout.sections) {
    const { paper } = section;
    const width = paper.width - paper.left - paper.right;
    const capacity = paper.height - paper.top - paper.bottom;
    let nodes: Node[] = [],
      used = 0;
    const flush = () => {
      if (nodes.length) pages.push({ paper, nodes });
      nodes = [];
      used = 0;
    };
    for (const node of section.nodes) {
      const height = estimate(node, width, layout.images);
      if (
        nodes.length &&
        ((node.kind === "paragraph" &&
          node.breakBefore &&
          used > capacity * 0.3) ||
          used + height > capacity)
      )
        flush();
      nodes.push(node);
      used += height;
      if (node.kind === "paragraph" && node.breakAfter) flush();
    }
    flush();
  }
  const standard: Paper = layout.sections[0]?.paper || {
    width: 595,
    height: 842,
    top: 42,
    bottom: 42,
    left: 42,
    right: 42,
  };
  for (const extra of layout.extras)
    pages.push({ paper: standard, nodes: extra.nodes, label: extra.label });
  return pages;
}

function Highlight({ value, show }: { value: string; show: boolean }) {
  if (!show) return value;
  return (
    <>
      {value.split(/(autozamena_\d{3}(?!\d))/gi).map((part, i) =>
        /^autozamena_\d{3}$/i.test(part) ? (
          <mark className="we-field" key={i}>
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function displayRuns(p: Paragraph, change?: Change): Run[] {
  if (!change) return p.runs;
  const parts = p.runs.filter(textRun);
  const original = parts.map((r) => r.text).join("");
  // Keep existing text run styles around the changed range. The authoritative
  // preview is rebuilt on the worker using the same XML edit as publication.
  if (original === change.text)
    return p.runs.map((r) =>
      textRun(r) ? { ...r, style: { ...r.style, ...change.format } } : r,
    );
  let left = 0,
    right = 0;
  while (
    left < Math.min(original.length, change.text.length) &&
    original[left] === change.text[left]
  )
    left++;
  while (
    right < Math.min(original.length, change.text.length) - left &&
    original[original.length - 1 - right] ===
      change.text[change.text.length - 1 - right]
  )
    right++;
  let offset = 0,
    inserted = false;
  const result: Run[] = [];
  const addition = change.text.slice(left, change.text.length - right);
  for (const part of parts) {
    const start = offset,
      end = offset + part.text.length;
    const style = { ...part.style, ...change.format };
    if (start < left)
      result.push({
        text: part.text.slice(0, Math.min(part.text.length, left - start)),
        style,
      });
    if (!inserted && end >= left) {
      if (addition) result.push({ text: addition, style });
      inserted = true;
    }
    if (end > original.length - right)
      result.push({
        text: part.text.slice(Math.max(0, original.length - right - start)),
        style,
      });
    offset = end;
  }
  if (!inserted && addition)
    result.push({ text: addition, style: { ...p.base, ...change.format } });
  return result;
}

type Props = {
  layout: WordLayout;
  blocks: Block[];
  changes: Changes;
  selected: string | null;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onSelect: (id: string | null) => void;
  onText: (block: Block, text: string) => void;
  onFormat: (block: Block, format: ParagraphFormat) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  preview: boolean;
  onPreview: () => void;
  onEdit: () => void;
  canEdit: boolean;
  busy: boolean;
  onResetParagraph: (block: Block) => void;
};

export default function WordEditor(props: Props) {
  const {
    layout,
    blocks,
    changes,
    selected,
    textarea,
    preview,
    busy,
    canEdit,
  } = props;
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState(-1);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [viewportWidth, setViewportWidth] = useState(700);
  const [page, setPage] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const pages = useMemo(() => paginate(layout), [layout]);
  const maxWidth = (Math.max(595, ...pages.map((p) => p.paper.width)) * 4) / 3;
  const scale =
    zoom === "fit"
      ? Math.max(0.4, Math.min(1, (viewportWidth - 40) / maxWidth))
      : zoom / 100;
  const map = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);
  const selectedBlock = selected ? map.get(selected) : undefined;
  const selectedParagraph = useMemo(() => {
    function find(nodes: Node[]): Paragraph | undefined {
      for (const n of nodes) {
        if (n.kind === "paragraph" && n.id === selected) return n;
        if (n.kind === "table")
          for (const row of n.rows)
            for (const cell of row) {
              const result = find(cell.nodes);
              if (result) return result;
            }
      }
    }
    return selected
      ? find([...layout.sections, ...layout.extras].flatMap((s) => s.nodes))
      : undefined;
  }, [selected, layout]);
  const selectedChange = selected ? changes[selected] : undefined;
  const selectedStyle = {
    ...selectedParagraph?.base,
    ...selectedParagraph?.runs.find(textRun)?.style,
    ...selectedChange?.format,
  };
  const align =
    selectedChange?.format?.align || selectedParagraph?.style.align || "left";
  const editable = Boolean(
    canEdit && !preview && !busy && selectedBlock?.editable,
  );
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ru");
    return needle
      ? blocks.filter((b) =>
          (changes[b.id]?.text ?? b.text)
            .toLocaleLowerCase("ru")
            .includes(needle),
        )
      : [];
  }, [query, blocks, changes]);
  const matchIds = useMemo(() => new Set(matches.map((b) => b.id)), [matches]);
  const pageNumber = Math.min(page, Math.max(0, pages.length - 1));

  useEffect(() => {
    if (!viewport.current) return;
    const element = viewport.current;
    const observer = new ResizeObserver(() =>
      setViewportWidth(element.clientWidth),
    );
    observer.observe(element);
    setViewportWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (el) {
      el.style.height = "0px";
      el.style.height = `${Math.max(18, el.scrollHeight)}px`;
    }
  }, [textarea, selected, selectedChange, scale, preview]);

  function gotoPage(index: number) {
    const el = document.getElementById(`we-page-${index}`);
    if (el && viewport.current) {
      viewport.current.scrollTop +=
        el.getBoundingClientRect().top -
        viewport.current.getBoundingClientRect().top -
        18;
      setPage(index);
    }
  }
  function gotoMatch(index: number) {
    if (!matches.length) return;
    const next = ((index % matches.length) + matches.length) % matches.length;
    setMatch(next);
    const el = document.getElementById(`we-block-${matches[next].id}`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function activate(block: Block, start?: number, end?: number) {
    if (!canEdit || preview || busy || !block.editable) return;
    props.onSelect(block.id);
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (el) {
        el.focus({ preventScroll: true });
        el.setSelectionRange(
          start ?? el.value.length,
          end ?? start ?? el.value.length,
        );
      }
    });
  }
  function editAt(e: MouseEvent<HTMLDivElement>, block: Block) {
    const root = e.currentTarget;
    const offset = (node: globalThis.Node, index: number) => {
      const range = document.createRange();
      range.setStart(root, 0);
      range.setEnd(node, index);
      return range.toString().length;
    };
    const selection = window.getSelection();
    if (selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (
        root.contains(range.startContainer) &&
        root.contains(range.endContainer)
      ) {
        activate(
          block,
          offset(range.startContainer, range.startOffset),
          offset(range.endContainer, range.endOffset),
        );
        return;
      }
    }
    const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    activate(
      block,
      caret && root.contains(caret.startContainer)
        ? offset(caret.startContainer, caret.startOffset)
        : undefined,
    );
  }
  function format(value: ParagraphFormat) {
    if (editable && selectedBlock) {
      props.onFormat(selectedBlock, value);
      requestAnimationFrame(() =>
        textarea.current?.focus({ preventScroll: true }),
      );
    }
  }
  function render(nodes: Node[], path: string) {
    return nodes.map((node, index) => {
      const key = `${path}-${index}`;
      if (node.kind === "table") {
        const total = node.widths.reduce((a, b) => a + b, 0);
        return (
          <table
            key={key}
            className={`we-table ${node.border ? "" : "borderless"}`}
          >
            {total > 0 && (
              <colgroup>
                {node.widths.map((w, i) => (
                  <col key={i} style={{ width: `${(w / total) * 100}%` }} />
                ))}
              </colgroup>
            )}
            <tbody>
              {node.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((c, j) => (
                    <td
                      key={j}
                      colSpan={c.colSpan}
                      rowSpan={c.rowSpan}
                      className={c.spacer ? "we-spacer" : undefined}
                      style={{
                        backgroundColor: c.fill,
                        borderTop: c.borders?.top,
                        borderRight: c.borders?.right,
                        borderBottom: c.borders?.bottom,
                        borderLeft: c.borders?.left,
                      }}
                    >
                      {render(c.nodes, `${key}-${i}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
      const block = node.id ? map.get(node.id) : undefined;
      const change = !preview && node.id ? changes[node.id] : undefined;
      const current = change?.text ?? block?.text ?? "";
      const editing =
        !preview && canEdit && block?.editable && selected === block.id;
      const interactive = Boolean(
        !preview && canEdit && block?.editable && !busy,
      );
      const css = paragraphCss(node, change?.format);
      const runs = displayRuns(node, change);
      const klass = `we-paragraph${interactive ? " editable" : ""}${editing ? " active" : ""}${change ? " modified" : ""}${node.id && matchIds.has(node.id) ? " search-hit" : ""}`;
      return (
        <div
          key={key}
          id={block ? `we-block-${block.id}` : undefined}
          className={klass}
          style={css}
        >
          {node.label && <span className="we-list-label">{node.label} </span>}
          {editing && block ? (
            <textarea
              ref={textarea}
              className="we-inline-input"
              rows={1}
              aria-label="Текст выбранного абзаца"
              value={current}
              maxLength={8000}
              disabled={busy}
              style={{
                ...font({
                  ...node.base,
                  ...node.runs.find(textRun)?.style,
                  ...change?.format,
                }),
                textAlign: css.textAlign,
                lineHeight: css.lineHeight,
                textIndent: css.textIndent,
              }}
              onChange={(e) =>
                props.onText(block, e.target.value.replace(/[\r\n\t]/g, " "))
              }
              onKeyDown={(e) => {
                if (e.key === "Escape" || e.key === "Enter") {
                  e.preventDefault();
                  props.onSelect(null);
                }
              }}
            />
          ) : (
            <div
              className="we-run-line"
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              title={
                interactive
                  ? "Нажмите, чтобы редактировать"
                  : block && !block.editable && !preview
                    ? "Сложный элемент Word — защищён"
                    : undefined
              }
              onClick={
                interactive && block ? (e) => editAt(e, block) : undefined
              }
              onKeyDown={
                interactive && block
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        activate(block);
                      }
                    }
                  : undefined
              }
            >
              {runs.map((r, i) =>
                textRun(r) ? (
                  <span key={i} style={font(r.style)}>
                    <Highlight value={r.text} show={!preview} />
                  </span>
                ) : layout.images[r.image] ? (
                  <img
                    key={i}
                    src={layout.images[r.image].src}
                    alt="Изображение документа"
                    style={{ width: pt(r.width) }}
                  />
                ) : null,
              )}
              {!runs.length && "\u00a0"}
            </div>
          )}
        </div>
      );
    });
  }
  const icon = (
    label: string,
    Icon: typeof Bold,
    action: () => void,
    disabled: boolean,
    pressed?: boolean,
  ) => (
    <button
      type="button"
      className={`we-tool${pressed ? " pressed" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={action}
    >
      <Icon size={17} strokeWidth={1.8} />
    </button>
  );

  return (
    <section className="panel we-workspace">
      <div className="we-titlebar">
        <div>
          <span className="eyebrow">РАБОЧИЙ ДОКУМЕНТ / WORD</span>
          <h3>{preview ? "Предварительный просмотр" : "Редактор договора"}</h3>
        </div>
        <div className="we-view-switch">
          {canEdit && (
            <button
              type="button"
              aria-pressed={!preview}
              className={!preview ? "selected" : ""}
              onClick={props.onEdit}
              disabled={busy}
            >
              <FilePenLine size={16} /> Правка
            </button>
          )}
          <button
            type="button"
            aria-pressed={preview}
            className={preview ? "selected" : ""}
            onClick={props.onPreview}
            disabled={busy}
          >
            <Eye size={16} /> Предпросмотр
          </button>
        </div>
      </div>
      {!preview && (
        <div className="we-ribbon" aria-label="Панель форматирования абзаца">
          <div className="we-tools">
            {icon(
              "Отменить (Ctrl+Z)",
              Undo2,
              props.onUndo,
              !props.canUndo || busy,
            )}
            {icon(
              "Повторить (Ctrl+Y)",
              Redo2,
              props.onRedo,
              !props.canRedo || busy,
            )}
          </div>
          <div className="we-tools">
            {icon(
              "Полужирный абзац",
              Bold,
              () => format({ bold: !selectedStyle.bold }),
              !editable,
              Boolean(selectedStyle.bold),
            )}
            {icon(
              "Курсив абзаца",
              Italic,
              () => format({ italic: !selectedStyle.italic }),
              !editable,
              Boolean(selectedStyle.italic),
            )}
            {icon(
              "Подчёркнутый абзац",
              Underline,
              () => format({ underline: !selectedStyle.underline }),
              !editable,
              Boolean(selectedStyle.underline),
            )}
            <label className="we-size" title="Размер шрифта абзаца">
              <select
                aria-label="Размер шрифта абзаца"
                disabled={!editable}
                value={
                  selectedStyle.fontSize &&
                  Number.isInteger(selectedStyle.fontSize) &&
                  selectedStyle.fontSize >= 8 &&
                  selectedStyle.fontSize <= 36
                    ? selectedStyle.fontSize
                    : ""
                }
                onChange={(e) => format({ fontSize: Number(e.target.value) })}
              >
                <option value="" disabled>
                  Размер
                </option>
                {Array.from({ length: 29 }, (_, i) => i + 8).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span>пт</span>
            </label>
          </div>
          <div className="we-tools">
            {icon(
              "По левому краю",
              AlignLeft,
              () => format({ align: "left" }),
              !editable,
              align === "left",
            )}
            {icon(
              "По центру",
              AlignCenter,
              () => format({ align: "center" }),
              !editable,
              align === "center",
            )}
            {icon(
              "По правому краю",
              AlignRight,
              () => format({ align: "right" }),
              !editable,
              align === "right",
            )}
            {icon(
              "По ширине",
              AlignJustify,
              () => format({ align: "justify" }),
              !editable,
              align === "justify",
            )}
          </div>
          <div className="we-tools we-format-status">
            {selectedBlock ? (
              <>
                <span>Формат абзаца</span>
                {selectedChange && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => props.onResetParagraph(selectedBlock)}
                  >
                    Сбросить
                  </button>
                )}
              </>
            ) : (
              <span>Выберите абзац на листе</span>
            )}
          </div>
        </div>
      )}
      <div className="we-navigation">
        <label className="we-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMatch(-1);
            }}
            placeholder="Найти в документе…"
            aria-label="Поиск в документе"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                gotoMatch(
                  e.shiftKey ? (match < 0 ? -1 : match - 1) : match + 1,
                );
              }
            }}
          />
        </label>
        {query.trim() && (
          <div className="we-match">
            <span>
              {matches.length
                ? match < 0
                  ? `Найдено: ${matches.length}`
                  : `${Math.min(match + 1, matches.length)} из ${matches.length}`
                : "Нет совпадений"}
            </span>
            {icon(
              "Предыдущее совпадение",
              ChevronUp,
              () => gotoMatch(match < 0 ? -1 : match - 1),
              !matches.length,
            )}
            {icon(
              "Следующее совпадение",
              ChevronDown,
              () => gotoMatch(match + 1),
              !matches.length,
            )}
          </div>
        )}
        <div className="we-zoom">
          {icon(
            "Уменьшить",
            Minus,
            () => setZoom(Math.max(40, Math.round(scale * 100) - 10)),
            scale <= 0.4,
          )}
          <button
            className="we-fit"
            type="button"
            title="Подогнать под ширину"
            onClick={() => setZoom("fit")}
          >
            {zoom === "fit" ? "По ширине" : `${zoom}%`}
          </button>
          {icon(
            "Увеличить",
            Plus,
            () => setZoom(Math.min(150, Math.round(scale * 100) + 10)),
            scale >= 1.5,
          )}
        </div>
        <label className="we-page-jump">
          <span>Лист</span>
          <select
            aria-label="Перейти к листу"
            value={pageNumber}
            onChange={(e) => gotoPage(Number(e.target.value))}
          >
            {pages.map((p, i) => (
              <option key={i} value={i}>
                {i + 1}
                {p.label ? ` · ${p.label}` : ""}
              </option>
            ))}
          </select>
          <span> / {pages.length}</span>
        </label>
      </div>
      <div
        className="we-viewport"
        ref={viewport}
        onScroll={() => {
          const root = viewport.current;
          if (!root) return;
          const top = root.getBoundingClientRect().top;
          const nodes = Array.from(
            root.querySelectorAll<HTMLElement>(".we-page"),
          );
          const i = nodes.findIndex(
            (el) => el.getBoundingClientRect().bottom > top + 80,
          );
          if (i >= 0) setPage(i);
        }}
        onKeyDown={(e) => {
          if (!preview && (e.ctrlKey || e.metaKey) && !e.altKey) {
            if (e.key.toLowerCase() === "z") {
              e.preventDefault();
              if (e.shiftKey) props.onRedo();
              else props.onUndo();
            } else if (e.key.toLowerCase() === "y") {
              e.preventDefault();
              props.onRedo();
            }
          }
        }}
      >
        {pages.map((p, i) => (
          <div className="we-page-wrap" id={`we-page-${i}`} key={i}>
            <div className="we-page-label">
              {p.label || `ЛИСТ ${String(i + 1).padStart(2, "0")}`}{" "}
              <span>
                {Math.round((p.paper.width / 72) * 25.4)} ×{" "}
                {Math.round((p.paper.height / 72) * 25.4)} мм
              </span>
            </div>
            <article
              className="we-page"
              style={{
                width: pt(p.paper.width),
                minHeight: pt(p.paper.height),
                padding: `${pt(p.paper.top)} ${pt(p.paper.right)} ${pt(p.paper.bottom)} ${pt(p.paper.left)}`,
                zoom: scale,
              }}
            >
              {render(p.nodes, `page-${i}`)}
            </article>
          </div>
        ))}
        {!pages.length && (
          <div className="we-empty">
            {layout.warning || "В документе нет текста для просмотра."}
          </div>
        )}
      </div>
      <div className="we-status">
        <span>
          {preview
            ? "Чистый вид · макрос и служебная таблица скрыты"
            : "Щёлкните по тексту, чтобы править. Enter — завершить абзац."}
        </span>
        <span>Разбиение на листы приблизительное</span>
      </div>
    </section>
  );
}
