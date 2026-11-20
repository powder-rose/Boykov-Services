import { createDocsSalesModule } from "./modules/docs-sales/index.js";
import { createDocsCommerceModule } from "./modules/docs-commerce/index.js";
import express from "express";
import multer from "multer";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { installAuth } from "./auth.js";
import { createTechnicalModule } from "./modules/technical/index.js";
import { createLeadsModule } from "./modules/leads/index.js";
import { createDocsCustomersModule } from "./modules/docs-customers/index.js";
import { createStatisticsModule } from "./modules/statistics/index.js";
import { createPersonalModule } from "./personal.js";
import { workerClient } from "./worker-client.js";
import { createBatchStore, validId } from "./modules/wordstat/batches.js";
import {
  requestWordstatTop,
  isWordstatConfigured,
} from "./modules/wordstat/wordstat.js";

const regions = {
  all: "Все регионы",
  225: "Россия",
  213: "Москва",
  2: "Санкт-Петербург",
};
export async function createApp(options) {
  await mkdir(options.dataDir, { recursive: true });
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy || false);
  const db = new DatabaseSync(path.join(options.dataDir, "platform.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  app.locals.db = db;
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "same-origin");
    res.set("X-Robots-Tag", "noindex, nofollow");
    if (process.env.NODE_ENV === "production")
      res.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    next();
  });
  app.get("/healthz", (req, res) => res.json({ ok: true }));
  const leads = createLeadsModule(db, options);
  app.post(
    "/hooks/tilda/:siteId",
    express.urlencoded({
      extended: true,
      limit: "128kb",
      parameterLimit: 500,
      depth: 8,
      inflate: false,
    }),
    express.json({ limit: "128kb", inflate: false }),
    leads.receiveTilda,
  );
  app.use("/hooks/leads", express.json({ limit: "128kb", inflate: false }));
  app.post("/hooks/leads/:siteId/heartbeat", leads.heartbeat);
  app.post("/hooks/leads/:siteId", leads.receive);
  app.use(express.json({ limit: "2mb", inflate: false }));
  const technical = createTechnicalModule(db, options);
  app.locals.technical = technical;
  app.post("/hooks/technical/sync", technical.webhook);
  technical.registerPushHooks(app);
  const statistics = await createStatisticsModule(db, options);
  app.locals.statistics = statistics;
  app.post("/hooks/statistics/:siteId", statistics.receive);
  const docsCustomers = createDocsCustomersModule(db, options);
  app.locals.docsCustomers = docsCustomers;
  app.post("/hooks/docs-customers", docsCustomers.receive);
  app.post("/hooks/docs-customers/heartbeat", docsCustomers.heartbeat);
  app.post("/hooks/docs-customers/handshake", docsCustomers.handshake);
  const docsSales = createDocsSalesModule(db, {
    ...options,
    authorize: docsCustomers.authorize,
    configured: () => docsCustomers.connection().configured,
  });
  app.locals.docsSales = docsSales;
  app.post("/hooks/docs-customers/sales", docsSales.receive);
  app.post("/hooks/docs-customers/sales/heartbeat", docsSales.heartbeat);
  app.post("/hooks/docs-customers/sales/handshake", docsSales.handshake);
  const docsCommerce = createDocsCommerceModule(db, {
    ...options,
    authorize: docsCustomers.authorize,
    configured: () => docsCustomers.connection().configured,
  });
  app.locals.docsCommerce = docsCommerce;
  app.post("/hooks/docs-customers/commerce", docsCommerce.receive);
  app.post("/hooks/docs-customers/commerce/heartbeat", docsCommerce.heartbeat);
  app.post("/hooks/docs-customers/commerce/handshake", docsCommerce.handshake);
  installAuth(app, { ...options, db });
  docsCommerce.register(app);
  docsSales.register(app);
  docsCustomers.register(app);
  statistics.register(app);
  leads.register(app);
  technical.registerRoutes(app);
  const worker = options.worker || workerClient(options);
  const personal = createPersonalModule(db, { worker, now: options.now });
  personal.register(app);
  const store = await createBatchStore({
    exportsDir: path.join(options.dataDir, "wordstat"),
    requestWordstat: options.requestWordstat || requestWordstatTop,
    ...(options.batchOptions || {}),
  });
  app.locals.store = store;
  const configured = options.isConfigured || isWordstatConfigured;
  const workerJSON = async (route) => (await worker(route)).json();
  async function documentsState() {
    try {
      return { ...(await workerJSON("/health")), available: true };
    } catch {
      return {
        available: false,
        aiConfigured: false,
        error: "Сервис документов недоступен",
      };
    }
  }
  app.get("/api/system", async (req, res) => {
    res.json({
      documents: await documentsState(),
      wordstat: { configured: configured() },
      sessionHours: 12,
    });
  });
  app.get("/api/dashboard", async (req, res) => {
    let jobs = [],
      documentsAvailable = true;
    try {
      jobs = (await workerJSON("/jobs")).jobs.map(personal.annotate);
    } catch {
      documentsAvailable = false;
    }
    const batches = store.list();
    const events = [
      ...jobs
        .filter((job) => job.kind === "generate")
        .map((job) => ({ ...job, service: "contracts" })),
      ...batches.map((batch) => ({
        id: batch.id,
        service: "wordstat",
        title:
          batch.queries[0] + (batch.total > 1 ? ` +${batch.total - 1}` : ""),
        createdAt: batch.createdAt,
        status: batch.status,
        downloadUrl: batch.downloadUrl,
        error: batch.error,
      })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({
      events,
      documentsAvailable,
      stats: {
        newLeads: db
          .prepare(
            "SELECT count(*) AS count FROM sales_leads WHERE status='new' AND deleted_at IS NULL",
          )
          .get().count,
        documents: jobs.filter(
          (job) => job.kind === "generate" && job.status === "completed",
        ).length,
        batches: batches.filter((batch) => batch.status === "completed").length,
        active: events.filter((event) =>
          ["queued", "running", "waiting", "exporting"].includes(event.status),
        ).length,
      },
    });
  });
  app.get("/api/contracts/jobs", async (req, res) =>
    res.json({ jobs: (await workerJSON("/jobs")).jobs.map(personal.annotate) }),
  );
  app.get("/api/contracts/jobs/:id", async (req, res) => {
    if (!validId(req.params.id))
      return res.status(404).json({ error: "Задача не найдена" });
    res.json(personal.annotate(await workerJSON(`/jobs/${req.params.id}`)));
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 1,
      fields: 4,
      fieldSize: 400000,
    },
  });
  app.post(
    "/api/contracts/extract",
    upload.single("file"),
    async (req, res) => {
      const form = new FormData();
      for (const key of ["text", "mode", "requestId"])
        if (req.body[key]) form.set(key, req.body[key]);
      if (req.file)
        form.set("file", new Blob([req.file.buffer]), req.file.originalname);
      res
        .status(202)
        .json(
          await (
            await worker("/extract", { method: "POST", body: form })
          ).json(),
        );
    },
  );
  app.post("/api/contracts/generate", async (req, res) => {
    await personal.reserve(req);
    const job = await (
      await worker("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      })
    ).json();
    res.status(202).json(personal.annotate(job));
  });
  app.get("/api/contracts/files/:id", async (req, res) => {
    if (!validId(req.params.id))
      return res.status(404).json({ error: "Файл не найден" });
    const response = await worker(`/files/${req.params.id}`);
    res.set("Content-Type", "application/vnd.ms-word.document.macroEnabled.12");
    res.set(
      "Content-Disposition",
      `attachment; filename="contract-${req.params.id}.docm"`,
    );
    await pipeline(Readable.fromWeb(response.body), res);
  });
  app.get("/api/wordstat/batches", (req, res) =>
    res.json({ batches: store.list() }),
  );
  app.post("/api/wordstat/batch/start", async (req, res) => {
    if (!configured())
      return res.status(503).json({
        error: "Wordstat не настроен. Добавьте ключи в .env.wordstat.",
      });
    if (store.busy() || app.locals.starting)
      return res.status(409).json({
        error: "Другой сбор уже выполняется. Дождитесь его завершения.",
      });
    const input = req.body?.queries;
    const regionId = String(req.body?.regionId ?? "all");
    if (
      !Array.isArray(input) ||
      !input.length ||
      input.length > 2000 ||
      input.some(
        (v) => typeof v !== "string" || !v.trim() || v.trim().length > 400,
      )
    )
      return res.status(400).json({
        error: "Нужно от 1 до 2000 запросов, не более 400 символов каждый.",
      });
    if (!Object.hasOwn(regions, regionId))
      return res.status(400).json({ error: "Некорректный регион" });
    app.locals.starting = true;
    try {
      res.status(202).json(
        await store.start({
          queries: [...new Set(input.map((v) => v.trim()))],
          regionId,
          regionName: regions[regionId],
        }),
      );
    } finally {
      app.locals.starting = false;
    }
  });
  app.get("/api/wordstat/batch/:id", (req, res) => {
    const batch = store.get(req.params.id);
    if (!batch) return res.status(404).json({ error: "Сбор не найден" });
    res.json(store.view(batch));
  });
  app.post("/api/wordstat/batch/:id/resume", (req, res) => {
    const batch = store.get(req.params.id);
    if (!batch) return res.status(404).json({ error: "Сбор не найден" });
    if (!configured())
      return res.status(503).json({ error: "Wordstat не настроен" });
    if (store.busy() || app.locals.starting || batch.status !== "paused")
      return res
        .status(409)
        .json({ error: "Этот сбор сейчас нельзя продолжить" });
    store.resume(batch);
    res.json(store.view(batch));
  });
  app.get("/api/files/:id/:fileName", (req, res) => {
    const batch = store.get(req.params.id);
    if (
      !validId(req.params.id) ||
      !batch?.fileName ||
      batch.fileName !== req.params.fileName
    )
      return res.status(404).json({ error: "Файл не найден" });
    res.download(
      path.join(options.dataDir, "wordstat", batch.id, batch.fileName),
      batch.fileName,
      (error) => {
        if (error && !res.headersSent)
          res.status(404).json({ error: "Файл недоступен" });
      },
    );
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Маршрут не найден" }),
  );
  if (options.clientDir) {
    app.use(express.static(options.clientDir, { dotfiles: "deny" }));
    app.get("/{*splat}", (req, res) =>
      res.sendFile(path.join(options.clientDir, "index.html")),
    );
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError)
      return res
        .status(413)
        .json({ error: "Допустим один файл размером до 20 МБ." });
    const status = [400, 401, 403, 404, 409, 413, 415, 422, 429, 503].includes(
      error.status,
    )
      ? error.status
      : 500;
    if (status === 500) console.error("API request failed:", error.name);
    res.status(status).json({
      error:
        status === 500
          ? "Не удалось выполнить запрос. Проверьте доступность сервиса и диска."
          : error.message,
    });
  });
  return app;
}
