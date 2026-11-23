import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
// ExcelJS already ships JSZip; use the same installed dependency without adding a runtime package.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const JSZip = createRequire(require.resolve("exceljs"))("jszip");
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = path.join(root, "integrations/leads/wordpress/boykov-leads");
const zip = new JSZip();
async function collect(relative = "") {
  for (const entry of await readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const key = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await collect(key);
    else if (entry.isFile() && /\.(php|js)$/.test(key))
      zip.file(
        "boykov-leads/" + key,
        await readFile(path.join(directory, key)),
      );
  }
}
await collect();
const destination = path.join(root, "_patch-wordpress-statistics");
await mkdir(destination, { recursive: true });
await writeFile(
  path.join(destination, "boykov-leads-wordpress.zip"),
  await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
);
console.log(
  "WORDPRESS_PLUGIN_PACKAGE=" +
    path.join(destination, "boykov-leads-wordpress.zip"),
);
