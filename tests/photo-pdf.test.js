import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.js";
import { PhotoPdfWriter, pageLayout } from "../src/features/photo-pdf/pdf.ts";
import {
  defaultSettings,
  imageDimensions,
  inspectPhoto,
  outputFilename,
  validateSettings,
} from "../src/features/photo-pdf/files.ts";
const jpg = new Uint8Array([255, 216, 255, 224, 0, 4, 0, 0, 255, 217]);
test("PDF geometry contains portrait and landscape photos without cropping or stretching", () => {
  for (const [w, h] of [
    [1200, 2400],
    [2400, 1200],
    [600, 600],
  ]) {
    const p = pageLayout(w, h, "a4");
    assert.ok(p.x >= 17.999 && p.y >= 17.999);
    assert.ok(p.x + p.imageWidth <= p.width - 17.999);
    assert.ok(p.y + p.imageHeight <= p.height - 17.999);
    assert.ok(Math.abs(p.imageWidth / p.imageHeight - w / h) < 1e-9);
    assert.equal(p.width, w > h ? 841.89 : 595.28);
    const fit = pageLayout(w, h, "image");
    assert.ok(Math.abs(fit.x) < 1e-9 && Math.abs(fit.y) < 1e-9);
    assert.equal(Math.max(fit.width, fit.height), 841.89);
  }
  assert.throws(() => pageLayout(0, 20, "a4"));
  assert.throws(() => pageLayout(200, 20, "invalid"));
});
test("PDF binary offsets and stream lengths are exact, pages ordered and no incomplete document can download", async () => {
  const pdf = new PhotoPdfWriter(2, "a4");
  pdf.add({ bytes: jpg, width: 160, height: 240 });
  assert.throws(() => pdf.finish(), /Не все/);
  pdf.add({ bytes: jpg, width: 240, height: 160 });
  const blob = pdf.finish(),
    buffer = Buffer.from(await blob.arrayBuffer()),
    text = buffer.toString("latin1");
  assert.equal(blob.type, "application/pdf");
  assert.match(text, /^%PDF-1\.4/);
  assert.match(text, /\/Kids \[5 0 R 8 0 R\]/);
  assert.equal((text.match(/\/Type \/Page /g) || []).length, 2);
  const offset = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(offset, offset + 4), "xref");
  const lines = text.slice(offset).split("\n");
  assert.equal(lines[1], "0 9");
  for (let id = 1; id <= 8; id++) {
    const at = Number(lines[2 + id].slice(0, 10));
    assert.equal(text.slice(at, at + String(id).length + 6), `${id} 0 obj`);
  }
  let streams = 0;
  for (const m of text.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
    const first = m.index + m[0].length,
      last = first + Number(m[1]);
    assert.match(text.slice(last, last + 12), /^\n?endstream/);
    streams++;
  }
  assert.equal(streams, 4);
  assert.throws(() => pdf.add({ bytes: jpg, width: 1, height: 1 }));
  assert.throws(() => pdf.finish());
  assert.doesNotMatch(text, /\/JavaScript|\/EmbeddedFile|\/OpenAction/);
});
test("PDF limits fail explicitly rather than create a truncated or silently incomplete document", () => {
  assert.throws(() => new PhotoPdfWriter(0, "a4"));
  assert.throws(() => new PhotoPdfWriter(501, "a4"));
  const small = new PhotoPdfWriter(1, "a4", 600);
  assert.throws(
    () =>
      small.add({
        bytes: new Uint8Array([255, 216, ...new Array(700).fill(0), 255, 217]),
        width: 100,
        height: 100,
      }),
    /250 МБ/,
  );
  assert.throws(
    () =>
      new PhotoPdfWriter(1, "a4").add({
        bytes: new Uint8Array([1, 2, 3, 4]),
        width: 1,
        height: 1,
      }),
    /JPEG/,
  );
});
test("compression never enlarges pixels; original resolution and invalid settings have explicit canvas limits", () => {
  assert.deepEqual(imageDimensions(4000, 2000, 1600), {
    width: 1600,
    height: 800,
  });
  assert.deepEqual(imageDimensions(600, 900, 1600), {
    width: 600,
    height: 900,
  });
  assert.deepEqual(imageDimensions(600, 900, 0), { width: 600, height: 900 });
  assert.deepEqual(imageDimensions(20000, 10000, 3000), {
    width: 3000,
    height: 1500,
  });
  assert.throws(() => imageDimensions(20000, 10000, 0), /разрешение/);
  assert.throws(() => imageDimensions(0, 100, 1600));
  validateSettings(defaultSettings);
  assert.throws(() => validateSettings({ ...defaultSettings, quality: 96 }));
  assert.throws(() => validateSettings({ ...defaultSettings, maxSide: -1 }));
  assert.throws(() =>
    validateSettings({ ...defaultSettings, pageMode: "bad" }),
  );
});
test("raster signature check rejects renamed HTML/SVG, empty and oversized files before previews", async () => {
  await inspectPhoto(new File([jpg], "photo.jpg"));
  await inspectPhoto(
    new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])],
      "photo.png",
    ),
  );
  await inspectPhoto(new File(["RIFF0000WEBP0000"], "photo.webp"));
  await inspectPhoto(new File(["0000ftypavif0000"], "photo.avif"));
  await inspectPhoto(new File(["0000ftypheic0000"], "photo.heic"));
  await assert.rejects(
    () =>
      inspectPhoto(
        new File(
          [
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/private"/></svg>',
          ],
          "fake.jpg",
          { type: "image/jpeg" },
        ),
      ),
    /формате/,
  );
  await assert.rejects(
    () =>
      inspectPhoto(
        new File(["<html>bad</html>"], "fake.png", { type: "image/png" }),
      ),
    /формате/,
  );
  await assert.rejects(() => inspectPhoto(new File([], "empty.jpg")), /пустой/);
  await assert.rejects(
    () => inspectPhoto({ size: 50 * 1024 * 1024 + 1 }),
    /50 МБ/,
  );
});
test("download names are usable on Windows, keep Russian names and never double the extension", () => {
  assert.equal(outputFilename("  Фотоотчёт.pdf.pdf  "), "Фотоотчёт.pdf");
  assert.equal(outputFilename(""), "Фотоотчёт.pdf");
  assert.equal(outputFilename("..."), "Фотоотчёт.pdf");
  assert.equal(outputFilename("Объект: A/B"), "Объект_ A_B.pdf");
  assert.equal(outputFilename("CON"), "_CON.pdf");
  assert.equal(outputFilename("test\u202eexe"), "test_exe.pdf");
  assert.ok(outputFilename("я".repeat(180)).length <= 124);
});
test("production CSP permits local photo previews without enabling remote images or inline scripts", async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const dataDir = await mkdtemp(join(tmpdir(), "photo-pdf-csp-"));
  const app = await createApp({
    dataDir,
    passwordHash: "",
    allowedOrigins: [],
    secureCookies: false,
    isConfigured: () => false,
    worker: async () => Response.json({ jobs: [], ok: true }),
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const response = await fetch(
      `http://127.0.0.1:${server.address().port}/healthz`,
    ),
    csp = response.headers.get("content-security-policy");
  assert.match(csp, /img-src 'self' data: blob:;/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src 'self';/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https:\/\/|\*/);
});
