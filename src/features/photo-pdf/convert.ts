import { imageDimensions, validateSettings } from "./files";
import type { Settings } from "./files";
import { PhotoPdfWriter } from "./pdf";
export type Progress = {
  done: number;
  total: number;
  filename: string;
  phase: "images" | "pdf";
};
const aborted = () =>
  new DOMException("Создание PDF остановлено.", "AbortError");
const check = (signal?: AbortSignal) => {
  if (signal?.aborted) throw aborted();
};
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* Native Image supports some formats not handled by ImageBitmap. */
    }
  }
  if (typeof Image === "undefined")
    throw Error(
      "Этот формат не открывается в браузере. Сохраните снимок как JPG или PNG.",
    );
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(
          Error(
            "Этот формат не открывается в браузере. Сохраните снимок как JPG или PNG.",
          ),
        );
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function jpeg(file: File, settings: Settings, signal?: AbortSignal) {
  const image = await decode(file);
  let canvas: OffscreenCanvas | HTMLCanvasElement | undefined;
  try {
    check(signal);
    const dimensions = imageDimensions(
      image.width,
      image.height,
      settings.maxSide,
    );
    canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(dimensions.width, dimensions.height)
        : document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d", { alpha: false }) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!context) throw Error("Браузер не смог обработать изображение.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob =
      "convertToBlob" in canvas
        ? await canvas.convertToBlob({
            type: "image/jpeg",
            quality: settings.quality / 100,
          })
        : await new Promise<Blob | null>((resolve) =>
            (canvas as HTMLCanvasElement).toBlob(
              resolve,
              "image/jpeg",
              settings.quality / 100,
            ),
          );
    check(signal);
    if (!blob || blob.type !== "image/jpeg")
      throw Error("Браузер не смог сжать фотографию.");
    return { bytes: new Uint8Array(await blob.arrayBuffer()), ...dimensions };
  } finally {
    if ("close" in image) image.close();
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}
export async function convertLocally(
  files: File[],
  settings: Settings,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
) {
  validateSettings(settings);
  check(signal);
  const writer = new PhotoPdfWriter(files.length, settings.pageMode);
  for (let i = 0; i < files.length; i++) {
    check(signal);
    onProgress({
      done: i,
      total: files.length,
      filename: files[i].name,
      phase: "images",
    });
    // Yield between photos, including in the fallback for browsers without worker canvas.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    check(signal);
    try {
      const page = await jpeg(files[i], settings, signal);
      check(signal);
      writer.add(page);
    } catch (error) {
      if (signal?.aborted) throw aborted();
      throw Error(
        `«${files[i].name}»: ${error instanceof Error ? error.message : "Не удалось открыть фотографию."}`,
      );
    }
  }
  onProgress({
    done: files.length,
    total: files.length,
    filename: "",
    phase: "pdf",
  });
  check(signal);
  const blob = writer.finish();
  check(signal);
  return blob;
}
