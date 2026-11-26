import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Activity,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  ExternalLink,
  FilePenLine,
  History,
  Inbox,
  MessageCircle,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { api, post, errorText, dateTime, number } from "../api";
import {
  Empty,
  Loading,
  Notice,
  PageHead,
  TitleDot,
} from "../components/Common";
import { initials } from "../identity";
import "./Dzen.css";

type Mode = "paused" | "review" | "auto";
type Status =
  | "new"
  | "generating"
  | "draft"
  | "queued"
  | "sending"
  | "answered"
  | "skipped"
  | "error"
  | "attention";
type Settings = {
  mode: Mode;
  channel: string;
  ownNames: string;
  scanMinutes: number;
  batchLimit: number;
  dailyLimit: number;
  maxChars: number;
  prompt: string;
  version: number;
  promptVersion: number;
};
type Comment = {
  id: string;
  commentId: string;
  author: string;
  article: string;
  text: string;
  reply: string;
  createdLabel: string;
  href: string;
  isOwn: boolean;
  eligible: boolean;
  status: Status;
  approval: string;
  actor: string;
  error: string;
  version: number;
  promptVersion: number | null;
  discoveredAt: string;
  updatedAt: string;
  answeredAt: string | null;
  origin: "studio" | "manual";
};
type Event = {
  id: number;
  createdAt: string;
  action: string;
  commentId: string | null;
  actor: string;
  detail: string;
};
export type DzenData = {
  settings: Settings;
  counts: Record<Status, number>;
  items: Comment[];
  total: number;
  page: number;
  pageSize: number;
  dailyUsed: number;
  answeredToday: number;
  connection: {
    online: boolean;
    status: string;
    studioUrl: string | null;
    lastHeartbeat: string | null;
    lastScan: string | null;
    nextScan: string | null;
    scanRequested: boolean;
    verified: boolean;
    error: string;
    task: { kind: string; phase: string; createdAt: string } | null;
  };
  events: Event[];
  promptHistory: {
    version: number;
    prompt: string;
    actor: string;
    createdAt: string;
  }[];
  integration: { agentConfigured: boolean; aiConfigured: boolean };
  permissions: { edit: boolean; settings: boolean };
};
const PATH = "/dzen";
const statuses: Record<Status, string> = {
  new: "Новый",
  generating: "Генерируется",
  draft: "Черновик",
  queued: "В очереди",
  sending: "Отправляется",
  answered: "Отвечено",
  skipped: "Пропущен",
  error: "Ошибка ИИ",
  attention: "Проверить",
};
const modeInfo = {
  paused: {
    label: "На паузе",
    description: "Нет фоновой генерации и отправок.",
    icon: Pause,
  },
  review: {
    label: "С проверкой",
    description: "ИИ готовит черновики, сотрудник подтверждает отправку.",
    icon: ShieldCheck,
  },
  auto: {
    label: "Автоответы",
    description: "ИИ отвечает в пределах настроек и подтверждённой очереди.",
    icon: Zap,
  },
};
const eventLabels: Record<string, string> = {
  scan: "Получены комментарии",
  scan_requested: "Запрошено обновление",
  filter_updated: "Фильтр обновлён",
  scan_error: "Обновление остановлено",
  generated: "Подготовлен черновик",
  auto_queue: "Автоматически поставлен в очередь",
  ai_skip: "ИИ предложил пропустить",
  ai_error: "Ошибка генерации",
  queue: "Ответ подтверждён сотрудником",
  sending: "Начата отправка",
  sent: "Ответ опубликован",
  uncertain: "Нужна проверка публикации",
  not_sent: "Ответ не отправлен",
  save: "Черновик сохранён",
  cancel: "Отменена отправка",
  skip: "Комментарий пропущен",
  reopen: "Комментарий возвращён",
  confirm: "Подтверждён ответ вручную",
  prompt: "Изменён промпт",
  mode: "Изменён режим",
  manual_import: "Ручной импорт",
};
const connectionLabels: Record<string, string> = {
  ready: "На связи",
  starting: "Ожидает обновления",
  offline: "Агент не в сети",
  login_required: "Требуется вход",
  blocked: "Доступ ограничен",
  interface_changed: "Проверьте Студию",
  error: "Ошибка подключения",
};
const formatDate = (s: string | null) => (s ? dateTime(s, true) : "—");
const filtered: { key: Status | "all"; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "new", label: "Новые" },
  { key: "draft", label: "Черновики" },
  { key: "queued", label: "В очереди" },
  { key: "answered", label: "Отвечено" },
  { key: "attention", label: "Проверить" },
  { key: "skipped", label: "Пропущенные" },
  { key: "error", label: "Ошибки" },
  { key: "generating", label: "Генерация" },
  { key: "sending", label: "Отправка" },
];

function Badge({ status }: { status: Status }) {
  return (
    <span className={`dz-badge dz-status-${status}`}>
      <i />
      {statuses[status]}
    </span>
  );
}
function ActivityList({
  events,
  compact = false,
}: {
  events: Event[];
  compact?: boolean;
}) {
  if (!events.length)
    return <div className="dz-muted-empty">История действий пока пуста.</div>;
  return (
    <div className={`dz-activity ${compact ? "compact" : ""}`}>
      {events.map((e) => (
        <div className="dz-event" key={e.id}>
          <div
            className={`dz-event-icon ${["uncertain", "scan_error", "ai_error"].includes(e.action) ? "warn" : ""}`}
          >
            {e.action === "sent" || e.action === "confirm" ? (
              <Check size={16} />
            ) : e.action === "generated" || e.action === "auto_queue" ? (
              <Sparkles size={16} />
            ) : (
              <Activity size={16} />
            )}
          </div>
          <div>
            <strong>{eventLabels[e.action] || e.action}</strong>
            <p>
              {e.actor}
              {e.detail
                ? ` · ${modeInfo[e.detail as Mode]?.label || e.detail}`
                : ""}
            </p>
          </div>
          <time>{formatDate(e.createdAt)}</time>
        </div>
      ))}
    </div>
  );
}

function ReplyDetail({
  row,
  data,
  busy,
  runAction,
  generate,
}: {
  row: Comment;
  data: DzenData;
  busy: boolean;
  runAction: (row: Comment, args: Record<string, unknown>) => Promise<boolean>;
  generate: (row: Comment) => Promise<boolean>;
}) {
  const [local, setLocal] = useState<{ text: string; version: number } | null>(
    null,
  );
  const reply = local?.text ?? row.reply;
  const [copied, setCopied] = useState(false);
  const dirty = local !== null && reply !== row.reply;
  const stale = dirty && local.version !== row.version;
  const editable =
    data.permissions.edit &&
    !["generating", "queued", "sending", "answered"].includes(row.status);
  const canSave =
    editable &&
    row.status !== "attention" &&
    !!reply.trim() &&
    reply.length <= data.settings.maxChars &&
    !stale;
  const canQueue =
    canSave &&
    row.status === "draft" &&
    row.eligible &&
    data.connection.verified &&
    data.settings.mode !== "paused" &&
    data.dailyUsed < data.settings.dailyLimit;
  const operate = async (
    action: string,
    extra: Record<string, unknown> = {},
  ) => {
    const ok = await runAction(
      { ...row, version: dirty ? local.version : row.version },
      { action, ...extra },
    );
    if (ok) setLocal(null);
  };
  async function makeReply() {
    if (
      dirty &&
      !window.confirm("Заменить несохранённый текст новым черновиком ИИ?")
    )
      return;
    if (await generate(row)) setLocal(null);
  }
  async function copyReply() {
    try {
      await navigator.clipboard.writeText(reply);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }
  const events = data.events.filter((e) => e.commentId === row.id).slice(0, 5);
  return (
    <section className="panel dz-detail">
      <div className="dz-detail-head">
        <div className="dz-avatar large">
          {initials(row.author || "Читатель")}
        </div>
        <div className="dz-author">
          <h3>{row.author || "Читатель Дзена"}</h3>
          <span>
            {row.createdLabel || formatDate(row.discoveredAt)} ·{" "}
            {row.origin === "manual" ? "Добавлен вручную" : "Студия Дзена"}
          </span>
        </div>
        <Badge status={row.status} />
      </div>
      <div className="dz-original">
        <div className="dz-label">
          <MessageCircle size={16} /> КОММЕНТАРИЙ ЧИТАТЕЛЯ
        </div>
        {row.article && <div className="dz-article-title">{row.article}</div>}
        <p>{row.text}</p>
        {row.href && (
          <a
            className="text-button dz-link"
            href={row.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть в Дзене <ExternalLink size={14} />
          </a>
        )}
      </div>
      <div className="dz-target-line">
        <span
          className={
            row.eligible && data.connection.verified ? "good" : "neutral"
          }
        >
          {row.eligible && data.connection.verified ? (
            <ShieldCheck size={16} />
          ) : (
            <CircleAlert size={16} />
          )}{" "}
          {row.isOwn
            ? "Комментарий своего канала"
            : row.eligible && data.connection.verified
              ? "Подтверждён в списке без ответа"
              : "Для отправки нужна точная привязка к комментарию"}
        </span>
        {row.promptVersion && <span>Промпт v{row.promptVersion}</span>}
      </div>
      {row.error && (
        <Notice
          tone={
            row.status === "attention" || row.status === "error"
              ? "error"
              : "warning"
          }
        >
          {row.error}
        </Notice>
      )}
      {stale && (
        <Notice>
          Карточку изменили параллельно.{" "}
          <button className="text-button" onClick={() => setLocal(null)}>
            Загрузить актуальную версию
          </button>
        </Notice>
      )}
      <div className="dz-answer-title">
        <div>
          <span className="dz-label">
            <Sparkles size={15} /> ОТВЕТ КАНАЛА
          </span>
          <h3>
            {row.status === "answered"
              ? "Опубликованный ответ"
              : "Подготовить ответ"}
            <TitleDot />
          </h3>
        </div>
        {data.permissions.edit && editable && row.status !== "attention" && (
          <button
            className="button secondary compact"
            disabled={
              busy || !data.integration.aiConfigured || row.isOwn || stale
            }
            onClick={() => void makeReply()}
          >
            <Sparkles size={16} />
            {row.reply ? "Сгенерировать заново" : "Подготовить ИИ"}
          </button>
        )}
      </div>
      <textarea
        className="dz-reply-text"
        aria-label="Текст ответа"
        value={reply}
        onChange={(e) =>
          setLocal({
            text: e.target.value,
            version: local?.version ?? row.version,
          })
        }
        disabled={!editable || busy}
        placeholder={
          row.status === "generating"
            ? "ИИ готовит ответ…"
            : "Напишите ответ или попросите ИИ подготовить черновик."
        }
        rows={7}
      />
      <div className="dz-reply-meta">
        <span>
          {row.actor
            ? `Последнее действие: ${row.actor}`
            : "Ответ можно отредактировать перед отправкой."}
        </span>
        <span
          className={
            reply.length > data.settings.maxChars ? "dz-over-limit" : ""
          }
        >
          {reply.length}/{data.settings.maxChars}
        </span>
      </div>
      {data.permissions.edit && (
        <div className="dz-actions">
          {editable && row.status !== "attention" && (
            <button
              className="button secondary"
              disabled={busy || !canSave || (!dirty && row.status === "draft")}
              onClick={() => void operate("save", { reply })}
            >
              <FilePenLine size={16} /> Сохранить
            </button>
          )}
          {row.status === "draft" && (
            <button
              className="button primary"
              disabled={busy || !canQueue}
              onClick={() => {
                if (
                  window.confirm(
                    "Подтвердить отправку этого ответа на комментарий в Дзене?",
                  )
                )
                  void operate("queue", { reply });
              }}
            >
              <Send size={16} /> Отправить в Дзен
            </button>
          )}
          {row.status === "queued" && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void operate("cancel")}
            >
              <Pause size={16} /> Снять с очереди
            </button>
          )}
          {["new", "draft", "error"].includes(row.status) && (
            <button
              className="text-button dz-skip"
              disabled={busy}
              onClick={() => void operate("skip")}
            >
              <X size={16} /> Пропустить
            </button>
          )}
          {["skipped", "error"].includes(row.status) && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void operate("reopen")}
            >
              <RefreshCw size={14} /> Вернуть в работу
            </button>
          )}
          {reply.trim() && (
            <button className="text-button" onClick={() => void copyReply()}>
              <Copy size={15} />
              {copied ? "Скопировано" : "Копировать"}
            </button>
          )}
        </div>
      )}
      {data.permissions.edit &&
        ["attention", "draft", "new", "error"].includes(row.status) && (
          <div className="dz-manual-note">
            <ShieldCheck size={18} />
            <div>
              <strong>
                {row.status === "attention"
                  ? "Проверьте ветку в Дзене"
                  : "Ручная публикация"}
              </strong>
              <p>
                {row.status === "attention"
                  ? "Повторная отправка заблокирована до вашей проверки. Если ответ уже появился — подтвердите. Если нет — верните в черновик."
                  : "Если ответили непосредственно в Студии, отметьте это здесь. Сервис не будет отправлять его повторно."}
              </p>
              <div>
                <button
                  className="text-button"
                  disabled={
                    busy ||
                    !reply.trim() ||
                    reply.length > data.settings.maxChars ||
                    stale
                  }
                  onClick={() => {
                    if (
                      window.confirm(
                        "Вы проверили, что этот ответ действительно опубликован в Дзене?",
                      )
                    )
                      void operate("confirm", { reply, confirm: true });
                  }}
                >
                  Отметить опубликованным
                </button>
                {row.status === "attention" && (
                  <button
                    className="text-button"
                    disabled={busy || stale}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Вы проверили ветку и убедились, что ответ не опубликован?",
                        )
                      )
                        void operate("not_sent", { confirm: true });
                    }}
                  >
                    Не опубликован
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      {events.length > 0 && (
        <div className="dz-detail-history">
          <h4>История комментария</h4>
          <ActivityList events={events} compact />
        </div>
      )}
    </section>
  );
}

function SettingsPanel({
  data,
  busy,
  save,
}: {
  data: DzenData;
  busy: boolean;
  save: (settings: Settings, confirmAuto: boolean) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(data.settings);
  const [dirty, setDirty] = useState(false);
  const [example, setExample] = useState("");
  const [exampleResult, setExampleResult] = useState<{
    reply: string;
    skipped: boolean;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");
  async function testPrompt() {
    setTesting(true);
    setTestError("");
    setExampleResult(null);
    try {
      setExampleResult(
        await post<{ reply: string; skipped: boolean }>(PATH + "/preview", {
          prompt: draft.prompt,
          maxChars: draft.maxChars,
          text: example,
        }),
      );
    } catch (e) {
      setTestError(errorText(e));
    } finally {
      setTesting(false);
    }
  }
  useEffect(() => {
    if (!dirty) setDraft(data.settings);
  }, [data.settings.version, dirty]);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((s) => ({ ...s, [key]: value }));
    setDirty(true);
  };
  const canEdit = data.permissions.settings && !busy;
  const stale = dirty && draft.version !== data.settings.version;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const confirmAuto =
      draft.mode === "auto" &&
      (data.settings.mode !== "auto" || draft.prompt !== data.settings.prompt);
    if (
      confirmAuto &&
      !window.confirm(
        "Разрешить автоматическую публикацию ответов от имени канала? Действуют указанные лимиты. Неподтверждённые комментарии не отправляются.",
      )
    )
      return;
    if (await save(draft, confirmAuto)) setDirty(false);
  };
  return (
    <form onSubmit={submit} className="dz-settings-grid">
      <section className="panel dz-settings-panel">
        <div className="dz-label">
          <Settings2 size={16} /> ПАРАМЕТРЫ РАБОТЫ
        </div>
        <h2>
          Управление процессом
          <TitleDot />
        </h2>
        <p>
          Режим запускается только после сохранения. Пауза останавливает новые
          отправки.
        </p>
        <div className="dz-mode-options">
          {(Object.keys(modeInfo) as Mode[]).map((mode) => {
            const info = modeInfo[mode];
            return (
              <button
                type="button"
                key={mode}
                disabled={!canEdit}
                aria-pressed={draft.mode === mode}
                className={`dz-mode-option ${draft.mode === mode ? "selected" : ""}`}
                onClick={() => update("mode", mode)}
              >
                <span className="dz-mode-icon">
                  <info.icon size={19} />
                </span>
                <span>
                  <strong>{info.label}</strong>
                  <small>{info.description}</small>
                </span>
                {draft.mode === mode && <CheckCircle2 size={18} />}
              </button>
            );
          })}
        </div>
        <div className="dz-form-grid">
          <label>
            Название канала
            <input
              value={draft.channel}
              disabled={!canEdit}
              maxLength={100}
              onChange={(e) => update("channel", e.target.value)}
              required
            />
          </label>
          <label>
            Проверка комментариев, мин
            <input
              type="number"
              min={5}
              max={120}
              value={draft.scanMinutes}
              disabled={!canEdit}
              onChange={(e) => update("scanMinutes", Number(e.target.value))}
              required
            />
          </label>
          <label>
            Черновиков за цикл
            <input
              type="number"
              min={1}
              max={10}
              value={draft.batchLimit}
              disabled={!canEdit}
              onChange={(e) => update("batchLimit", Number(e.target.value))}
              required
            />
          </label>
          <label>
            Отправок в сутки
            <input
              type="number"
              min={1}
              max={50}
              value={draft.dailyLimit}
              disabled={!canEdit}
              onChange={(e) => update("dailyLimit", Number(e.target.value))}
              required
            />
          </label>
          <label>
            Максимум символов
            <input
              type="number"
              min={120}
              max={1500}
              value={draft.maxChars}
              disabled={!canEdit}
              onChange={(e) => update("maxChars", Number(e.target.value))}
              required
            />
          </label>
          <label className="dz-full">
            Имена собственного канала
            <textarea
              value={draft.ownNames}
              disabled={!canEdit}
              maxLength={1000}
              rows={2}
              placeholder="Имя в Студии, отделите запятыми"
              onChange={(e) => update("ownNames", e.target.value)}
            />
            <small>
              Чтобы не отвечать самим себе. Обязательно для автоответов.
            </small>
          </label>
        </div>
        <div className="dz-config-note">
          <ShieldCheck size={18} />
          <p>
            Только подтверждённые комментарии без ответа. Неверная привязка,
            ограничение доступа или неопределённый результат не запускают
            повторную отправку.
          </p>
        </div>
      </section>
      <section className="panel dz-settings-panel dz-prompt-panel">
        <div className="dz-label">
          <Sparkles size={16} /> YANDEXGPT / ИНСТРУКЦИИ
        </div>
        <div className="dz-prompt-head">
          <h2>
            Промпт для ответов
            <TitleDot />
          </h2>
          <span className="dz-prompt-version">
            v{data.settings.promptVersion}
          </span>
        </div>
        <p>
          Настройте тон, стиль и правила ответов. Комментарий и заголовок
          материала передаются ИИ отдельно.
        </p>
        <label className="dz-prompt-label">
          Системный промпт
          <textarea
            className="dz-prompt-text"
            value={draft.prompt}
            onChange={(e) => update("prompt", e.target.value)}
            disabled={!canEdit}
            required
            maxLength={12000}
            rows={15}
          />
        </label>
        <div className="dz-reply-meta">
          <span>Версии сохраняются в журнале.</span>
          <span>{number(draft.prompt.length)} / 12 000</span>
        </div>
        <div className="dz-prompt-test">
          <h3>
            <Sparkles size={16} /> Проверка промпта
          </h3>
          <p>
            Попробуйте новый промпт на примере комментария. Ответ не сохранится
            и не будет опубликован.
          </p>
          <textarea
            rows={3}
            aria-label="Пример комментария"
            maxLength={6000}
            value={example}
            disabled={testing || !data.permissions.settings}
            placeholder="Например: Какая документация нужна для проверки?"
            onChange={(e) => {
              setExample(e.target.value);
              setExampleResult(null);
            }}
          />
          <button
            type="button"
            className="button secondary compact"
            disabled={
              !canEdit ||
              testing ||
              !example.trim() ||
              !draft.prompt.trim() ||
              !data.integration.aiConfigured
            }
            onClick={() => void testPrompt()}
          >
            <Sparkles size={15} />
            {testing ? "Проверяем…" : "Проверить промпт"}
          </button>
          {testError && <Notice tone="error">{testError}</Notice>}
          {exampleResult && (
            <div className="dz-test-result">
              <strong>Предварительный ответ</strong>
              <p>
                {exampleResult.skipped
                  ? "ИИ предложил пропустить комментарий (SKIP)."
                  : exampleResult.reply}
              </p>
            </div>
          )}
        </div>
        <div className="dz-prompt-history">
          <h3>История промптов</h3>
          {data.promptHistory.slice(0, 5).map((p) => (
            <div className="dz-prompt-row" key={p.version}>
              <span>v{p.version}</span>
              <div>
                <strong>{p.actor}</strong>
                <small>{formatDate(p.createdAt)}</small>
              </div>
              <button
                type="button"
                className="text-button"
                disabled={!canEdit}
                onClick={() => update("prompt", p.prompt)}
              >
                Использовать
              </button>
            </div>
          ))}
        </div>
      </section>
      <div className="dz-settings-save panel">
        <div>
          <strong>
            {dirty ? "Есть несохранённые настройки" : "Настройки сохранены"}
          </strong>
          <small>
            {stale
              ? "Настройки изменены другим сотрудником. Обновите редакцию."
              : "Действуют для следующих циклов. Уже начатая публикация может завершиться."}
          </small>
        </div>
        {stale && (
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setDraft(data.settings);
              setDirty(false);
            }}
          >
            Обновить
          </button>
        )}
        <button
          className="button primary"
          disabled={!canEdit || !dirty || stale}
          type="submit"
        >
          <Check size={17} /> Сохранить настройки
        </button>
      </div>
    </form>
  );
}

function ImportDialog({
  onClose,
  submit,
  busy,
}: {
  onClose: () => void;
  submit: (input: Record<string, string>) => Promise<boolean>;
  busy: boolean;
}) {
  const [author, setAuthor] = useState("");
  const [articleTitle, setArticle] = useState("");
  const [text, setText] = useState("");
  const [href, setHref] = useState("");
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="dz-dialog" onCancel={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await submit({ author, articleTitle, text, href })) onClose();
        }}
      >
        <div className="dz-dialog-head">
          <div>
            <div className="dz-label">РУЧНОЙ ИМПОРТ</div>
            <h2>
              Добавить комментарий
              <TitleDot />
            </h2>
          </div>
          <button
            type="button"
            aria-label="Закрыть"
            className="icon-button"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <p>
          Можно подготовить ответ даже без подключения агента. Ручной
          комментарий не публикуется автоматически.
        </p>
        <label>
          Автор
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            maxLength={180}
          />
        </label>
        <label>
          Материал
          <input
            value={articleTitle}
            onChange={(e) => setArticle(e.target.value)}
            maxLength={500}
          />
        </label>
        <label>
          Комментарий
          <textarea
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={6000}
            required
          />
        </label>
        <label>
          Ссылка на комментарий (необязательно)
          <input
            type="url"
            value={href}
            onChange={(e) => setHref(e.target.value)}
          />
        </label>
        <button className="button primary" disabled={busy || !text.trim()}>
          <Plus size={17} /> Добавить
        </button>
      </form>
    </dialog>
  );
}

export default function Dzen({ active }: { active: boolean }) {
  const [data, setData] = useState<DzenData | null>(null),
    [section, setSection] = useState<"comments" | "settings" | "log">(
      "comments",
    ),
    [filter, setFilter] = useState<Status | "all">("all"),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [pausing, setPausing] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [importing, setImporting] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const refresh = useCallback(async () => {
    const seq = ++revision.current;
    try {
      const value = await api<DzenData>(
        PATH +
          "?" +
          new URLSearchParams({
            status: filter,
            q: search,
            page: String(page),
          }),
      );
      if (seq === revision.current) setData(value);
    } catch (e) {
      if (seq === revision.current) setError(errorText(e));
    }
  }, [filter, search, page]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      clearInterval(timer);
      revision.current++;
    };
  }, [active, refresh]);
  useEffect(() => {
    if (!data || data.page !== page) return;
    const last = Math.max(1, Math.ceil(data.total / data.pageSize));
    if (page > last) setPage(last);
  }, [data, page]);
  const changeFilter = (status: Status | "all") => {
    setFilter(status);
    setPage(1);
    setSelected(null);
    setSection("comments");
  };
  async function perform(url: string, body: unknown, notice: string) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await post(url, body);
      setMessage(notice);
      await refresh();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function pause() {
    if (pausing) return;
    setPausing(true);
    try {
      await post(PATH + "/pause", {});
      setMessage("Новые отправки приостановлены.");
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPausing(false);
    }
  }
  if (!data)
    return (
      <>
        <PageHead
          eyebrow="МАРКЕТИНГ / ДЗЕН"
          title="Комментарии Дзена"
          description="Ответы читателям, промпт и контроль публикаций."
        />
        {error ? (
          <Notice tone="error">
            {error}{" "}
            <button className="text-button" onClick={() => void refresh()}>
              Повторить
            </button>
          </Notice>
        ) : (
          <Loading />
        )}
      </>
    );
  const row = data.items.find((x) => x.id === selected) || data.items[0];
  const info = modeInfo[data.settings.mode];
  const maxPage = Math.max(1, Math.ceil(data.total / data.pageSize));
  const save = (settings: Settings, confirmAuto: boolean) =>
    perform(
      PATH + "/settings",
      { ...settings, confirmAuto },
      "Настройки сохранены.",
    );
  const runAction = (row: Comment, args: Record<string, unknown>) =>
    perform(
      `${PATH}/comments/${row.id}/action`,
      { ...args, version: row.version },
      "Изменения сохранены.",
    );
  const generate = (row: Comment) =>
    perform(
      `${PATH}/comments/${row.id}/generate`,
      { version: row.version },
      "Генерация завершена. Проверьте результат в карточке.",
    );
  return (
    <div className="dz-page">
      <PageHead
        eyebrow="МАРКЕТИНГ / ZENBOT"
        title="Комментарии Дзена"
        description="Все обращения читателей, ответы ИИ и история публикаций — в одном месте."
      >
        <div className="dz-head-actions">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} /> Обновить
          </button>
          {data.permissions.edit && data.settings.mode !== "paused" && (
            <button
              className="button primary"
              disabled={pausing}
              onClick={() => void pause()}
            >
              <Pause size={16} /> Пауза
            </button>
          )}
        </div>
      </PageHead>
      <section className="intro-banner dz-hero">
        <div className="dz-hero-copy">
          <span className="banner-label">
            <span className="tiny-dot" /> ДИАЛОГ С ЧИТАТЕЛЯМИ / BOYKOV GROUP
          </span>
          <h2>
            Не оставляйте вопросы
            <br />
            без ответа<span>.</span>
          </h2>
          <p>
            Zenbot готовит содержательные ответы. Вы определяете правила,
            контролируете очередь и решаете, что публиковать.
          </p>
          <div className="dz-hero-mode">
            <span>
              <info.icon size={15} /> {info.label}
            </span>
            <button
              className="dz-hero-button"
              onClick={() => setSection("settings")}
            >
              {data.settings.mode === "paused" ? (
                <Play size={16} />
              ) : (
                <Settings2 size={16} />
              )}{" "}
              Настроить работу
            </button>
          </div>
        </div>
        <div className="dz-art" aria-hidden="true">
          <div className="dz-art-orbit" />
          <div className="dz-art-chat main">
            <MessageSquare size={43} strokeWidth={1.35} />
            <i />
            <i />
          </div>
          <div className="dz-art-chat secondary">
            <Sparkles size={32} strokeWidth={1.45} />
          </div>
          <span className="dz-art-cross">✳</span>
          <span className="dz-art-caption">ДИАЛОГ / 01</span>
        </div>
      </section>
      {error && (
        <Notice tone="error">
          {error}{" "}
          <button className="text-button" onClick={() => setError("")}>
            Закрыть
          </button>
        </Notice>
      )}
      {message && (
        <Notice tone="success">
          {message}{" "}
          <button className="text-button" onClick={() => setMessage("")}>
            Закрыть
          </button>
        </Notice>
      )}
      <div className="dz-metrics">
        {[
          {
            label: "Новые комментарии",
            value: data.counts.new,
            icon: Inbox,
            key: "new",
            hint: "Ожидают обработки",
          },
          {
            label: "Готовы к проверке",
            value: data.counts.draft,
            icon: FilePenLine,
            key: "draft",
            hint: "Черновики ответов",
          },
          {
            label: "Отвечено сегодня",
            value: data.answeredToday,
            icon: CheckCircle2,
            key: "answered",
            hint: `Всего ${number(data.counts.answered)}`,
          },
          {
            label: "Нужна проверка",
            value: data.counts.attention,
            icon: CircleAlert,
            key: "attention",
            hint: "Не отправляются повторно",
          },
        ].map((m) => (
          <button
            key={m.key}
            className={`panel dz-metric ${filter === m.key && section === "comments" ? "selected" : ""}`}
            onClick={() => changeFilter(m.key as Status)}
          >
            <span>
              {m.label}
              <m.icon size={18} />
            </span>
            <strong>{number(m.value)}</strong>
            <small>{m.hint}</small>
          </button>
        ))}
      </div>
      <section className="panel dz-connection">
        <div className="dz-connection-item">
          <span
            className={`dz-signal ${data.connection.online && data.connection.status === "ready" ? "online" : ""}`}
          />
          <div>
            <b>Студия Дзена</b>
            <small>
              {data.integration.agentConfigured
                ? connectionLabels[data.connection.status] || "Не подключено"
                : "Нужен ключ агента"}
            </small>
          </div>
        </div>
        <div className="dz-connection-item">
          <span
            className={`dz-signal ${data.integration.aiConfigured ? "online" : ""}`}
          />
          <div>
            <b>YandexGPT</b>
            <small>
              {data.integration.aiConfigured
                ? "Ключи настроены"
                : "Ключи не настроены"}
            </small>
          </div>
        </div>
        <div className="dz-connection-item">
          <Clock3 size={19} />
          <div>
            <b>Последний сбор</b>
            <small>{formatDate(data.connection.lastScan)}</small>
            {data.settings.mode !== "paused" && data.connection.nextScan && (
              <small>Следующий: {formatDate(data.connection.nextScan)}</small>
            )}
          </div>
        </div>
        <div className="dz-quota">
          <span>
            Дневной лимит{" "}
            <b>
              {data.dailyUsed}/{data.settings.dailyLimit}
            </b>
          </span>
          <progress
            value={Math.min(data.dailyUsed, data.settings.dailyLimit)}
            max={data.settings.dailyLimit}
          />
        </div>
      </section>
      {data.connection.error && <Notice>{data.connection.error}</Notice>}
      {(!data.integration.agentConfigured ||
        !data.integration.aiConfigured) && (
        <Notice tone="info">
          Подключите ключ агента и отдельные ключи YandexGPT на сервере. Раздел
          уже доступен для ручного добавления комментариев.{" "}
          <button
            className="text-button"
            onClick={() => setSection("settings")}
          >
            Настройки
          </button>
        </Notice>
      )}
      <div className="dz-tabs" role="tablist" aria-label="Разделы Zenbot">
        {(
          [
            { id: "comments", label: "Комментарии", icon: MessageCircle },
            { id: "settings", label: "Настройки и промпт", icon: Settings2 },
            { id: "log", label: "Журнал работы", icon: History },
          ] as const
        ).map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={section === x.id}
            className={section === x.id ? "selected" : ""}
            onClick={() => setSection(x.id)}
          >
            <x.icon size={17} />
            {x.label}
          </button>
        ))}
        <span>
          {data.connection.task
            ? data.connection.task.kind === "scan"
              ? "Выполняется сбор…"
              : "Идёт отправка…"
            : data.connection.scanRequested
              ? "Сбор в очереди"
              : "Рабочее пространство"}
        </span>
      </div>
      {section === "comments" ? (
        <>
          <div className="dz-work-head">
            <div>
              <span className="eyebrow">ЛЕНТА КОММЕНТАРИЕВ</span>
              <h2>
                Входящие
                <TitleDot />
              </h2>
              <p>Новые комментарии и подготовленные ответы.</p>
            </div>
            {data.permissions.edit && (
              <div>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setImporting(true)}
                >
                  <Plus size={16} /> Добавить
                </button>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !data.integration.agentConfigured ||
                    data.connection.scanRequested ||
                    data.connection.task?.kind === "scan"
                  }
                  onClick={() =>
                    void perform(
                      PATH + "/scan",
                      {},
                      "Сбор запрошен. Агент обновит комментарии при следующем подключении.",
                    )
                  }
                >
                  <RefreshCw size={16} /> Собрать комментарии
                </button>
              </div>
            )}
          </div>
          <div className="dz-work-grid">
            <section className="panel dz-list">
              <div className="dz-list-top">
                <label className="dz-search">
                  <Search size={16} />
                  <input
                    aria-label="Поиск комментариев"
                    placeholder="Найти комментарий…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <div className="dz-filter">
                  <select
                    aria-label="Фильтр комментариев"
                    value={filter}
                    onChange={(e) =>
                      changeFilter(e.target.value as Status | "all")
                    }
                  >
                    {filtered.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                        {f.key !== "all" ? ` · ${data.counts[f.key]}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="dz-list-meta">
                <span>{number(data.total)} комментариев</span>
                <span>{data.settings.channel}</span>
              </div>
              <div className="dz-cards">
                {data.items.length ? (
                  data.items.map((c) => (
                    <button
                      className={`dz-comment-card ${row?.id === c.id ? "selected" : ""}`}
                      key={c.id}
                      onClick={() => setSelected(c.id)}
                    >
                      <div className="dz-card-header">
                        <span className="dz-avatar">
                          {initials(c.author || "Читатель")}
                        </span>
                        <div>
                          <strong>{c.author || "Читатель"}</strong>
                          <small>
                            {c.createdLabel || formatDate(c.discoveredAt)}
                          </small>
                        </div>
                        <Badge status={c.status} />
                      </div>
                      {c.article && (
                        <span className="dz-card-article">{c.article}</span>
                      )}
                      <p>{c.text}</p>
                      {c.reply && (
                        <span className="dz-card-reply">
                          <MessageCircle size={13} /> {c.reply}
                        </span>
                      )}
                    </button>
                  ))
                ) : (
                  <Empty
                    title="Комментарии не найдены"
                    text={
                      filter === "all"
                        ? "Подключите агент, нажмите «Собрать комментарии» или добавьте комментарий вручную."
                        : "Измените фильтр или поисковый запрос."
                    }
                  />
                )}
              </div>
              <div className="dz-list-footer">
                <button
                  className="icon-button"
                  aria-label="Предыдущая страница"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft size={18} />
                </button>
                <span>
                  {page} из {maxPage}
                </span>
                <button
                  className="icon-button"
                  aria-label="Следующая страница"
                  disabled={page >= maxPage}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </section>
            {row ? (
              <ReplyDetail
                key={row.id}
                row={row}
                data={data}
                busy={busy}
                runAction={runAction}
                generate={generate}
              />
            ) : (
              <section className="panel dz-empty-detail">
                <div className="dz-empty-art">
                  <MessageSquare size={35} />
                  <Sparkles size={24} />
                </div>
                <h3>Выберите комментарий</h3>
                <p>
                  Слева появятся обращения читателей. Здесь можно будет
                  подготовить ответ и управлять отправкой.
                </p>
              </section>
            )}
          </div>
        </>
      ) : section === "settings" ? (
        <SettingsPanel data={data} busy={busy} save={save} />
      ) : (
        <section className="panel dz-log-panel">
          <div className="dz-log-title">
            <div>
              <span className="eyebrow">ЖУРНАЛ СОБЫТИЙ / МСК</span>
              <h2>
                История работы
                <TitleDot />
              </h2>
              <p>
                Сбор, подготовка, подтверждение и фактическая отправка ответов.
              </p>
            </div>
            <span className="dz-prompt-version">Последние 50 событий</span>
          </div>
          <ActivityList events={data.events} />
          <div className="dz-log-foot">
            <ShieldCheck size={17} /> События сохраняются в базе данных;
            перезапуск сервиса не стирает очередь.
          </div>
        </section>
      )}
      <div className="dz-bottom-note">
        <ShieldCheck size={17} /> Ответ считается опубликованным только после
        подтверждения в Дзене или ручной проверки сотрудником.
        <span>BG / ZENBOT</span>
      </div>
      {importing && (
        <ImportDialog
          busy={busy}
          onClose={() => setImporting(false)}
          submit={(input) =>
            perform(PATH + "/import", input, "Комментарий добавлен.")
          }
        />
      )}
    </div>
  );
}
