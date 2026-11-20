import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FileImage,
  FilePlus2,
  GripVertical,
  Images,
  LoaderCircle,
  Plus,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { Notice, TitleDot } from "../../components/Common";
import { createPhotoPdf } from "./client";
import type { Progress } from "./convert";
import {
  defaultSettings,
  inspectPhoto,
  MAX_PHOTOS,
  outputFilename,
  presets,
  sizeText,
} from "./files";
import type { Settings } from "./files";
import "./photo-pdf.css";
type Photo = { id: string; file: File; preview: string; broken: boolean };
type Result = { url: string; size: number; original: number; pages: number };
export default function PhotoPdfResource() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <section className="pp-resource" aria-label="Инструменты техотдела">
        <span className="pp-resource-icon" aria-hidden="true">
          <FileImage size={26} strokeWidth={1.5} />
        </span>
        <div className="pp-resource-copy">
          <span>ИНСТРУМЕНТЫ</span>
          <h2>
            Фото в PDF
            <TitleDot />
          </h2>
          <p>Фотоотчёт одним файлом. Сжатие и порядок страниц.</p>
        </div>
        <span className="pp-resource-privacy">
          <ShieldCheck size={16} />В вашем браузере
        </span>
        <button
          type="button"
          className="button secondary"
          onClick={() => setOpen(true)}
        >
          Открыть конвертер
        </button>
        <div className="pp-resource-art" aria-hidden="true" />
      </section>
      {open && <PhotoPdfDialog onClose={() => setOpen(false)} />}
    </>
  );
}
function PhotoPdfDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<Photo[]>([]),
    photoRef = useRef<Photo[]>([]);
  const [settings, setSettings] = useState<Settings>({ ...defaultSettings });
  const [filename, setFilename] = useState("Фотоотчёт"),
    [result, setResult] = useState<Result | null>(null),
    resultRef = useRef<Result | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null),
    [busy, setBusy] = useState(false),
    [importing, setImporting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]),
    [status, setStatus] = useState("");
  const [draggingFiles, setDraggingFiles] = useState(false),
    [target, setTarget] = useState<string | null>(null);
  const dragging = useRef<string | null>(null),
    controller = useRef<AbortController | null>(null),
    alive = useRef(true),
    importingRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      alive.current = false;
      controller.current?.abort();
      for (const photo of photoRef.current) URL.revokeObjectURL(photo.preview);
      if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
      document.body.style.overflow = overflow;
    };
  }, []);
  const updatePhotos = (next: Photo[]) => {
    photoRef.current = next;
    setPhotos(next);
  };
  const removeResult = () => {
    if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
    resultRef.current = null;
    setResult(null);
    setProgress(null);
    setStatus("");
  };
  const locked = busy || importing;
  const addPhotos = async (files: File[]) => {
    if (controller.current || importingRef.current || !files.length) return;
    importingRef.current = true;
    setImporting(true);
    setErrors([]);
    removeResult();
    const accepted: Photo[] = [],
      issues: string[] = [];
    const available = MAX_PHOTOS - photoRef.current.length;
    if (files.length > available)
      issues.push(
        `В одном PDF может быть не больше ${MAX_PHOTOS} фото. Лишние файлы не добавлены.`,
      );
    try {
      for (const file of files.slice(0, available)) {
        if (!alive.current) break;
        try {
          await inspectPhoto(file);
          if (alive.current)
            accepted.push({
              id: crypto.randomUUID(),
              file,
              preview: URL.createObjectURL(file),
              broken: false,
            });
        } catch (error) {
          issues.push(
            `${file.name}: ${error instanceof Error ? error.message : "Не удалось прочитать файл."}`,
          );
        }
      }
      if (!alive.current) {
        for (const photo of accepted) URL.revokeObjectURL(photo.preview);
        return;
      }
      updatePhotos([...photoRef.current, ...accepted]);
      setErrors(issues);
      setStatus(
        accepted.length
          ? `Добавлено фото: ${accepted.length}. Можно настроить порядок и качество.`
          : "Новые фотографии не добавлены.",
      );
    } finally {
      importingRef.current = false;
      if (alive.current) setImporting(false);
    }
  };
  const changeSettings = (patch: Partial<Settings>) => {
    if (!locked) {
      setSettings((s) => ({ ...s, ...patch }));
      removeResult();
    }
  };
  const rearrange = (next: Photo[]) => {
    if (!locked) {
      updatePhotos(next);
      removeResult();
    }
  };
  const move = (id: string, to: number) => {
    const next = [...photoRef.current],
      from = next.findIndex((p) => p.id === id);
    if (from < 0 || to < 0 || to >= next.length || from === to) return;
    next.splice(to, 0, next.splice(from, 1)[0]);
    rearrange(next);
  };
  const remove = (id: string) => {
    if (locked) return;
    const photo = photoRef.current.find((p) => p.id === id);
    if (photo) URL.revokeObjectURL(photo.preview);
    rearrange(photoRef.current.filter((p) => p.id !== id));
  };
  const clear = () => {
    if (locked) return;
    for (const photo of photoRef.current) URL.revokeObjectURL(photo.preview);
    rearrange([]);
    setErrors([]);
  };
  const run = async () => {
    if (locked || controller.current || !photos.length) return;
    const abort = new AbortController();
    controller.current = abort;
    const snapshot = [...photos],
      original = snapshot.reduce((sum, p) => sum + p.file.size, 0);
    removeResult();
    setErrors([]);
    setBusy(true);
    try {
      const blob = await createPhotoPdf(
        snapshot.map((p) => p.file),
        { ...settings },
        (p) => {
          if (alive.current) setProgress(p);
        },
        abort.signal,
      );
      if (!alive.current || abort.signal.aborted) return;
      const completed = {
        url: URL.createObjectURL(blob),
        size: blob.size,
        original,
        pages: snapshot.length,
      };
      resultRef.current = completed;
      setResult(completed);
      setStatus("PDF готов. Сохраните файл на устройство.");
    } catch (error) {
      if (!alive.current) return;
      setProgress(null);
      if (abort.signal.aborted)
        setStatus("Создание PDF остановлено. Фотографии остались в списке.");
      else {
        setErrors([
          error instanceof Error ? error.message : "Не удалось создать PDF.",
        ]);
        setStatus("Исправьте ошибку или измените настройки и повторите.");
      }
    } finally {
      controller.current = null;
      if (alive.current) setBusy(false);
    }
  };
  const original = photos.reduce((sum, p) => sum + p.file.size, 0),
    preset =
      presets.find(
        (p) => p.maxSide === settings.maxSide && p.quality === settings.quality,
      )?.id || "manual";
  return (
    <dialog
      ref={dialog}
      className="pp-dialog"
      aria-labelledby="pp-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          setDraggingFiles(false);
          void addPhotos(Array.from(e.dataTransfer.files));
        }
      }}
    >
      <header className="pp-header">
        <div>
          <span className="eyebrow">ИНСТРУМЕНТЫ ТЕХОТДЕЛА</span>
          <h2 id="pp-title">
            Фото в PDF
            <TitleDot />
          </h2>
          <p>Соберите фотоотчёт: один снимок — одна страница.</p>
        </div>
        <div className="pp-header-actions">
          <span className="pp-private">
            <ShieldCheck size={17} />
            Без загрузки на сервер
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть конвертер"
            onClick={onClose}
          >
            <X size={22} />
          </button>
        </div>
      </header>
      <div className="pp-body">
        <div className="pp-workspace">
          <section className="pp-photos" aria-labelledby="pp-photos-title">
            <div className="pp-section-heading">
              <h3 id="pp-photos-title">Фотографии</h3>
              <span>
                {photos.length
                  ? `${photos.length} фото · ${sizeText(original)}`
                  : "В порядке страниц PDF"}
              </span>
            </div>
            <input
              ref={input}
              type="file"
              multiple
              accept=".jpg,.jpeg,.png,.webp,.bmp,.avif,.heic,.heif"
              className="sr-only"
              tabIndex={-1}
              aria-label="Выбрать фотографии"
              disabled={locked}
              onChange={(e) => {
                void addPhotos(Array.from(e.target.files || []));
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={locked}
              className={`pp-dropzone ${draggingFiles ? "pp-dragover" : ""} ${photos.length ? "pp-dropzone-compact" : ""}`}
              onClick={() => input.current?.click()}
              onDragEnter={(e) => {
                if (e.dataTransfer.types.includes("Files")) {
                  e.preventDefault();
                  setDraggingFiles(true);
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                  setDraggingFiles(false);
              }}
            >
              <span className="pp-upload-art" aria-hidden="true">
                <Images size={34} strokeWidth={1.3} />
                <span>
                  <Plus size={16} />
                </span>
              </span>
              <strong>
                {importing
                  ? "Проверяем фотографии…"
                  : photos.length
                    ? "Добавить ещё фотографии"
                    : "Добавьте фотографии"}
              </strong>
              <span>
                {photos.length
                  ? "Выберите файлы или перетащите сюда"
                  : "Перетащите сюда или выберите на устройстве"}
              </span>
              {!photos.length && (
                <small>
                  JPG, PNG, WEBP, BMP, AVIF · до 500 фото, до 50 МБ каждое
                </small>
              )}
            </button>
            {!!photos.length && (
              <>
                <div className="pp-list-toolbar">
                  <span>Порядок страниц</span>
                  <div>
                    <button
                      type="button"
                      className="text-button"
                      disabled={locked || photos.length < 2}
                      onClick={() =>
                        rearrange(
                          [...photos].sort((a, b) =>
                            a.file.name.localeCompare(b.file.name, "ru", {
                              numeric: true,
                              sensitivity: "base",
                            }),
                          ),
                        )
                      }
                    >
                      По имени
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={locked || photos.length < 2}
                      onClick={() => rearrange([...photos].reverse())}
                    >
                      <RotateCcw size={14} />
                      Развернуть
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={locked}
                      onClick={clear}
                    >
                      <Trash2 size={14} />
                      Очистить
                    </button>
                  </div>
                </div>
                <ol className="pp-photo-list" aria-label="Порядок фотографий">
                  {photos.map((p, index) => (
                    <li
                      key={p.id}
                      className={target === p.id ? "pp-drop-target" : ""}
                      draggable={!locked}
                      onDragStart={(e) => {
                        if (locked) {
                          e.preventDefault();
                          return;
                        }
                        dragging.current = p.id;
                        e.dataTransfer.setData("text/plain", p.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        dragging.current = null;
                        setTarget(null);
                      }}
                      onDragOver={(e) => {
                        if (dragging.current && !locked) {
                          e.preventDefault();
                          setTarget(p.id);
                        }
                      }}
                      onDrop={(e) => {
                        if (dragging.current && !locked) {
                          e.preventDefault();
                          e.stopPropagation();
                          move(dragging.current, index);
                          dragging.current = null;
                          setTarget(null);
                        }
                      }}
                    >
                      <GripVertical
                        size={16}
                        className="pp-grip"
                        aria-hidden="true"
                      />
                      <span
                        className="pp-page-index"
                        aria-label={`Страница ${index + 1}`}
                      >
                        {index + 1}
                      </span>
                      {p.broken ? (
                        <span className="pp-broken">
                          <FileImage size={25} />
                        </span>
                      ) : (
                        <img
                          src={p.preview}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          draggable={false}
                          onError={() =>
                            updatePhotos(
                              photoRef.current.map((photo) =>
                                photo.id === p.id
                                  ? { ...photo, broken: true }
                                  : photo,
                              ),
                            )
                          }
                        />
                      )}
                      <div className="pp-photo-meta">
                        <strong title={p.file.name}>{p.file.name}</strong>
                        <span>
                          {sizeText(p.file.size)}
                          {p.broken ? " · нет предпросмотра" : ""}
                        </span>
                      </div>
                      <div className="pp-photo-actions">
                        <button
                          className="icon-button"
                          type="button"
                          disabled={locked || index === 0}
                          aria-label={`Выше: ${p.file.name}`}
                          onClick={() => move(p.id, index - 1)}
                        >
                          <ChevronUp size={18} />
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          disabled={locked || index === photos.length - 1}
                          aria-label={`Ниже: ${p.file.name}`}
                          onClick={() => move(p.id, index + 1)}
                        >
                          <ChevronDown size={18} />
                        </button>
                        <button
                          className="icon-button pp-remove"
                          type="button"
                          disabled={locked}
                          aria-label={`Убрать: ${p.file.name}`}
                          onClick={() => remove(p.id)}
                        >
                          <X size={17} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="pp-caption">
                  Перетаскивайте фото или используйте кнопки рядом с ним.
                  Порядок в списке — порядок страниц.
                </p>
              </>
            )}
            {!!errors.length && (
              <Notice tone="error">
                <strong>Проверьте файлы</strong>
                <ul className="pp-errors">
                  {errors.slice(0, 8).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
                {errors.length > 8 && (
                  <span>Ещё ошибок: {errors.length - 8}.</span>
                )}
              </Notice>
            )}
          </section>
          <aside className="pp-settings" aria-label="Настройки PDF">
            <div className="pp-section-heading">
              <h3>
                <SlidersHorizontal size={17} />
                Настройки
              </h3>
            </div>
            <fieldset disabled={locked}>
              <label>
                Режим сжатия
                <select
                  aria-label="Режим сжатия"
                  value={preset}
                  onChange={(e) => {
                    const p = presets.find((v) => v.id === e.target.value);
                    if (p)
                      changeSettings({
                        maxSide: p.maxSide,
                        quality: p.quality,
                      });
                  }}
                >
                  {presets.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value="manual">Свои настройки</option>
                </select>
              </label>
              <p className="pp-field-hint">
                {presets.find((p) => p.id === preset)?.description ||
                  "Выбранные вами разрешение и качество"}
              </p>
              <label>
                Максимальная сторона
                <select
                  aria-label="Максимальная сторона"
                  value={settings.maxSide}
                  onChange={(e) =>
                    changeSettings({ maxSide: Number(e.target.value) })
                  }
                >
                  {[1200, 1600, 2200, 3000, 0].map((n) => (
                    <option value={n} key={n}>
                      {n
                        ? `${n.toLocaleString("ru-RU")} пикселей`
                        : "Исходное разрешение"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pp-quality">
                <span>
                  Качество JPEG<strong>{settings.quality}%</strong>
                </span>
                <input
                  aria-label="Качество JPEG"
                  type="range"
                  min={35}
                  max={95}
                  value={settings.quality}
                  onChange={(e) =>
                    changeSettings({ quality: Number(e.target.value) })
                  }
                />
              </label>
              <p className="pp-field-hint">
                Ниже качество — меньше файл. Для мелкого текста выбирайте
                «Чёткий текст».
              </p>
              <label>
                Страницы PDF
                <select
                  aria-label="Страницы PDF"
                  value={settings.pageMode}
                  onChange={(e) =>
                    changeSettings({
                      pageMode: e.target.value as Settings["pageMode"],
                    })
                  }
                >
                  <option value="a4">A4 · по ориентации снимка</option>
                  <option value="image">По пропорциям фото · без полей</option>
                </select>
              </label>
              <p className="pp-field-hint">
                Без обрезки и растяжения. Прозрачность заменяется белым фоном.
              </p>
            </fieldset>
            <div className="pp-local-note">
              <ShieldCheck size={20} />
              <p>
                Фото и PDF остаются в вашем браузере. На сервер ничего не
                отправляется и в истории сервиса не сохраняется.
              </p>
            </div>
          </aside>
        </div>
        <section className="pp-export" aria-label="Создание PDF">
          <div className="pp-export-main">
            <label>
              Имя файла
              <input
                aria-label="Имя PDF"
                type="text"
                value={filename}
                maxLength={150}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="Фотоотчёт"
              />
              <span className="pp-caption">{outputFilename(filename)}</span>
            </label>
            <div className="pp-export-action">
              {busy ? (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => controller.current?.abort()}
                >
                  <X size={17} />
                  Остановить
                </button>
              ) : (
                <button
                  className="button primary"
                  type="button"
                  disabled={locked || !photos.length}
                  onClick={() => void run()}
                >
                  <FilePlus2 size={18} />
                  Создать PDF
                </button>
              )}
              <span>
                {photos.length
                  ? `Страниц: ${photos.length}`
                  : "Сначала добавьте фото"}
              </span>
            </div>
          </div>
          {busy && progress && (
            <div className="pp-progress" role="status" aria-live="polite">
              <div>
                <LoaderCircle size={16} className="spin" />
                <span>
                  {progress.phase === "pdf"
                    ? "Собираем PDF…"
                    : `Обработка ${progress.done + 1} из ${progress.total}`}
                </span>
                <span>
                  {Math.round((progress.done / progress.total) * 100)}%
                </span>
              </div>
              <progress
                aria-label="Создание PDF"
                value={progress.done}
                max={progress.total}
              />
              <small title={progress.filename}>{progress.filename}</small>
            </div>
          )}
          {!busy && status && (
            <p className="pp-status" role="status">
              {status}
            </p>
          )}
          {result && (
            <div className="pp-result" role="status">
              <span className="pp-result-icon">
                <Check size={23} />
              </span>
              <div>
                <h3>Фотоотчёт готов</h3>
                <p>
                  {result.pages} стр. · {sizeText(result.size)}{" "}
                  <span>из {sizeText(result.original)}</span>
                </p>
                <small>
                  {result.size < result.original
                    ? `На ${Math.round((1 - result.size / result.original) * 100)}% меньше исходных фото`
                    : `На ${Math.round((result.size / result.original - 1) * 100)}% больше исходных фото. Такое бывает с уже сжатыми снимками.`}
                </small>
              </div>
              <a
                className="button primary"
                href={result.url}
                download={outputFilename(filename)}
              >
                <Download size={18} />
                Скачать PDF
              </a>
            </div>
          )}
        </section>
        <p className="pp-footer-note">
          HEIC и HEIF доступны, если их поддерживает ваш браузер. Если снимок не
          открывается, сохраните его как JPG. При закрытии конвертера выбранные
          фото и результат очищаются.
        </p>
      </div>
    </dialog>
  );
}
