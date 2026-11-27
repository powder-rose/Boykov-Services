import { randomUUID } from "node:crypto";
import {
  DEFAULT_SETTINGS,
  STATUSES,
  fail,
  parseSettings,
  studioUrl,
  hasUnansweredFilter,
  sameStudioChannel,
  parseComment,
  isContextIdentity,
  articleAgeOnlyChanged,
  authorMetadataOnlyChanged,
  isOwn,
  validateReply,
  automaticReplyAllowed,
} from "./model.js";

const ACTIVE = "('leased','begun')";
const dateKey = (ms) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const states = new Set([
  "starting",
  "ready",
  "login_required",
  "blocked",
  "interface_changed",
  "error",
]);
const errors = {
  login_required: "Требуется войти в Студию Дзена.",
  blocked: "Дзен ограничил доступ. Агент остановлен.",
  interface_changed: "Не удалось распознать интерфейс Студии.",
  not_found: "Комментарий больше не найден в списке без ответа.",
  ambiguous: "Невозможно однозначно определить комментарий.",
  unavailable: "Студия Дзена недоступна.",
  not_sent: "Отправка не началась. Проверьте комментарий.",
  uncertain: "Дзен не подтвердил публикацию. Проверьте ветку вручную.",
};
const message = (code) => errors[code] || errors.unavailable;

export function createDzenStore(db, now = Date.now) {
  db.function("dzen_fold", (value) =>
    String(value ?? "").toLocaleLowerCase("ru"),
  );
  db.exec(`CREATE TABLE IF NOT EXISTS dzen_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, version INTEGER NOT NULL, prompt_version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dzen_prompt_history (version INTEGER PRIMARY KEY, prompt TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dzen_runtime (id INTEGER PRIMARY KEY CHECK(id=1), agent_id TEXT, studio_url TEXT, status TEXT NOT NULL DEFAULT 'offline', heartbeat INTEGER NOT NULL DEFAULT 0, last_scan INTEGER NOT NULL DEFAULT 0, next_scan INTEGER NOT NULL DEFAULT 0, scan_requested INTEGER NOT NULL DEFAULT 0, next_generate INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', verified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS dzen_comments (id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, external_id TEXT NOT NULL, author TEXT NOT NULL, article TEXT NOT NULL, text TEXT NOT NULL, created_label TEXT NOT NULL, href TEXT NOT NULL, fingerprint TEXT NOT NULL, is_own INTEGER NOT NULL, eligible INTEGER NOT NULL, status TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, prompt_version INTEGER, approval TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', discovered_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, answered_at INTEGER, origin TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS dzen_comments_status ON dzen_comments(status, discovered_at);
    CREATE TABLE IF NOT EXISTS dzen_comment_aliases (legacy_key TEXT NOT NULL, comment_id TEXT NOT NULL, PRIMARY KEY(legacy_key,comment_id));
    CREATE TABLE IF NOT EXISTS dzen_comment_archives (comment_id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dzen_tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, comment_id TEXT, agent_id TEXT NOT NULL, phase TEXT NOT NULL, created_at INTEGER NOT NULL, lease_until INTEGER NOT NULL, begun_at INTEGER, day TEXT, outcome TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS dzen_tasks_phase ON dzen_tasks(phase, lease_until);
    CREATE INDEX IF NOT EXISTS dzen_tasks_day ON dzen_tasks(day);
    CREATE TABLE IF NOT EXISTS dzen_events (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, action TEXT NOT NULL, comment_id TEXT, actor TEXT NOT NULL, detail TEXT NOT NULL);`);
  db.prepare("INSERT OR IGNORE INTO dzen_settings VALUES(1,?,1,1)").run(
    JSON.stringify(DEFAULT_SETTINGS),
  );
  db.prepare("INSERT OR IGNORE INTO dzen_prompt_history VALUES(1,?,?,?)").run(
    DEFAULT_SETTINGS.prompt,
    "Система",
    now(),
  );
  db.prepare("INSERT OR IGNORE INTO dzen_runtime(id) VALUES(1)").run();
  // A stopped AI request has no external publication side effect.
  db.prepare(
    "UPDATE dzen_comments SET status=CASE WHEN reply='' THEN 'new' ELSE 'draft' END, version=version+1, error='Генерация прервалась при перезапуске', updated_at=? WHERE status='generating'",
  ).run(now());

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  function settings() {
    const r = db.prepare("SELECT * FROM dzen_settings WHERE id=1").get();
    return {
      ...JSON.parse(r.data),
      version: r.version,
      promptVersion: r.prompt_version,
    };
  }
  const runtime = () =>
    db.prepare("SELECT * FROM dzen_runtime WHERE id=1").get();
  const get = (id) => {
    const row = db.prepare("SELECT * FROM dzen_comments WHERE id=?").get(id);
    if (!row) throw fail("Комментарий не найден.", 404);
    return row;
  };
  const event = (action, id, actor, detail = "") =>
    db
      .prepare(
        "INSERT INTO dzen_events(created_at,action,comment_id,actor,detail) VALUES(?,?,?,?,?)",
      )
      .run(now(), action, id ?? null, actor || "Система", detail);
  function view(r, s = settings(), connection = runtime()) {
    const ready = Boolean(eligible(r, s, connection));
    const binding =
      r.status === "archived"
        ? "archived"
        : ready
          ? "ready"
          : !r.external_id
            ? "unbound"
            : !connection.verified
              ? "unverified"
              : "not_confirmed";
    return {
      id: r.id,
      commentId: r.external_id,
      author: r.author,
      article: r.article,
      text: r.text,
      createdLabel: r.created_label,
      href: r.href,
      isOwn: !!r.is_own,
      eligible: ready,
      binding,
      status: r.status,
      reply: r.reply,
      version: r.version,
      promptVersion: r.prompt_version,
      approval: r.approval,
      actor: r.actor,
      error: r.error,
      discoveredAt: iso(r.discovered_at),
      updatedAt: iso(r.updated_at),
      answeredAt: iso(r.answered_at),
      origin: r.origin,
    };
  }
  function changed(r, version) {
    if (r.version !== version)
      throw fail("Комментарий изменился. Обновите карточку.", 409);
  }
  function countToday() {
    return db
      .prepare(
        "SELECT count(*) AS n FROM dzen_tasks WHERE day=? AND begun_at IS NOT NULL",
      )
      .get(dateKey(now())).n;
  }
  function pauseWithin(actor, detail = "paused") {
    const current = settings();
    if (current.mode !== "paused") {
      const { version, promptVersion, ...data } = current;
      db.prepare(
        "UPDATE dzen_settings SET data=?,version=version+1 WHERE id=1",
      ).run(JSON.stringify({ ...data, mode: "paused" }));
      db.prepare(
        "UPDATE dzen_comments SET status='draft',approval='',version=version+1,updated_at=?,error='Автоотправка снята после паузы' WHERE status='queued' AND approval='auto'",
      ).run(now());
      event("mode", null, actor, detail);
    }
    return settings();
  }
  const pause = (actor) => tx(() => pauseWithin(actor));
  function expire() {
    for (const task of db
      .prepare(
        `SELECT * FROM dzen_tasks WHERE phase IN ${ACTIVE} AND lease_until<=?`,
      )
      .all(now())) {
      db.prepare(
        "UPDATE dzen_tasks SET phase='expired',outcome='expired' WHERE id=?",
      ).run(task.id);
      if (task.kind === "scan") {
        db.prepare(
          "UPDATE dzen_runtime SET next_scan=?,error=? WHERE id=1",
        ).run(now() + 60000, "Агент не завершил обновление.");
      } else {
        const status = task.phase === "begun" ? "attention" : "draft";
        const detail =
          task.phase === "begun" ? message("uncertain") : message("not_sent");
        db.prepare(
          "UPDATE dzen_comments SET status=?,approval='',error=?,version=version+1,updated_at=? WHERE id=? AND status='sending'",
        ).run(status, detail, now(), task.comment_id);
        event(
          status === "attention" ? "uncertain" : "not_sent",
          task.comment_id,
          "Агент Дзена",
          detail,
        );
        if (status === "attention")
          pauseWithin("Система", "Пауза: проверьте неопределённую публикацию");
      }
    }
  }
  function state(filters = {}) {
    return tx(() => {
      expire();
      const s = settings(),
        r = runtime();
      const counts = Object.fromEntries(STATUSES.map((x) => [x, 0]));
      for (const row of db
        .prepare("SELECT status,count(*) n FROM dzen_comments GROUP BY status")
        .all())
        counts[row.status] = row.n;
      const where = [],
        args = [];
      const readyIds = db
        .prepare(
          "SELECT * FROM dzen_comments WHERE status='draft' AND eligible=1",
        )
        .all()
        .filter((row) => eligible(row, s, r))
        .map((row) => row.id);
      const readyFilter =
        filters.status === "ready" || filters.status === "blocked";
      if (readyFilter) {
        where.push("status='draft'");
        if (readyIds.length) {
          where.push(
            `id ${filters.status === "blocked" ? "NOT IN" : "IN"} (${readyIds.map(() => "?").join(",")})`,
          );
          args.push(...readyIds);
        } else if (filters.status === "ready") where.push("0=1");
      } else if (filters.status && filters.status !== "all") {
        if (!STATUSES.includes(filters.status))
          throw fail("Некорректный статус.");
        where.push("status=?");
        args.push(filters.status);
      } else where.push("status<>'archived'");
      const q =
        typeof filters.q === "string" ? filters.q.trim().slice(0, 200) : "";
      if (q) {
        where.push(
          "(instr(dzen_fold(text),dzen_fold(?))>0 OR instr(dzen_fold(author),dzen_fold(?))>0 OR instr(dzen_fold(article),dzen_fold(?))>0 OR instr(dzen_fold(reply),dzen_fold(?))>0)",
        );
        args.push(q, q, q, q);
      }
      const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      const page = Math.max(
        1,
        Math.min(
          10000,
          Number.isInteger(Number(filters.page)) ? Number(filters.page) : 1,
        ),
      );
      const total = db
        .prepare("SELECT count(*) n FROM dzen_comments" + clause)
        .get(...args).n;
      const items = db
        .prepare(
          "SELECT * FROM dzen_comments" +
            clause +
            (filters.status === "draft"
              ? " ORDER BY eligible DESC,discovered_at DESC,id DESC LIMIT 40 OFFSET ?"
              : " ORDER BY discovered_at DESC,id DESC LIMIT 40 OFFSET ?"),
        )
        .all(...args, (page - 1) * 40)
        .map((row) => view(row, s, r));
      const task = db
        .prepare(
          `SELECT kind,phase,created_at FROM dzen_tasks WHERE phase IN ${ACTIVE} LIMIT 1`,
        )
        .get();
      const online = Boolean(
        r.heartbeat && (now() - r.heartbeat < 90000 || task),
      );
      return {
        settings: s,
        counts,
        draftReady: readyIds.length,
        draftBlocked: counts.draft - readyIds.length,
        items,
        total,
        page,
        pageSize: 40,
        dailyUsed: countToday(),
        answeredToday: db
          .prepare("SELECT count(*) n FROM dzen_comments WHERE answered_at>=?")
          .get(now() - ((now() + 10800000) % 86400000)).n,
        connection: {
          online,
          status: online ? r.status : "offline",
          studioUrl: r.studio_url,
          lastHeartbeat: iso(r.heartbeat),
          lastScan: iso(r.last_scan),
          nextScan: iso(r.next_scan),
          scanRequested: !!r.scan_requested,
          verified: !!r.verified,
          error: r.error,
          task: task
            ? {
                kind: task.kind,
                phase: task.phase,
                createdAt: iso(task.created_at),
              }
            : null,
        },
        events: db
          .prepare("SELECT * FROM dzen_events ORDER BY id DESC LIMIT 50")
          .all()
          .map((e) => ({
            id: e.id,
            createdAt: iso(e.created_at),
            action: e.action,
            commentId: e.comment_id,
            actor: e.actor,
            detail: e.detail,
          })),
        promptHistory: db
          .prepare(
            "SELECT * FROM dzen_prompt_history ORDER BY version DESC LIMIT 20",
          )
          .all()
          .map((e) => ({
            version: e.version,
            prompt: e.prompt,
            actor: e.actor,
            createdAt: iso(e.created_at),
          })),
      };
    });
  }
  function saveSettings(input, actor, autoReady) {
    return tx(() => {
      expire();
      const old = settings(),
        next = parseSettings(input);
      if (input.version !== old.version)
        throw fail("Настройки изменились. Обновите страницу.", 409);
      if (
        next.mode === "auto" &&
        (old.mode !== "auto" || next.prompt !== old.prompt)
      ) {
        if (input.confirmAuto !== true)
          throw fail("Подтвердите автоматическую публикацию.");
        if (!autoReady)
          throw fail(
            "Сначала подключите YandexGPT и проверьте связь со Студией.",
            409,
          );
      }
      let promptVersion = old.promptVersion;
      if (next.prompt !== old.prompt) {
        promptVersion++;
        db.prepare("INSERT INTO dzen_prompt_history VALUES(?,?,?,?)").run(
          promptVersion,
          next.prompt,
          actor,
          now(),
        );
        event("prompt", null, actor, `Промпт v${promptVersion}`);
      }
      db.prepare(
        "UPDATE dzen_settings SET data=?,version=version+1,prompt_version=? WHERE id=1",
      ).run(JSON.stringify(next), promptVersion);
      if (
        next.mode !== "auto" ||
        next.prompt !== old.prompt ||
        next.ownNames !== old.ownNames ||
        next.maxChars !== old.maxChars
      ) {
        db.prepare(
          "UPDATE dzen_comments SET status='draft',approval='',version=version+1,updated_at=?,error='Автоотправка снята после изменения настроек' WHERE status='queued' AND approval='auto'",
        ).run(now());
      }
      if (old.mode !== next.mode) {
        event("mode", null, actor, next.mode);
        if (next.mode !== "paused")
          db.prepare(
            "UPDATE dzen_runtime SET next_scan=0,next_generate=0 WHERE id=1",
          ).run();
      }
      return settings();
    });
  }
  function requestScan(actor) {
    return tx(() => {
      db.prepare("UPDATE dzen_runtime SET scan_requested=1 WHERE id=1").run();
      event("scan_requested", null, actor);
      return { ok: true };
    });
  }
  function ingest(
    item,
    source,
    origin,
    duplicate = false,
    legacySeen = new Map(),
  ) {
    const s = settings();
    const existing = db
      .prepare("SELECT * FROM dzen_comments WHERE source_key=?")
      .get(item.key);
    const own = isOwn(item, s);
    const eligible = item.eligible && !own && !duplicate;
    const rememberAlias = (id) => {
      if (origin === "studio" && item.legacyKey)
        return db
          .prepare(
            "INSERT OR IGNORE INTO dzen_comment_aliases(legacy_key,comment_id) VALUES(?,?)",
          )
          .run(item.legacyKey, id).changes;
      return 0;
    };
    const sameVisibleContext =
      existing &&
      item.externalId.startsWith("context_ui_") &&
      existing.origin === "studio" &&
      existing.external_id === item.externalId &&
      authorMetadataOnlyChanged(existing.author, item.author) &&
      existing.text === item.text &&
      existing.href === item.href &&
      articleAgeOnlyChanged(existing.article, item.article);
    if (
      origin === "studio" &&
      item.externalId &&
      (item.legacyKey || existing)
    ) {
      let legacy = item.legacyKey
        ? db
            .prepare(
              "SELECT * FROM dzen_comments WHERE source_key=? AND origin='studio' AND external_id='' ",
            )
            .get(item.legacyKey)
        : null;
      if (!legacy && existing && sameVisibleContext) {
        const known = db
          .prepare(
            "SELECT c.* FROM dzen_comment_aliases a JOIN dzen_comments c ON c.source_key=a.legacy_key WHERE a.comment_id=? AND c.origin='studio' AND c.external_id='' LIMIT 2",
          )
          .all(existing.id);
        if (known.length === 1 && !(legacySeen.get(known[0].source_key) || 0))
          legacy = known[0];
      }
      if (legacy) {
        const legacyCount = legacySeen.get(legacy.source_key) || 0;
        const knownTargets = db
          .prepare(
            "SELECT comment_id FROM dzen_comment_aliases WHERE legacy_key=?",
          )
          .all(legacy.source_key);
        const unique =
          legacy.source_key === item.legacyKey
            ? legacyCount === 1
            : legacyCount === 0 &&
              existing &&
              knownTargets.some((row) => row.comment_id === existing.id);
        const conflictingAlias = knownTargets.some(
          (row) =>
            row.comment_id !== existing?.id && row.comment_id !== legacy.id,
        );
        const archived =
          legacy.status === "archived" &&
          existing &&
          db
            .prepare(
              "SELECT 1 FROM dzen_comment_archives WHERE comment_id=? AND canonical_id=?",
            )
            .get(legacy.id, existing.id);
        const safeExisting =
          existing &&
          sameVisibleContext &&
          eligible &&
          unique &&
          !conflictingAlias &&
          ["new", "draft", "error"].includes(legacy.status) &&
          !legacy.answered_at &&
          !db
            .prepare(
              "SELECT 1 FROM dzen_tasks WHERE comment_id=? AND begun_at IS NOT NULL LIMIT 1",
            )
            .get(legacy.id);
        if (archived && unique && !conflictingAlias) {
          // The preserved old card must not reserve a second publication.
        } else if (safeExisting) {
          rememberAlias(existing.id);
          if (
            ["new", "error"].includes(existing.status) &&
            !existing.reply &&
            legacy.status === "draft" &&
            legacy.reply
          ) {
            db.prepare(
              "UPDATE dzen_comments SET status='draft',reply=?,prompt_version=?,actor=?,version=version+1,updated_at=? WHERE id=?",
            ).run(
              legacy.reply,
              legacy.prompt_version,
              legacy.actor,
              now(),
              existing.id,
            );
          }
          db.prepare(
            "INSERT INTO dzen_comment_archives(comment_id,canonical_id) VALUES(?,?)",
          ).run(legacy.id, existing.id);
          db.prepare(
            "UPDATE dzen_comments SET status='archived',eligible=0,approval='',error='Дубликат подтверждённой карточки. Текст ответа сохранён в архиве.',version=version+1,updated_at=? WHERE id=?",
          ).run(now(), legacy.id);
          event(
            "binding",
            existing.id,
            "Агент Дзена",
            "Связана прежняя карточка без ID; дополнительный текст и история сохранены в архиве дублей.",
          );
          event(
            "binding_archive",
            legacy.id,
            "Агент Дзена",
            "Дубликат архивирован; ответ и история сохранены.",
          );
        } else if (
          existing ||
          !eligible ||
          !unique ||
          conflictingAlias ||
          legacy.status === "archived" ||
          ["generating", "sending"].includes(legacy.status)
        ) {
          if (existing)
            db.prepare("UPDATE dzen_comments SET eligible=0 WHERE id=?").run(
              existing.id,
            );
          return false;
        } else {
          db.prepare(
            "UPDATE dzen_comments SET source_key=?,external_id=?,author=?,article=?,href=?,fingerprint=?,is_own=?,eligible=?,created_label=?,last_seen=?,updated_at=?,version=version+1,approval='',status=CASE WHEN status='queued' THEN 'draft' ELSE status END WHERE id=?",
          ).run(
            item.key,
            item.externalId,
            item.author,
            item.article,
            item.href,
            item.fingerprint,
            Number(own),
            Number(eligible),
            item.created,
            now(),
            now(),
            legacy.id,
          );
          rememberAlias(legacy.id);
          event(
            "binding",
            legacy.id,
            "Агент Дзена",
            "Уточнена привязка; сохранены черновик и история. Проверьте статью и автора перед отправкой.",
          );
          return false;
        }
      }
    }
    if (
      origin === "studio" &&
      !item.externalId &&
      !existing &&
      db
        .prepare(
          "SELECT 1 FROM dzen_comment_aliases WHERE legacy_key=? LIMIT 1",
        )
        .get(item.key)
    )
      return false;
    if (existing) {
      if (existing.fingerprint !== item.fingerprint) {
        if (sameVisibleContext) {
          db.prepare(
            "UPDATE dzen_comments SET author=?,article=?,fingerprint=?,eligible=?,is_own=?,last_seen=?,created_label=? WHERE id=?",
          ).run(
            item.author,
            item.article,
            item.fingerprint,
            Number(eligible),
            Number(own),
            now(),
            item.created,
            existing.id,
          );
          rememberAlias(existing.id);
          return false;
        }
        if (!["answered", "attention", "sending"].includes(existing.status))
          db.prepare(
            "UPDATE dzen_comments SET status='attention',eligible=0,approval='',error='Текст или автор изменился в Студии. Проверьте вручную.',version=version+1,updated_at=?,last_seen=? WHERE id=?",
          ).run(now(), now(), existing.id);
        return false;
      }
      db.prepare(
        "UPDATE dzen_comments SET eligible=?,is_own=?,last_seen=?,created_label=? WHERE id=?",
      ).run(Number(eligible), Number(own), now(), item.created, existing.id);
      rememberAlias(existing.id);
      return false;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO dzen_comments(id,source_key,external_id,author,article,text,created_label,href,fingerprint,is_own,eligible,status,error,discovered_at,updated_at,last_seen,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      item.key,
      item.externalId,
      item.author,
      item.article,
      item.text,
      item.created,
      item.href || source || "",
      item.fingerprint,
      Number(own),
      Number(eligible),
      own ? "skipped" : "new",
      own ? "Комментарий собственного канала" : "",
      now(),
      now(),
      now(),
      origin,
    );
    rememberAlias(id);
    return true;
  }
  function addManual(input, actor) {
    return tx(() => {
      const item = parseComment(
        { ...input, commentId: "", canReply: false },
        "",
        false,
      );
      const added = ingest(item, "", "manual");
      event(
        "manual_import",
        null,
        actor,
        added ? "Добавлен комментарий" : "Комментарий уже есть",
      );
      return { ok: true, added };
    });
  }
  function taskView(task) {
    return {
      id: task.id,
      kind: task.kind,
      ...(task.kind === "publish"
        ? { comment: view(get(task.comment_id)) }
        : {}),
    };
  }
  function eligible(row, s, r) {
    return (
      !!row.eligible &&
      !!row.external_id &&
      !isOwn({ author: row.author, isOwn: !!row.is_own }, s) &&
      r.verified &&
      r.last_scan &&
      now() - r.last_scan <= Math.max(15, s.scanMinutes + 5) * 60000 &&
      row.last_seen >= r.last_scan - 1000
    );
  }
  function poll(input) {
    return tx(() => {
      expire();
      const id = input?.agentId;
      if (
        typeof id !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(id) ||
        !states.has(input.status)
      )
        throw fail("Некорректный статус агента.");
      const url = studioUrl(input.studioUrl);
      let r = runtime();
      const filterChanged = r.studio_url && r.studio_url !== url;
      if (filterChanged && !sameStudioChannel(r.studio_url, url))
        throw fail(
          "Этот раздел уже связан с другой ссылкой Студии. Смена канала требует отдельной настройки.",
          409,
        );
      if (
        r.agent_id &&
        r.agent_id !== id &&
        (now() - r.heartbeat < 90000 ||
          db
            .prepare(
              `SELECT id FROM dzen_tasks WHERE phase IN ${ACTIVE} LIMIT 1`,
            )
            .get())
      )
        throw fail("Другой агент уже подключён.", 409);
      if (filterChanged) {
        // Only the already paired agent may move to a proven unanswered URL
        // on the same channel. Never carry verification or approvals across it.
        if (
          r.agent_id !== id ||
          input.status !== "starting" ||
          !hasUnansweredFilter(url) ||
          db
            .prepare(
              `SELECT id FROM dzen_tasks WHERE phase IN ${ACTIVE} LIMIT 1`,
            )
            .get()
        )
          throw fail(
            "Остановите прежний агент и завершите активное задание перед сменой фильтра.",
            409,
          );
        pauseWithin("Система", "Пауза: обновлён фильтр комментариев Дзена");
        db.prepare(
          "UPDATE dzen_comments SET eligible=0 WHERE origin='studio'",
        ).run();
        db.prepare(
          "UPDATE dzen_comments SET status='draft',approval='',error='Проверьте ответ после смены фильтра',version=version+1,updated_at=? WHERE status='queued'",
        ).run(now());
        db.prepare(
          "UPDATE dzen_runtime SET verified=0,last_scan=0,next_scan=0,next_generate=0,error='' WHERE id=1",
        ).run();
        event(
          "filter_updated",
          null,
          "Система",
          "Фильтр обновлён; канал и история сохранены",
        );
        r = runtime();
      }
      const agentError = [
        "login_required",
        "blocked",
        "interface_changed",
        "error",
      ].includes(input.status)
        ? message(input.status)
        : r.error;
      db.prepare(
        "UPDATE dzen_runtime SET agent_id=?,studio_url=?,status=?,heartbeat=?,error=? WHERE id=1",
      ).run(id, url, input.status, now(), agentError);
      if (!["starting", "ready"].includes(input.status)) {
        db.prepare("UPDATE dzen_runtime SET verified=0 WHERE id=1").run();
        pauseWithin("Система", "Пауза: проверьте подключение к Студии");
        return { task: null, waitSeconds: 30 };
      }
      if (
        db
          .prepare(`SELECT id FROM dzen_tasks WHERE phase IN ${ACTIVE} LIMIT 1`)
          .get()
      )
        return { task: null, waitSeconds: 10 };
      const s = settings();
      let task = null;
      if (
        r.scan_requested ||
        (s.mode !== "paused" &&
          (r.next_scan <= now() || input.status === "starting"))
      ) {
        task = { id: randomUUID(), kind: "scan", comment_id: null };
        db.prepare(
          "UPDATE dzen_runtime SET scan_requested=0,next_scan=? WHERE id=1",
        ).run(now() + s.scanMinutes * 60000);
      } else if (
        s.mode !== "paused" &&
        input.status === "ready" &&
        countToday() < s.dailyLimit
      ) {
        const queued = db
          .prepare(
            "SELECT * FROM dzen_comments WHERE status='queued' ORDER BY updated_at,id LIMIT 100",
          )
          .all();
        for (const row of queued) {
          if (
            !eligible(row, s, r) ||
            row.reply.length > s.maxChars ||
            !row.reply ||
            (row.approval === "auto" &&
              (s.mode !== "auto" ||
                isContextIdentity(row.external_id) ||
                row.prompt_version !== s.promptVersion ||
                !automaticReplyAllowed(row.reply)))
          ) {
            db.prepare(
              "UPDATE dzen_comments SET status='draft',approval='',error='Нужно обновить комментарий или повторно подтвердить ответ',version=version+1,updated_at=? WHERE id=?",
            ).run(now(), row.id);
            continue;
          }
          task = { id: randomUUID(), kind: "publish", comment_id: row.id };
          db.prepare(
            "UPDATE dzen_comments SET status='sending',version=version+1,updated_at=?,error='' WHERE id=?",
          ).run(now(), row.id);
          break;
        }
      }
      if (!task) return { task: null, waitSeconds: 15 };
      db.prepare(
        "INSERT INTO dzen_tasks(id,kind,comment_id,agent_id,phase,created_at,lease_until) VALUES(?,?,?,?,'leased',?,?)",
      ).run(
        task.id,
        task.kind,
        task.comment_id,
        id,
        now(),
        now() + (task.kind === "scan" ? 240000 : 120000),
      );
      return { task: taskView(task), waitSeconds: 5 };
    });
  }
  function leased(input) {
    const task = db
      .prepare("SELECT * FROM dzen_tasks WHERE id=? AND agent_id=?")
      .get(input?.taskId ?? "", input?.agentId ?? "");
    if (!task) throw fail("Задание не найдено.", 404);
    return task;
  }
  function begin(input) {
    return tx(() => {
      expire();
      const task = leased(input);
      if (task.kind !== "publish" || task.phase !== "leased")
        throw fail("Разрешение на отправку уже выдано или истекло.", 409);
      const s = settings(),
        r = runtime(),
        row = get(task.comment_id);
      if (
        s.mode === "paused" ||
        r.status !== "ready" ||
        row.status !== "sending" ||
        !eligible(row, s, r) ||
        countToday() >= s.dailyLimit ||
        row.reply.length > s.maxChars ||
        (row.approval === "auto" &&
          (s.mode !== "auto" ||
            isContextIdentity(row.external_id) ||
            row.prompt_version !== s.promptVersion ||
            !automaticReplyAllowed(row.reply)))
      )
        throw fail("Публикация остановлена настройками или лимитом.", 409);
      db.prepare(
        "UPDATE dzen_tasks SET phase='begun',begun_at=?,day=?,lease_until=? WHERE id=?",
      ).run(now(), dateKey(now()), now() + 120000, task.id);
      event("sending", row.id, "Агент Дзена");
      return { ok: true };
    });
  }
  function result(input) {
    return tx(() => {
      expire();
      const task = leased(input);
      if (task.phase === "done") return { ok: true, replayed: true };
      if (!["leased", "begun"].includes(task.phase))
        throw fail("Срок задания истёк. Проверьте его в журнале.", 409);
      const r = runtime(),
        s = settings();
      const outcome = input.outcome,
        code = typeof input.code === "string" ? input.code : "unavailable";
      if (task.kind === "scan") {
        if (outcome === "success") {
          if (
            !Array.isArray(input.comments) ||
            input.comments.length > 250 ||
            typeof input.verifiedUnanswered !== "boolean"
          )
            throw fail("Некорректный пакет комментариев.");
          const verified =
            input.verifiedUnanswered && hasUnansweredFilter(r.studio_url);
          const parsed = input.comments.map((x) =>
              parseComment(x, r.studio_url, verified),
            ),
            seen = new Map(),
            legacySeen = new Map();
          for (const item of parsed) {
            seen.set(item.key, (seen.get(item.key) || 0) + 1);
            const legacy = item.legacyKey || (!item.externalId ? item.key : "");
            if (legacy)
              legacySeen.set(legacy, (legacySeen.get(legacy) || 0) + 1);
          }
          let added = 0;
          db.prepare(
            "UPDATE dzen_comments SET eligible=0 WHERE origin='studio'",
          ).run();
          for (const item of parsed)
            if (
              ingest(
                item,
                r.studio_url,
                "studio",
                seen.get(item.key) > 1,
                legacySeen,
              )
            )
              added++;
          db.prepare(
            "UPDATE dzen_runtime SET last_scan=?,heartbeat=?,status='ready',verified=?,error='',next_scan=?,next_generate=0 WHERE id=1",
          ).run(now(), now(), Number(verified), now() + s.scanMinutes * 60000);
          event(
            "scan",
            null,
            "Агент Дзена",
            `Получено ${parsed.length}, новых ${added}${verified ? " · без ответа" : " · фильтр не подтверждён"}`,
          );
        } else if (outcome === "error") {
          const status = states.has(code) ? code : "error";
          db.prepare(
            "UPDATE dzen_runtime SET status=?,heartbeat=?,error=?,verified=0,next_scan=? WHERE id=1",
          ).run(status, now(), message(code), now() + s.scanMinutes * 60000);
          event("scan_error", null, "Агент Дзена", message(code));
          pauseWithin("Система", "Пауза: проверьте подключение к Студии");
        } else throw fail("Некорректный результат сканирования.");
      } else {
        if (!["sent", "not_sent", "uncertain"].includes(outcome))
          throw fail("Некорректный результат публикации.");
        if (outcome === "sent" && task.phase !== "begun")
          throw fail("Публикация не была разрешена.", 409);
        const status =
          outcome === "sent"
            ? "answered"
            : task.phase === "begun" || outcome === "uncertain"
              ? "attention"
              : "draft";
        const detail =
          status === "answered"
            ? ""
            : status === "attention"
              ? message("uncertain")
              : message(code);
        db.prepare(
          "UPDATE dzen_comments SET status=?,approval='',version=version+1,error=?,updated_at=?,answered_at=CASE WHEN ?='answered' THEN ? ELSE answered_at END WHERE id=? AND status='sending'",
        ).run(status, detail, now(), status, now(), task.comment_id);
        db.prepare("UPDATE dzen_runtime SET heartbeat=? WHERE id=1").run(now());
        event(
          status === "answered"
            ? "sent"
            : status === "attention"
              ? "uncertain"
              : "not_sent",
          task.comment_id,
          "Агент Дзена",
          detail,
        );
        if (["blocked", "login_required", "interface_changed"].includes(code))
          db.prepare(
            "UPDATE dzen_runtime SET status=?,verified=0,error=? WHERE id=1",
          ).run(code, message(code));
        if (
          status === "attention" ||
          ["blocked", "login_required", "interface_changed"].includes(code)
        )
          pauseWithin("Система", "Пауза: проверьте результат в Студии");
      }
      db.prepare("UPDATE dzen_tasks SET phase='done',outcome=? WHERE id=?").run(
        outcome,
        task.id,
      );
      return { ok: true };
    });
  }
  function action(id, input, actor) {
    return tx(() => {
      if (!input || !Number.isInteger(input.version))
        throw fail("Некорректная версия комментария.");
      expire();
      const row = get(id),
        s = settings(),
        r = runtime();
      changed(row, input.version);
      let status = row.status,
        reply = row.reply,
        error = "",
        approval = "",
        answered = row.answered_at;
      if (
        input.action === "save" &&
        ["new", "draft", "error", "skipped"].includes(status)
      ) {
        reply = validateReply(input.reply, s.maxChars);
        status = "draft";
      } else if (input.action === "queue" && status === "draft") {
        if (s.mode === "paused") throw fail("Сначала снимите паузу.", 409);
        if (!eligible(row, s, r))
          throw fail(
            "Комментарий не подтверждён в списке без ответа. Обновите Студию или ответьте вручную.",
            409,
          );
        if (countToday() >= s.dailyLimit)
          throw fail("Дневной лимит исчерпан.", 409);
        reply = validateReply(input.reply ?? row.reply, s.maxChars);
        status = "queued";
        approval = "manual";
      } else if (input.action === "cancel" && status === "queued") {
        status = "draft";
      } else if (
        input.action === "skip" &&
        ["new", "draft", "error"].includes(status)
      ) {
        status = "skipped";
        error = "Пропущен сотрудником";
      } else if (
        input.action === "reopen" &&
        ["skipped", "error"].includes(status)
      ) {
        status = reply ? "draft" : "new";
      } else if (
        input.action === "confirm" &&
        ["attention", "draft", "new", "error"].includes(status) &&
        input.confirm === true
      ) {
        reply = validateReply(input.reply ?? row.reply, s.maxChars);
        status = "answered";
        answered = now();
      } else if (
        input.action === "not_sent" &&
        status === "attention" &&
        input.confirm === true
      ) {
        status = reply ? "draft" : "new";
        error = "Сотрудник проверил: ответ не опубликован";
      } else throw fail("Действие недоступно для этого статуса.", 409);
      db.prepare(
        "UPDATE dzen_comments SET status=?,reply=?,error=?,approval=?,actor=?,answered_at=?,version=version+1,updated_at=? WHERE id=?",
      ).run(status, reply, error, approval, actor, answered, now(), id);
      event(input.action, id, actor);
      return view(get(id));
    });
  }
  function startGeneration(id, version, automatic = false) {
    return tx(() => {
      const row = get(id),
        s = settings();
      if (version !== null) changed(row, version);
      if (
        !["new", "draft", "error", "skipped"].includes(row.status) ||
        (automatic &&
          (s.mode === "paused" ||
            row.status !== "new" ||
            row.origin !== "studio" ||
            !eligible(row, s, runtime())))
      )
        throw fail("Генерация недоступна.", 409);
      if (isOwn({ author: row.author, isOwn: !!row.is_own }, s))
        throw fail("Это комментарий собственного канала.", 409);
      db.prepare(
        "UPDATE dzen_comments SET status='generating',version=version+1,updated_at=?,error='' WHERE id=?",
      ).run(now(), id);
      return { comment: view(get(id)), settings: s };
    });
  }
  function finishGeneration(
    id,
    version,
    generated,
    snapshot,
    automatic,
    actor,
    error = "",
  ) {
    return tx(() => {
      const row = get(id);
      if (row.version !== version || row.status !== "generating")
        return view(row);
      const s = settings(),
        r = runtime();
      let status = error ? "error" : generated ? "draft" : "skipped",
        approval = "",
        reply = error ? row.reply : generated;
      if (!error && !generated) error = "ИИ предложил пропустить комментарий";
      if (
        automatic &&
        status === "draft" &&
        s.mode === "auto" &&
        snapshot.version === s.version &&
        eligible(row, s, r) &&
        !isContextIdentity(row.external_id) &&
        automaticReplyAllowed(reply) &&
        countToday() < s.dailyLimit
      ) {
        status = "queued";
        approval = "auto";
      }
      db.prepare(
        "UPDATE dzen_comments SET status=?,reply=?,prompt_version=?,approval=?,actor=?,error=?,version=version+1,updated_at=? WHERE id=?",
      ).run(
        status,
        reply,
        snapshot.promptVersion,
        approval,
        actor,
        error,
        now(),
        id,
      );
      event(
        error && status === "error"
          ? "ai_error"
          : status === "queued"
            ? "auto_queue"
            : status === "skipped"
              ? "ai_skip"
              : "generated",
        id,
        actor,
        error,
      );
      return view(get(id));
    });
  }
  function reserveAutoBatch() {
    return tx(() => {
      expire();
      const s = settings(),
        r = runtime();
      if (
        s.mode === "paused" ||
        r.next_generate > now() ||
        !r.last_scan ||
        r.status !== "ready" ||
        now() - r.heartbeat > 90000
      )
        return [];
      db.prepare("UPDATE dzen_runtime SET next_generate=? WHERE id=1").run(
        now() + s.scanMinutes * 60000,
      );
      return db
        .prepare(
          "SELECT * FROM dzen_comments WHERE status='new' AND origin='studio' AND is_own=0 AND eligible=1 AND external_id<>'' AND last_seen>=? ORDER BY discovered_at,id",
        )
        .all(r.last_scan - 1000)
        .filter((row) => eligible(row, s, r))
        .slice(0, s.batchLimit)
        .map((x) => x.id);
    });
  }
  return {
    state,
    settings,
    runtime,
    saveSettings,
    pause,
    requestScan,
    addManual,
    poll,
    begin,
    result,
    action,
    startGeneration,
    finishGeneration,
    reserveAutoBatch,
  };
}
