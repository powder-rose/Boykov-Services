// Browser-local PDF 1.4 writer: one re-encoded RGB JPEG per page, no scripts or attachments.
export type PageMode = "a4" | "image";
export type JpegPage = {
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
};
export const MAX_PDF_BYTES = 250 * 1024 * 1024;
const encoder = new TextEncoder();
const decimal = (value: number) => Number(value.toFixed(3));
export function pageLayout(width: number, height: number, mode: PageMode) {
  if (
    ![width, height].every((n) => Number.isSafeInteger(n) && n > 0) ||
    !["a4", "image"].includes(mode)
  )
    throw Error("Некорректный размер страницы.");
  const landscape = width > height;
  const pw =
    mode === "a4"
      ? landscape
        ? 841.89
        : 595.28
      : (width * 841.89) / Math.max(width, height);
  const ph =
    mode === "a4"
      ? landscape
        ? 595.28
        : 841.89
      : (height * 841.89) / Math.max(width, height);
  const margin = mode === "a4" ? 18 : 0;
  const scale = Math.min((pw - margin * 2) / width, (ph - margin * 2) / height);
  const dw = width * scale,
    dh = height * scale;
  return {
    width: pw,
    height: ph,
    x: (pw - dw) / 2,
    y: (ph - dh) / 2,
    imageWidth: dw,
    imageHeight: dh,
  };
}
export class PhotoPdfWriter {
  private parts: BlobPart[] = [];
  private offsets = [0];
  private position = 0;
  private pages = 0;
  private finished = false;
  private count: number;
  private mode: PageMode;
  private limit: number;
  constructor(count: number, mode: PageMode, limit = MAX_PDF_BYTES) {
    this.count = count;
    this.mode = mode;
    this.limit = limit;
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 500 ||
      !["a4", "image"].includes(mode)
    )
      throw Error("Добавьте от 1 до 500 фотографий.");
    this.push(
      new Uint8Array([
        37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 226, 227, 207, 211, 10,
      ]),
    );
    this.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    this.object(
      2,
      `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${5 + i * 3} 0 R`).join(" ")}] >>`,
    );
  }
  private push(value: string | Uint8Array<ArrayBuffer>) {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    if (this.position + bytes.byteLength > this.limit)
      throw Error(
        "PDF превышает 250 МБ. Уменьшите разрешение или разделите фото на несколько файлов.",
      );
    this.parts.push(bytes);
    this.position += bytes.byteLength;
  }
  private object(id: number, body: string | (() => void)) {
    this.offsets[id] = this.position;
    this.push(`${id} 0 obj\n`);
    if (typeof body === "string") this.push(body);
    else body();
    this.push("\nendobj\n");
  }
  add(page: JpegPage) {
    if (this.finished || this.pages >= this.count)
      throw Error("PDF уже собран.");
    const { bytes, width, height } = page;
    if (
      bytes.length < 4 ||
      bytes[0] !== 255 ||
      bytes[1] !== 216 ||
      bytes.at(-2) !== 255 ||
      bytes.at(-1) !== 217
    )
      throw Error("Не удалось подготовить JPEG для PDF.");
    const box = pageLayout(width, height, this.mode),
      imageId = 3 + this.pages * 3,
      contentId = imageId + 1,
      pageId = imageId + 2;
    this.object(imageId, () => {
      this.push(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`,
      );
      this.push(bytes);
      this.push("\nendstream");
    });
    const instructions = encoder.encode(
      `q\n${decimal(box.imageWidth)} 0 0 ${decimal(box.imageHeight)} ${decimal(box.x)} ${decimal(box.y)} cm\n/Photo Do\nQ\n`,
    );
    this.object(contentId, () => {
      this.push(`<< /Length ${instructions.length} >>\nstream\n`);
      this.push(instructions);
      this.push("endstream");
    });
    this.object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${decimal(box.width)} ${decimal(box.height)}] /Resources << /XObject << /Photo ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    this.pages++;
  }
  finish() {
    if (this.finished || this.pages !== this.count)
      throw Error("Не все фотографии добавлены в PDF.");
    const xref = this.position,
      size = 3 + this.count * 3;
    this.push(`xref\n0 ${size}\n0000000000 65535 f \n`);
    for (let i = 1; i < size; i++)
      this.push(`${String(this.offsets[i]).padStart(10, "0")} 00000 n \n`);
    this.push(
      `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    );
    const blob = new Blob(this.parts, { type: "application/pdf" });
    this.parts = [];
    this.finished = true;
    return blob;
  }
}
