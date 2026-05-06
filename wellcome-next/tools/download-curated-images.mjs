import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultInput = path.resolve(__dirname, "../src/data/curatedCabinetItems.json");
const defaultOutDir = path.resolve(__dirname, "./downloads/curated-images");

function parseArgs(argv) {
  const args = {
    input: defaultInput,
    out: defaultOutDir,
    concurrency: 6,
    limit: 0,
    skipExisting: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--input" && argv[i + 1]) {
      args.input = argv[i + 1];
      i += 1;
    } else if (arg === "--out" && argv[i + 1]) {
      args.out = argv[i + 1];
      i += 1;
    } else if (arg === "--concurrency" && argv[i + 1]) {
      args.concurrency = Number(argv[i + 1]) || args.concurrency;
      i += 1;
    } else if (arg === "--limit" && argv[i + 1]) {
      args.limit = Number(argv[i + 1]) || 0;
      i += 1;
    } else if (arg === "--no-skip-existing") {
      args.skipExisting = false;
    }
  }

  return args;
}

function getItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}

function getExtensionFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    const ext = path.extname(url.pathname).toLowerCase();
    return ext || ".jpg";
  } catch {
    return ".jpg";
  }
}

async function downloadFile(urlString, destination) {
  const response = await fetch(urlString);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (!contentType.startsWith("image/")) {
    throw new Error(`Unexpected content-type: ${contentType || "unknown"}`);
  }

  if (buffer.length === 0) {
    throw new Error("Empty response body");
  }

  await fs.writeFile(destination, buffer);
}

async function withRetry(task, attempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }

  throw lastError;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(args.input, "utf8");
  const payload = JSON.parse(raw);
  const items = getItems(payload).filter((item) => item?.imageUrl);
  const limitedItems = args.limit > 0 ? items.slice(0, args.limit) : items;

  if (limitedItems.length === 0) {
    console.log("No items with imageUrl found.");
    return;
  }

  await fs.mkdir(args.out, { recursive: true });

  let index = 0;
  let completed = 0;

  const runNext = async () => {
    if (index >= limitedItems.length) return;
    const item = limitedItems[index];
    index += 1;

    const ext = getExtensionFromUrl(item.imageUrl);
    const filename = `${item.id || item.workId || `item-${index}`}${ext}`;
    const outPath = path.join(args.out, filename);

    if (args.skipExisting && existsSync(outPath)) {
      const stats = await fs.stat(outPath);

      if (stats.size > 0) {
        completed += 1;
        process.stdout.write(`Skipped ${filename} (${completed}/${limitedItems.length})\n`);
        return runNext();
      }
    }

    try {
      await withRetry(() => downloadFile(item.imageUrl, outPath));
      completed += 1;
      process.stdout.write(`Downloaded ${filename} (${completed}/${limitedItems.length})\n`);
    } catch (error) {
      completed += 1;
      process.stdout.write(
        `Failed ${filename} (${completed}/${limitedItems.length}): ${error?.message || error}\n`,
      );
    }

    return runNext();
  };

  await Promise.all(Array.from({ length: args.concurrency }, runNext));
  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
