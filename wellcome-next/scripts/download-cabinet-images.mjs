import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDir = path.resolve(process.cwd(), "public/cabinet-images");

async function downloadImage(item) {
  const response = await fetch(item.imageUrl);

  if (!response.ok) {
    throw new Error(`Failed to download ${item.id} from ${item.imageUrl}: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const outputPath = path.join(outputDir, `${item.id}.jpg`);
  await writeFile(outputPath, buffer);
}

async function main() {
  const payload = JSON.parse(
    await readFile(path.resolve(process.cwd(), "src/data/curatedCabinetItems.json"), "utf8"),
  );

  await mkdir(outputDir, { recursive: true });

  for (const item of payload.items) {
    process.stdout.write(`Downloading ${item.id}...\n`);
    await downloadImage(item);
  }

  process.stdout.write(`Downloaded ${payload.items.length} cabinet images to ${outputDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
