export const MAX_PHOTOS = 500;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const presets = [
  {
    id: "balanced",
    name: "Сбалансированный",
    description: "Для обычного фотоотчёта",
    maxSide: 1600,
    quality: 68,
  },
  {
    id: "text",
    name: "Чёткий текст",
    description: "Документы и мелкие подписи",
    maxSide: 2200,
    quality: 83,
  },
  {
    id: "small",
    name: "Компактный",
    description: "Небольшой файл для отправки",
    maxSide: 1200,
    quality: 52,
  },
  {
    id: "quality",
    name: "Высокое качество",
    description: "Детали и крупные фотографии",
    maxSide: 3000,
    quality: 90,
  },
] as const;
export type Settings = {
  maxSide: number;
  quality: number;
  pageMode: "a4" | "image";
};
export const defaultSettings: Settings = {
  maxSide: 1600,
  quality: 68,
  pageMode: "a4",
};
export function validateSettings(settings: Settings) {
  if (
    ![0, 1200, 1600, 2200, 3000].includes(settings.maxSide) ||
    !Number.isInteger(settings.quality) ||
    settings.quality < 35 ||
    settings.quality > 95 ||
    !["a4", "image"].includes(settings.pageMode)
  )
    throw Error("Проверьте настройки сжатия.");
}
export function imageDimensions(
  width: number,
  height: number,
  maxSide: number,
) {
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0))
    throw Error("Не удалось определить размер фотографии.");
  const scale = maxSide ? Math.min(1, maxSide / Math.max(width, height)) : 1;
  const w = Math.max(1, Math.round(width * scale)),
    h = Math.max(1, Math.round(height * scale));
  if (w > 16384 || h > 16384 || w * h > 64_000_000)
    throw Error(
      "Слишком высокое разрешение для браузера. Выберите максимальную сторону 3000 пикселей или меньше.",
    );
  return { width: w, height: h };
}
export function outputFilename(value: string) {
  const name =
    value
      .trim()
      .replace(/(?:\.pdf)+$/i, "")
      .replace(
        /[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
        "_",
      )
      .replace(/[. ]+$/g, "")
      .slice(0, 120) || "Фотоотчёт";
  return (
    (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? "_" : "") +
    name +
    ".pdf"
  );
}
export const sizeText = (bytes: number) =>
  new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: bytes < 1024 ? 0 : 1,
  }).format(
    bytes < 1024 ? bytes : bytes < 1048576 ? bytes / 1024 : bytes / 1048576,
  ) + (bytes < 1024 ? " Б" : bytes < 1048576 ? " КБ" : " МБ");
// Check raster signatures before creating previews. Renamed HTML/SVG files cannot load subresources.
export async function inspectPhoto(file: File) {
  if (!file.size) throw Error("Файл пустой.");
  if (file.size > MAX_FILE_BYTES) throw Error("Файл больше 50 МБ.");
  const h = new Uint8Array(await file.slice(0, 64).arrayBuffer()),
    ascii = (from: number, to: number) =>
      String.fromCharCode(...h.slice(from, to));
  const jpeg = h[0] === 255 && h[1] === 216 && h[2] === 255;
  const png = h.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10";
  const webp = ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  const bmp = ascii(0, 2) === "BM";
  const brands = Array.from(
    { length: Math.max(0, Math.floor((h.length - 8) / 4)) },
    (_, i) => ascii(8 + i * 4, 12 + i * 4),
  );
  const heif =
    ascii(4, 8) === "ftyp" &&
    brands.some((b) =>
      ["avif", "avis", "heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(
        b,
      ),
    );
  if (!jpeg && !png && !webp && !bmp && !heif)
    throw Error(
      "Нужна фотография в формате JPG, PNG, WEBP, BMP, AVIF или HEIC.",
    );
}
