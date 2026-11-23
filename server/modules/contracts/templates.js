import templates from "../../../shared/templates.json" with { type: "json" };
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ids = new Set(templates.map((entry) => entry.id));
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const editable = (req) =>
  Boolean(req.actor?.id && ["admin", "sales"].includes(req.actor.role));
const actor = (req) => {
  if (!editable(req))
    throw fail("Войдите в личный аккаунт для изменения общих шаблонов.", 403);
  return { actorId: req.actor.id, actorName: req.actor.name };
};
const checkEditor = (req, _res, next) => {
  try {
    actor(req);
    next();
  } catch (error) {
    next(error);
  }
};
const route = (req, suffix = "") => {
  const { id } = req.params;
  if (!ids.has(id)) throw fail("Шаблон не найден.", 404);
  return "/templates/" + id + suffix;
};
const version = (value) => {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw fail("Некорректная версия шаблона.");
  return parsed;
};
const fileName = (value) => {
  // Multipart clients commonly send UTF-8 filenames in header parameters.
  if ([...value].every((char) => char.charCodeAt(0) <= 255)) {
    const decoded = Buffer.from(value, "latin1").toString("utf8");
    if (!decoded.includes("\uFFFD")) return decoded;
  }
  return value;
};

const validFormat = (format) =>
  format === undefined ||
  (format !== null &&
    typeof format === "object" &&
    !Array.isArray(format) &&
    Object.entries(format).every(([key, value]) => {
      if (key === "align")
        return ["left", "center", "right", "justify"].includes(value);
      if (key === "fontSize")
        return Number.isInteger(value) && value >= 8 && value <= 36;
      return (
        ["bold", "italic", "underline"].includes(key) &&
        typeof value === "boolean"
      );
    }));

function templateChanges(req) {
  const input = req.body || {};
  if (
    !Array.isArray(input.changes) ||
    input.changes.length > 1000 ||
    input.changes.some(
      (c) =>
        !c ||
        typeof c.id !== "string" ||
        c.id.length > 100 ||
        typeof c.text !== "string" ||
        c.text.length > 8000 ||
        !validFormat(c.format),
    ) ||
    (input.note !== undefined &&
      (typeof input.note !== "string" || input.note.length > 300))
  )
    throw fail("Проверьте изменения шаблона.");
  return {
    expectedVersion: version(input.expectedVersion),
    draftId: input.draftId || null,
    changes: input.changes.map(({ id, text, format }) => ({
      id,
      text,
      ...(format ? { format } : {}),
    })),
    note: input.note || "",
    ...actor(req),
  };
}

export function registerTemplateRoutes(app, worker, upload) {
  const prefix = "/api/contracts/templates";
  const json = async (url, body) =>
    (
      await worker(
        url,
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      )
    ).json();
  app.use(prefix, (_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });
  app.get(prefix, async (req, res) =>
    res.json({ ...(await json("/templates")), canEdit: editable(req) }),
  );
  app.get(prefix + "/:id/history", async (req, res) =>
    res.json(await json(route(req, "/history"))),
  );
  app.get(prefix + "/:id/editor", checkEditor, async (req, res) =>
    res.json(
      await json(
        route(req, "/editor?owner=" + encodeURIComponent(actor(req).actorId)),
      ),
    ),
  );
  app.get(prefix + "/:id/preview", async (req, res) =>
    res.json(await json(route(req, "/preview"))),
  );
  app.post(prefix + "/:id/preview", checkEditor, async (req, res) =>
    res.json(await json(route(req, "/preview"), templateChanges(req))),
  );
  app.post(
    prefix + "/:id/draft",
    checkEditor,
    upload.single("file"),
    async (req, res) => {
      if (!req.file || !/\.(docx|docm)$/i.test(req.file.originalname))
        throw fail("Выберите файл DOCX или DOCM.", 415);
      const form = new FormData();
      form.set("expectedVersion", String(version(req.body.expectedVersion)));
      form.set("actorId", actor(req).actorId);
      form.set(
        "file",
        new Blob([req.file.buffer]),
        fileName(req.file.originalname),
      );
      res.json(
        await (
          await worker(route(req, "/draft"), { method: "POST", body: form })
        ).json(),
      );
    },
  );
  app.post(prefix + "/:id/discard", checkEditor, async (req, res) =>
    res.json(await json(route(req, "/discard"), actor(req))),
  );
  app.post(prefix + "/:id/publish", checkEditor, async (req, res) =>
    res.json(await json(route(req, "/publish"), templateChanges(req))),
  );
  app.post(prefix + "/:id/restore", checkEditor, async (req, res) =>
    res.json(
      await json(route(req, "/restore"), {
        expectedVersion: version(req.body?.expectedVersion),
        version: version(req.body?.version),
        ...actor(req),
      }),
    ),
  );
  app.get(prefix + "/:id/files/:version", async (req, res) => {
    const revision = version(req.params.version);
    const format = req.query.format || "docm";
    if (!["docx", "docm"].includes(format)) throw fail("Неизвестный формат.");
    const response = await worker(
      route(req, "/files/" + revision + "?format=" + format),
    );
    res.set(
      "Content-Type",
      format === "docm"
        ? "application/vnd.ms-word.document.macroEnabled.12"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.set(
      "Content-Disposition",
      `attachment; filename="${req.params.id}-v${revision}.${format}"`,
    );
    await pipeline(Readable.fromWeb(response.body), res);
  });
}
