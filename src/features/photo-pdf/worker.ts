import { convertLocally } from "./convert";
// Bundled by Vite and served from this application. No external scripts or services.
self.onmessage = async ({ data }) => {
  if (
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap !== "function"
  ) {
    self.postMessage({ kind: "unsupported" });
    return;
  }
  try {
    const blob = await convertLocally(data.files, data.settings, (progress) =>
      self.postMessage({ kind: "progress", progress }),
    );
    self.postMessage({ kind: "done", blob });
  } catch (error) {
    self.postMessage({
      kind: "error",
      message:
        error instanceof Error ? error.message : "Не удалось собрать PDF.",
    });
  }
};
