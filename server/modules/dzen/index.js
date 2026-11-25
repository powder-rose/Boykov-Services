import { timingSafeEqual } from "node:crypto";
import { createDzenStore } from "./store.js";
import { createDzenAi } from "./ai.js";
import {
  cleanReply,
  digest,
  fail,
  parseSettings,
  parseComment,
} from "./model.js";

export function createDzenModule(db, options = {}) {
  const now = options.now || Date.now;
  const config = options.dzen || {};
  const token = config.token ?? process.env.DZEN_AGENT_TOKEN ?? "";
  const agentConfigured = token.length >= 32;
  const tokenDigest = Buffer.from(digest(token), "hex");
  const ai =
    config.ai ||
    createDzenAi({
      folderId: config.folderId ?? process.env.DZEN_YANDEX_FOLDER_ID,
      apiKey: config.apiKey ?? process.env.DZEN_YANDEX_API_KEY,
    });
  const store = createDzenStore(db, now);
  let generating = false,
    stopped = false;
  const actor = (req) => {
    if (!req.actor?.id || !["admin", "sales"].includes(req.actor.role))
      throw fail("Войдите в личный аккаунт для работы с комментариями.", 403);
    return req.actor.name;
  };
  const admin = (req) => {
    if (req.actor?.role !== "admin" || !req.actor.id)
      throw fail("Настройки доступны администратору.", 403);
    return req.actor.name;
  };
  function agent(req, res, next) {
    res.set("Cache-Control", "no-store");
    if (!agentConfigured)
      return res
        .status(503)
        .json({ error: "Подключение агента не настроено." });
    const header = req.headers.authorization;
    if (
      typeof header !== "string" ||
      header.length > 512 ||
      !header.startsWith("Bearer ") ||
      !timingSafeEqual(tokenDigest, Buffer.from(digest(header.slice(7)), "hex"))
    )
      return res.status(401).json({ error: "Недействительный ключ агента." });
    next();
  }
  async function generate(id, version, automatic, name) {
    const job = store.startGeneration(id, version, automatic);
    let reply = "",
      error = "";
    try {
      reply = cleanReply(
        await ai.generate(job.settings, job.comment),
        job.settings.maxChars,
      );
    } catch (e) {
      error =
        e?.status === 503 && typeof e.message === "string"
          ? e.message.slice(0, 200)
          : "Не удалось подготовить ответ. Повторите позже.";
    }
    if (stopped) return null;
    return store.finishGeneration(
      id,
      job.comment.version,
      reply,
      job.settings,
      automatic,
      name,
      error,
    );
  }
  async function tick() {
    if (stopped || generating || !ai.configured || !agentConfigured) return;
    generating = true;
    try {
      for (const id of store.reserveAutoBatch()) {
        if (stopped || store.settings().mode === "paused") break;
        try {
          const result = await generate(id, null, true, "Zenbot · ИИ");
          if (result?.status === "error") break;
        } catch (e) {
          if (e?.status !== 409) break;
        }
      }
    } catch (e) {
      if (!stopped)
        console.error("Dzen generation scheduler:", e?.name || "Error");
    } finally {
      generating = false;
    }
  }
  const timer =
    agentConfigured && ai.configured && config.autoTick !== false
      ? setInterval(() => void tick(), 15000)
      : null;
  timer?.unref();
  function registerHooks(app) {
    app.post("/hooks/dzen/poll", agent, (req, res) =>
      res.json(store.poll(req.body)),
    );
    app.post("/hooks/dzen/begin", agent, (req, res) =>
      res.json(store.begin(req.body)),
    );
    app.post("/hooks/dzen/result", agent, (req, res) =>
      res.json(store.result(req.body)),
    );
  }
  function register(app) {
    const prefix = "/api/dzen";
    app.use(prefix, (_req, res, next) => {
      res.set("Cache-Control", "private, no-store");
      next();
    });
    app.post(prefix + "/pause", (req, res) =>
      res.json(store.pause(actor(req))),
    );
    app.get(prefix, (req, res) =>
      res.json({
        ...store.state(req.query),
        integration: { agentConfigured, aiConfigured: !!ai.configured },
        permissions: {
          edit: !!req.actor?.id && ["admin", "sales"].includes(req.actor.role),
          settings: req.actor?.role === "admin" && !!req.actor?.id,
        },
      }),
    );
    app.post(prefix + "/settings", (req, res) => {
      const name = admin(req),
        r = store.runtime();
      res.json(
        store.saveSettings(
          req.body,
          name,
          agentConfigured &&
            !!ai.configured &&
            r.verified &&
            r.status === "ready" &&
            now() - r.heartbeat < 90000,
        ),
      );
    });
    app.post(prefix + "/scan", (req, res) => {
      const name = actor(req);
      if (!agentConfigured)
        throw fail("Сначала задайте ключ подключения агента.", 503);
      res.json(store.requestScan(name));
    });
    app.post(prefix + "/preview", async (req, res) => {
      admin(req);
      if (!ai.configured) throw fail("Подключите YandexGPT для Дзена.", 503);
      if (generating) throw fail("ИИ уже подготавливает ответы.", 409);
      const settings = parseSettings({
        ...store.settings(),
        mode: "review",
        prompt: req.body?.prompt,
        maxChars: req.body?.maxChars,
      });
      const comment = parseComment(
        {
          text: req.body?.text,
          author: "Тестовый читатель",
          articleTitle: req.body?.articleTitle ?? "",
        },
        "",
        false,
      );
      generating = true;
      try {
        const reply = cleanReply(
          await ai.generate(settings, comment),
          settings.maxChars,
        );
        res.json({ reply, skipped: !reply });
      } finally {
        generating = false;
      }
    });
    app.post(prefix + "/import", (req, res) =>
      res.json(store.addManual(req.body, actor(req))),
    );
    app.post(prefix + "/comments/:id/action", (req, res) =>
      res.json(store.action(req.params.id, req.body, actor(req))),
    );
    app.post(prefix + "/comments/:id/generate", async (req, res) => {
      const name = actor(req);
      if (!ai.configured) throw fail("Подключите YandexGPT для Дзена.", 503);
      if (generating)
        throw fail(
          "ИИ уже подготавливает ответы. Повторите через несколько секунд.",
          409,
        );
      if (!Number.isInteger(req.body?.version))
        throw fail("Некорректная версия комментария.");
      generating = true;
      try {
        res.json(await generate(req.params.id, req.body.version, false, name));
      } finally {
        generating = false;
      }
    });
  }
  return {
    registerHooks,
    register,
    store,
    tick,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
