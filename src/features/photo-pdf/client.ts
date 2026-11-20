import { convertLocally } from "./convert";
import type { Progress } from "./convert";
import { validateSettings } from "./files";
import type { Settings } from "./files";
const aborted = () =>
  new DOMException("Создание PDF остановлено.", "AbortError");
const check = (signal: AbortSignal) => {
  if (signal.aborted) throw aborted();
};
export async function createPhotoPdf(
  files: File[],
  settings: Settings,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<Blob> {
  check(signal);
  validateSettings(settings);
  if (typeof Worker === "undefined")
    return convertLocally(files, settings, onProgress, signal);
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    return convertLocally(files, settings, onProgress, signal);
  }
  const result = await new Promise<Blob | null>((resolve, reject) => {
    let started = false,
      settled = false;
    const finish = (value: Blob | null, error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      worker.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    const cancel = () => finish(null, aborted());
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    worker.onerror = (event) => {
      event.preventDefault();
      finish(
        null,
        started
          ? Error(
              "Обработка прервалась. Уменьшите разрешение или количество фото и повторите.",
            )
          : undefined,
      );
    };
    worker.onmessage = ({ data }) => {
      if (data.kind === "unsupported") finish(null);
      else if (data.kind === "progress") {
        started = true;
        onProgress(data.progress);
      } else if (data.kind === "done" && data.blob instanceof Blob)
        finish(data.blob);
      else if (data.kind === "error") finish(null, Error(data.message));
    };
    try {
      worker.postMessage({ files, settings });
    } catch {
      finish(null, Error("Браузер не смог запустить обработку фотографий."));
    }
  });
  check(signal);
  return result || convertLocally(files, settings, onProgress, signal);
}
