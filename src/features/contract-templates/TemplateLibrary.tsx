import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FilePenLine,
  FileText,
  History,
  Layers3,
  LockKeyhole,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { api, dateTime, errorText, post } from "../../api";
import { Loading, Notice, TitleDot } from "../../components/Common";
import "./TemplateLibrary.css";

export type TemplateVersion = {
  version: number;
  publishedAt: string;
  author: string;
  source: "initial" | "edit" | "upload" | "restore";
  note: string;
  size: number;
  sha256: string;
};
export type TemplateSummary = {
  id: string;
  label: string;
  company: string;
  description: string;
  active: TemplateVersion;
  versions: number;
};
export type TemplateCatalog = {
  templates: TemplateSummary[];
  canEdit: boolean;
};
type Block = {
  id: string;
  text: string;
  editable: boolean;
  location: string;
  fieldsAllowed: boolean;
};
type Field = {
  key: string;
  label: string;
  required: boolean;
  present: boolean;
};
type Editor = {
  template: TemplateSummary;
  active: TemplateVersion;
  draft: { id: string; filename: string; createdAt: string } | null;
  staleDraft: boolean;
  blocks: Block[];
  fields: Field[];
  problems: string[];
};
type HistoryData = { activeVersion: number; versions: TemplateVersion[] };
const base = "/contracts/templates";
const PAGE_SIZE = 18;
const sources: Record<TemplateVersion["source"], string> = {
  initial: "Исходная версия",
  edit: "Редактирование на сайте",
  upload: "Загрузка файла",
  restore: "Восстановление",
};
const versionFile = (id: string, version: number, format = "docm") =>
  `/api${base}/${id}/files/${version}?format=${format}`;

function ActiveBadge({ version }: { version: number }) {
  return (
    <span className="tl-active">
      <CheckCircle2 size={13} /> v{version} · Активен
    </span>
  );
}

export default function TemplateLibrary({
  catalog,
  reload,
}: {
  catalog: TemplateCatalog | null;
  reload: () => Promise<void>;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const item = catalog?.templates.find((t) => t.id === opened);
  if (item)
    return (
      <EditorWorkspace
        key={item.id}
        item={item}
        canEdit={Boolean(catalog?.canEdit)}
        reload={reload}
        onBack={() => setOpened(null)}
      />
    );
  return (
    <div className="tl-library">
      <section className="tl-hero">
        <div>
          <div className="eyebrow">ЕДИНАЯ БИБЛИОТЕКА / BOYKOV SERVICES</div>
          <h2>
            Один шаблон.
            <br />
            Одна актуальная версия
            <TitleDot />
          </h2>
          <p>
            Редактируйте условия договоров, обновляйте файлы Word и публикуйте
            изменения для всей команды. Новые документы используют только
            активную версию.
          </p>
          <span className="tl-hero-badge">
            <ShieldCheck size={16} /> Макрос и история сохраняются
          </span>
        </div>
        <div className="tl-illustration" aria-hidden="true">
          <div className="tl-sheet tl-sheet-back" />
          <div className="tl-sheet tl-sheet-front">
            <FileText size={29} strokeWidth={1.5} />
            <span />
            <span />
            <span />
            <span />
            <div className="tl-sheet-seal">
              <Check size={24} strokeWidth={2.3} />
            </div>
          </div>
          <div className="tl-illustration-caption">
            <Layers3 size={15} /> Версии под контролем
          </div>
        </div>
      </section>
      <div className="tl-section-heading">
        <div>
          <span className="eyebrow">БИБЛИОТЕКА ДОКУМЕНТОВ</span>
          <h2>
            Шаблоны договоров
            <TitleDot />
          </h2>
        </div>
        <span className="tl-count">
          {catalog?.templates.length ?? "—"} шаблонов
        </span>
      </div>
      {!catalog ? (
        <Notice>
          Не удалось загрузить библиотеку.{" "}
          <button className="text-button" onClick={() => void reload()}>
            Повторить
          </button>
        </Notice>
      ) : (
        <>
          {!catalog.canEdit && (
            <Notice tone="info">
              В общем доступе доступны просмотр, история и скачивание. Для
              редактирования войдите в личный аккаунт.
            </Notice>
          )}
          <div className="tl-card-grid">
            {catalog.templates.map((t) => (
              <article className="panel tl-card" key={t.id}>
                <div className="tl-card-top">
                  <span
                    className={
                      "tl-card-icon " +
                      (t.company.includes("ЭНЕРГО") ? "tl-energy" : "")
                    }
                  >
                    <FileText size={23} strokeWidth={1.6} />
                  </span>
                  <ActiveBadge version={t.active.version} />
                </div>
                <span className="tl-company">{t.company}</span>
                <h3>{t.label}</h3>
                <p>{t.description}</p>
                <div className="tl-version-info">
                  <span>Обновлён {dateTime(t.active.publishedAt, true)}</span>
                  <strong>{t.active.author}</strong>
                </div>
                <div className="tl-card-actions">
                  <button
                    className="button primary"
                    onClick={() => setOpened(t.id)}
                  >
                    {catalog.canEdit ? (
                      <FilePenLine size={16} />
                    ) : (
                      <History size={16} />
                    )}
                    {catalog.canEdit ? "Редактировать" : "История версий"}
                  </button>
                  <a
                    className="button secondary tl-download-icon"
                    href={versionFile(t.id, t.active.version)}
                    title="Скачать активный шаблон DOCM"
                    aria-label={`Скачать ${t.label} DOCM`}
                  >
                    <ArrowDownToLine size={18} />
                  </a>
                </div>
              </article>
            ))}
          </div>
          <p className="tl-note">
            <ShieldCheck size={17} /> История публикаций хранится на сервере
            отдельно от кода сайта. Загруженные файлы вступают в силу после
            проверки и публикации.
          </p>
        </>
      )}
    </div>
  );
}

function Highlighted({ text }: { text: string }) {
  return (
    <>
      {text.split(/(autozamena_\d{3})/gi).map((part, i) =>
        /^autozamena_\d{3}$/i.test(part) ? (
          <mark key={i} className="tl-field-mark">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function EditorWorkspace({
  item,
  canEdit,
  reload,
  onBack,
}: {
  item: TemplateSummary;
  canEdit: boolean;
  reload: () => Promise<void>;
  onBack: () => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [tab, setTab] = useState<"text" | "history">(
    canEdit ? "text" : "history",
  );
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [fieldQuery, setFieldQuery] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<number | "publish" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const active = editor?.active ?? item.active;
  const latestVersion = Math.max(
    active.version,
    item.active.version,
    history?.activeVersion ?? 0,
  );
  const newerVersion = latestVersion > active.version;
  const endpoint = base + "/" + item.id;
  const changedCount = Object.keys(changes).length;
  const draft = editor?.draft && !editor.staleDraft ? editor.draft : null;

  async function fetchState() {
    const [newHistory, newEditor] = await Promise.all([
      api<HistoryData>(endpoint + "/history"),
      canEdit ? api<Editor>(endpoint + "/editor") : Promise.resolve(null),
    ]);
    setHistory(newHistory);
    setEditor(newEditor);
    setChanges({});
    setSelected(null);
    setPage(0);
    setQuery("");
  }
  async function reloadEditor() {
    if (
      changedCount &&
      !window.confirm("Перезагрузить шаблон без сохранения правок?")
    )
      return;
    setBusy(true);
    setError("");
    try {
      await reload();
      await fetchState();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<HistoryData>(endpoint + "/history"),
      canEdit ? api<Editor>(endpoint + "/editor") : Promise.resolve(null),
    ])
      .then(([h, e]) => {
        if (!cancelled) {
          setHistory(h);
          setEditor(e);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, canEdit]);
  useEffect(() => {
    if (!changedCount) return;
    const listener = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [changedCount]);
  useEffect(() => {
    if (confirm !== null && !modal.current?.open) modal.current?.showModal();
    if (confirm === null && modal.current?.open) modal.current.close();
  }, [confirm]);
  const validTags = useMemo(
    () =>
      new Set(
        (editor?.blocks ?? [])
          .filter((block) => block.id.startsWith("word/document.xml#"))
          .flatMap(
            (block) =>
              (changes[block.id] ?? block.text).match(
                /autozamena_\d{3}(?!\d)/gi,
              ) || [],
          ),
      ),
    [editor, changes],
  );
  const missing =
    editor?.fields.filter((f) => f.required && !validTags.has(f.key)) || [];
  const requiredCount = editor?.fields.filter((f) => f.required).length || 0;
  const otherProblems =
    editor?.problems.filter(
      (problem) => !problem.startsWith("Не подключены обязательные поля"),
    ) || [];
  const selectedBlock = editor?.blocks.find((b) => b.id === selected);
  const needle = query.toLocaleLowerCase("ru").trim();
  const filteredBlocks = (editor?.blocks ?? []).filter(
    (block) =>
      !needle ||
      block.id === selected ||
      block.text.toLocaleLowerCase("ru").includes(needle) ||
      (changes[block.id] ?? "").toLocaleLowerCase("ru").includes(needle),
  );
  const pages = Math.max(1, Math.ceil(filteredBlocks.length / PAGE_SIZE));
  const pageIndex = Math.min(page, pages - 1);
  const visibleBlocks = filteredBlocks.slice(
    pageIndex * PAGE_SIZE,
    (pageIndex + 1) * PAGE_SIZE,
  );
  const filteredFields = (editor?.fields ?? []).filter((f) =>
    (f.label + " " + f.key)
      .toLocaleLowerCase("ru")
      .includes(fieldQuery.toLocaleLowerCase("ru").trim()),
  );

  function updateBlock(block: Block, value: string) {
    setChanges((previous) => {
      const next = { ...previous };
      if (value === block.text) delete next[block.id];
      else next[block.id] = value;
      return next;
    });
  }
  function insertField(field: Field) {
    if (!selectedBlock || !selectedBlock.fieldsAllowed || busy) return;
    const content = changes[selectedBlock.id] ?? selectedBlock.text;
    const start = textarea.current?.selectionStart ?? content.length;
    const end = textarea.current?.selectionEnd ?? start;
    updateBlock(
      selectedBlock,
      content.slice(0, start) + field.key + content.slice(end),
    );
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(
        start + field.key.length,
        start + field.key.length,
      );
    });
  }
  async function upload(file: File) {
    if (file.size > 20 * 1024 * 1024) {
      setError("Файл должен быть не больше 20 МБ.");
      return;
    }
    if (
      (changedCount || editor?.draft) &&
      !window.confirm(
        "Заменить текущий черновик? Несохранённые изменения будут сброшены.",
      )
    )
      return;
    const form = new FormData();
    form.set("file", file);
    form.set("expectedVersion", String(active.version));
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const draftEditor = await api<Editor>(endpoint + "/draft", {
        method: "POST",
        body: form,
      });
      setEditor(draftEditor);
      setChanges({});
      setSelected(null);
      setPage(0);
      setQuery("");
      setTab("text");
      setMessage(
        file.name.toLowerCase().endsWith(".docm")
          ? "Файл подготовлен. Старые макросы заменены на встроенную автозамену. Проверьте поля и опубликуйте."
          : "Файл подготовлен. Встроенный макрос и таблица автозамен добавлены. Проверьте поля и опубликуйте.",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function discard() {
    if (!window.confirm("Сбросить черновик и открыть активный шаблон?")) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setEditor(await post<Editor>(endpoint + "/discard", {}));
      setChanges({});
      setSelected(null);
      setQuery("");
      setPage(0);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (confirm === null) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result =
        confirm === "publish"
          ? await post<{ active: TemplateVersion }>(endpoint + "/publish", {
              expectedVersion: active.version,
              draftId: draft?.id ?? null,
              changes: Object.entries(changes).map(([id, text]) => ({
                id,
                text,
              })),
              note,
            })
          : await post<{ active: TemplateVersion }>(endpoint + "/restore", {
              expectedVersion: history?.activeVersion ?? active.version,
              version: confirm,
            });
      setConfirm(null);
      setNote("");
      setMessage(
        `Версия v${result.active.version} опубликована. Она используется при создании новых договоров.`,
      );
      setChanges({});
      await reload();
      await fetchState();
    } catch (e) {
      setError(errorText(e));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }
  function back() {
    if (
      !changedCount ||
      window.confirm("Выйти без сохранения внесённых изменений?")
    )
      onBack();
  }
  const canPublish = Boolean(
    editor &&
    (draft || changedCount) &&
    !editor.staleDraft &&
    !newerVersion &&
    !missing.length &&
    !busy,
  );
  return (
    <div className="tl-workspace">
      <div className="tl-editor-top">
        <button className="tl-back text-button" onClick={back} disabled={busy}>
          <ChevronLeft size={18} /> Все шаблоны
        </button>
        <ActiveBadge version={latestVersion} />
      </div>
      <section className="panel tl-editor-header">
        <div className="tl-editor-label">
          <span className="tl-card-icon">
            <FilePenLine size={24} strokeWidth={1.6} />
          </span>
          <div>
            <span className="eyebrow">{item.company}</span>
            <h2>
              {item.label}
              <TitleDot />
            </h2>
            <p>
              {draft
                ? "Черновик из файла · " + draft.filename
                : "Изменения вступают в силу после публикации."}
            </p>
          </div>
        </div>
        <div className="tl-editor-actions">
          <a
            className="button secondary"
            href={versionFile(item.id, active.version, "docx")}
          >
            <ArrowDownToLine size={16} /> DOCX для правок
          </a>
          {canEdit && (
            <>
              <input
                ref={fileInput}
                hidden
                type="file"
                accept=".docx,.docm"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void upload(file);
                }}
              />
              <button
                className="button secondary"
                disabled={busy || !editor || newerVersion}
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={16} /> Загрузить версию
              </button>
              <button
                className="button primary"
                disabled={!canPublish}
                onClick={() => setConfirm("publish")}
              >
                <Check size={17} /> Опубликовать
              </button>
            </>
          )}
        </div>
      </section>
      {error && (
        <Notice tone="error">
          {error}{" "}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void reloadEditor()}
          >
            Обновить данные
          </button>
        </Notice>
      )}
      {message && <Notice tone="info">{message}</Notice>}
      {newerVersion && (
        <Notice>
          Другой сотрудник опубликовал версию v{latestVersion}. Перед изменением
          откройте актуальный шаблон. Ваши правки пока сохранены в редакторе.{" "}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void reloadEditor()}
          >
            Открыть актуальную версию
          </button>
        </Notice>
      )}
      {editor?.staleDraft && (
        <Notice>
          Черновик относится к предыдущей версии. Сбросьте его или загрузите
          новую версию файла.{" "}
          <button
            className="text-button"
            onClick={() => void discard()}
            disabled={busy}
          >
            Сбросить черновик
          </button>
        </Notice>
      )}
      <div className="tl-tabs" aria-label="Работа с шаблоном">
        {canEdit && (
          <button
            aria-pressed={tab === "text"}
            className={tab === "text" ? "selected" : ""}
            onClick={() => setTab("text")}
          >
            <BookOpen size={16} /> Текст и поля
          </button>
        )}
        <button
          aria-pressed={tab === "history"}
          className={tab === "history" ? "selected" : ""}
          onClick={() => setTab("history")}
        >
          <History size={16} /> История версий{" "}
          <span>{history?.versions.length ?? item.versions}</span>
        </button>
        <span className="tl-tab-status">
          {changedCount
            ? `Изменено абзацев: ${changedCount}`
            : draft
              ? "Загруженный черновик"
              : "Активная версия"}
        </span>
      </div>
      {loading ? (
        <Loading />
      ) : tab === "history" ? (
        <section className="panel tl-history">
          <div className="tl-section-heading">
            <div>
              <span className="eyebrow">ЖУРНАЛ ПУБЛИКАЦИЙ</span>
              <h2>
                История версий
                <TitleDot />
              </h2>
            </div>
            <span className="tl-count">
              {history?.versions.length ?? 0} версий
            </span>
          </div>
          <p>
            Каждая опубликованная версия сохраняется. Восстановление создаёт
            новую активную версию, не удаляя более поздние.
          </p>
          {history?.versions.map((v) => (
            <div className="tl-history-row" key={v.version}>
              <div className="tl-history-version">v{v.version}</div>
              <div className="tl-history-description">
                <strong>{v.note || sources[v.source]}</strong>
                <span>
                  {v.author} · {dateTime(v.publishedAt, true)} ·{" "}
                  {sources[v.source]}
                </span>
                {v.version === history.activeVersion && (
                  <ActiveBadge version={v.version} />
                )}
              </div>
              <div className="tl-history-actions">
                <a
                  className="button secondary"
                  href={versionFile(item.id, v.version)}
                >
                  <ArrowDownToLine size={15} /> DOCM
                </a>
                {canEdit && v.version !== history.activeVersion && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setConfirm(v.version)}
                  >
                    <RotateCcw size={15} /> Восстановить
                  </button>
                )}
              </div>
            </div>
          ))}
        </section>
      ) : (
        editor && (
          <>
            <div className="tl-macro-banner">
              <div className="tl-macro-icon">
                <ShieldCheck size={24} strokeWidth={1.6} />
              </div>
              <div>
                <strong>Автозамена подключена</strong>
                <p>
                  Кнопка запуска и служебная таблица защищены. Изменяйте только
                  текст договора и используйте готовые поля. При загрузке DOCM
                  старые макросы автоматически заменяются на встроенные.
                </p>
              </div>
              {(draft || changedCount > 0) && (
                <button
                  className="text-button"
                  onClick={() => void discard()}
                  disabled={busy}
                >
                  Сбросить
                </button>
              )}
            </div>
            {otherProblems.length > 0 && (
              <Notice>
                {otherProblems.map((p) => (
                  <div key={p}>{p}</div>
                ))}
              </Notice>
            )}
            <div className="tl-editor-grid">
              <section className="panel tl-document">
                <div className="tl-document-header">
                  <div>
                    <h3>Текст документа</h3>
                    <p>
                      Выберите абзац или ячейку. Оформление Word сохраняется.
                    </p>
                  </div>
                  <label className="tl-search">
                    <Search size={17} />
                    <input
                      value={query}
                      placeholder="Найти текст…"
                      aria-label="Найти текст в шаблоне"
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setPage(0);
                        setSelected(null);
                      }}
                    />
                  </label>
                </div>
                <div className="tl-paper">
                  <div className="tl-paper-meta">
                    <span>WORD / ТЕКСТОВЫЙ РЕЖИМ</span>
                    <span>{filteredBlocks.length} блоков</span>
                  </div>
                  {visibleBlocks.length ? (
                    visibleBlocks.map((block) => {
                      const current = changes[block.id] ?? block.text;
                      const editing = selected === block.id && block.editable;
                      return (
                        <div
                          key={block.id}
                          className={`tl-block ${editing ? "editing" : ""} ${changes[block.id] !== undefined ? "modified" : ""}`}
                        >
                          <div className="tl-block-label">
                            <span>{block.location}</span>
                            {!block.editable ? (
                              <span title="Сложный элемент Word">
                                <LockKeyhole size={12} /> Только Word
                              </span>
                            ) : changes[block.id] !== undefined ? (
                              <span>Изменён</span>
                            ) : null}
                          </div>
                          {editing ? (
                            <textarea
                              ref={textarea}
                              className="tl-edit-area"
                              aria-label="Текст выбранного абзаца"
                              value={current}
                              rows={Math.max(
                                3,
                                Math.min(11, Math.ceil(current.length / 75)),
                              )}
                              maxLength={8000}
                              disabled={busy}
                              onChange={(e) =>
                                updateBlock(
                                  block,
                                  e.target.value.replace(/[\r\n\t]/g, " "),
                                )
                              }
                            />
                          ) : (
                            <button
                              type="button"
                              disabled={!block.editable || busy}
                              className="tl-paragraph"
                              onClick={() => {
                                setSelected(block.id);
                                requestAnimationFrame(() =>
                                  textarea.current?.focus(),
                                );
                              }}
                            >
                              <span>
                                <Highlighted text={current || "Пустой абзац"} />
                              </span>
                              {block.editable && <FilePenLine size={15} />}
                            </button>
                          )}
                          {editing && (
                            <div className="tl-block-actions">
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={() => updateBlock(block, block.text)}
                              >
                                Отменить правку
                              </button>
                              <button
                                className="text-button"
                                onClick={() => setSelected(null)}
                              >
                                <Check size={14} /> Готово
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <div className="tl-no-results">
                      По этому запросу ничего не найдено.
                    </div>
                  )}
                </div>
                <div className="tl-pagination">
                  <button
                    className="button secondary compact"
                    disabled={pageIndex === 0}
                    onClick={() => {
                      setPage(pageIndex - 1);
                      setSelected(null);
                    }}
                  >
                    <ChevronLeft size={16} /> Назад
                  </button>
                  <span>
                    {pageIndex + 1} из {pages}
                  </span>
                  <button
                    className="button secondary compact"
                    disabled={pageIndex + 1 >= pages}
                    onClick={() => {
                      setPage(pageIndex + 1);
                      setSelected(null);
                    }}
                  >
                    Далее <ChevronRight size={16} />
                  </button>
                </div>
              </section>
              <aside className="tl-inspector">
                <section className="panel tl-fields">
                  <div className="tl-fields-head">
                    <div>
                      <span className="eyebrow">ДАННЫЕ ИЗ ГЕНЕРАТОРА</span>
                      <h3>Поля автозамены</h3>
                    </div>
                    <span className="tl-field-count">
                      {requiredCount - missing.length}/{requiredCount}
                    </span>
                  </div>
                  <div className="tl-coverage">
                    <progress
                      max={requiredCount || 1}
                      value={requiredCount - missing.length}
                    />
                    <span>
                      {missing.length
                        ? `Не подключено: ${missing.length}`
                        : "Обязательные поля подключены"}
                    </span>
                  </div>
                  <p className="tl-field-instruction">
                    {selectedBlock?.fieldsAllowed
                      ? "Выделите заменяемый текст и нажмите на нужное поле."
                      : "Выберите абзац основного текста, чтобы вставить поле."}
                  </p>
                  <label className="tl-search">
                    <Search size={16} />
                    <input
                      value={fieldQuery}
                      onChange={(e) => setFieldQuery(e.target.value)}
                      placeholder="Найти поле…"
                      aria-label="Найти поле автозамены"
                    />
                  </label>
                  <div className="tl-field-list">
                    {filteredFields.map((f) => (
                      <button
                        key={f.key}
                        className="tl-field-row"
                        type="button"
                        disabled={!selectedBlock?.fieldsAllowed || busy}
                        onClick={() => insertField(f)}
                        title={f.label}
                      >
                        <span
                          className={
                            validTags.has(f.key)
                              ? "tl-field-state present"
                              : f.required
                                ? "tl-field-state missing"
                                : "tl-field-state"
                          }
                        >
                          {validTags.has(f.key) ? (
                            <Check size={13} />
                          ) : (
                            <Plus size={13} />
                          )}
                        </span>
                        <span>
                          <strong>{f.label}</strong>
                          <small>
                            {f.key}
                            {!f.required ? " · необязательное" : ""}
                          </small>
                        </span>
                        <Plus size={15} className="tl-insert-icon" />
                      </button>
                    ))}
                  </div>
                </section>
                <section className="panel tl-editor-tip">
                  <span className="tl-card-icon tl-energy">
                    <FileText size={22} />
                  </span>
                  <h3>Нужна другая вёрстка?</h3>
                  <p>
                    Для добавления таблиц, изображений и сложного форматирования
                    скачайте DOCX, измените его в Word и загрузите новую версию.
                    Поля вида autozamena_001 оставляйте в тексте.
                  </p>
                  <a
                    className="text-button"
                    href={versionFile(item.id, active.version, "docx")}
                  >
                    <ArrowDownToLine size={16} /> Скачать DOCX
                  </a>
                </section>
              </aside>
            </div>
          </>
        )
      )}
      <dialog
        ref={modal}
        className="tl-confirm"
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) setConfirm(null);
        }}
      >
        <div className="tl-confirm-head">
          <span className="tl-card-icon tl-energy">
            <ShieldCheck size={24} />
          </span>
          <button
            className="icon-button"
            aria-label="Закрыть"
            disabled={busy}
            onClick={() => setConfirm(null)}
          >
            <X size={20} />
          </button>
        </div>
        <h2>
          {confirm === "publish"
            ? "Опубликовать шаблон?"
            : "Восстановить версию?"}
          <TitleDot />
        </h2>
        <p>
          {confirm === "publish"
            ? "Эта редакция будет использоваться всей командой при создании новых договоров. Предыдущая версия останется в истории."
            : `Версия v${confirm} будет опубликована как новая активная. История сохранится. Несохранённые изменения будут сброшены.`}
        </p>
        {confirm === "publish" && (
          <label>
            Комментарий к версии (необязательно)
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder="Например, изменили сроки и условия оплаты"
              rows={3}
            />
          </label>
        )}
        <div className="button-row">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => setConfirm(null)}
          >
            Отмена
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void commit()}
          >
            {busy
              ? "Сохраняем…"
              : confirm === "publish"
                ? "Сохранить и опубликовать"
                : "Восстановить"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
