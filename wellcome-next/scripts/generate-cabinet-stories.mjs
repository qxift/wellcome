import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const dataPath = path.join(rootDir, "src", "data", "curatedCabinetItems.json");
const outputPath = path.join(rootDir, "src", "data", "cabinetStories.llm.json");
const maxWords = 50;
const defaultModel = "gpt-4.1-mini";

function parseArgs(argv) {
  const options = {
    force: false,
    help: false,
    ids: new Set(),
    limit: null,
    validate: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--validate") {
      options.validate = true;
    } else if (arg === "--id") {
      const value = argv[index + 1];
      if (!value) throw new Error("--id requires an object id");
      options.ids.add(value);
      index += 1;
    } else if (arg.startsWith("--id=")) {
      options.ids.add(arg.slice("--id=".length));
    } else if (arg === "--limit") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value <= 0) throw new Error("--limit requires a positive integer");
      options.limit = value;
      index += 1;
    } else if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(value) || value <= 0) throw new Error("--limit requires a positive integer");
      options.limit = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log([
    "Generate cabinet narration stories with OpenAI.",
    "",
    "Usage:",
    "  OPENAI_API_KEY=\"...\" npm run data:stories",
    "  OPENAI_API_KEY=\"...\" npm run data:stories -- --limit=3",
    "  OPENAI_API_KEY=\"...\" npm run data:stories -- --id hbke5rty --force",
    "  npm run data:stories:validate",
    "",
    "Options:",
    "  --force        Regenerate selected stories even if they already exist.",
    "  --id <id>      Generate one object id. Can be repeated.",
    "  --limit <n>    Generate the first n curated objects.",
    "  --validate     Check that every curated object has a <=50 word story.",
    "  --help         Show this help text.",
    "",
    "Environment:",
    `  OPENAI_MODEL  Defaults to ${defaultModel}.`,
  ].join("\n"));
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function cleanStory(text) {
  return text
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/^(story|narration|description)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function limitWords(text, limit = maxWords) {
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length <= limit) {
    return text;
  }

  return `${words.slice(0, limit).join(" ").replace(/[,:;]$/, "")}.`;
}

function validateStories(stories, items) {
  const missingStories = items.map((item) => item.id).filter((id) => !(id in stories));
  const emptyStories = Object.entries(stories)
    .filter(([, story]) => typeof story !== "string" || story.trim().length === 0)
    .map(([id]) => id);
  const longStories = Object.entries(stories)
    .filter(([, story]) => typeof story === "string" && wordCount(story) > maxWords)
    .map(([id]) => id);

  if (missingStories.length > 0 || emptyStories.length > 0 || longStories.length > 0) {
    if (missingStories.length > 0) {
      console.error(`Missing stories for ${missingStories.length} object(s): ${missingStories.join(", ")}`);
    }
    if (emptyStories.length > 0) {
      console.error(`Empty stories for ${emptyStories.length} object(s): ${emptyStories.join(", ")}`);
    }
    if (longStories.length > 0) {
      console.error(`Stories over ${maxWords} words: ${longStories.join(", ")}`);
    }
    process.exit(1);
  }
}

function buildMetadata(item) {
  return {
    id: item.id,
    workId: item.workId,
    title: item.title,
    type: item.type,
    imageUrl: item.imageUrl,
    genres: item.genres ?? [],
    languages: item.languages ?? [],
    subjects: item.subjects ?? [],
    contributors: item.contributors ?? [],
    objectKinds: item.objectKinds ?? [],
    linkKeywords: item.linkKeywords ?? [],
    license: item.license ?? null,
  };
}

function buildPrompt(item) {
  return [
    "Write one short spoken narration for this cabinet object.",
    `Maximum length: ${maxWords} words.`,
    "Write in a confident museum voice, as if the imagined interpretation were true.",
    "You may invent a wrong, speculative, or mythical explanation, but anchor it in the metadata and visible image details.",
    "Make the story clear about what the object does, controls, protects, teaches, measures, reveals, or transforms.",
    "Use concrete details from the image: inscriptions, posture, handles, containers, materials, figures, marks, color, damage, or arrangement.",
    "Do not use cautious phrases such as 'perhaps', 'may have', 'might', 'likely', 'seems', or 'suggests'.",
    "Avoid fantasy or vague mystery language: secret, secrets, mystery, mystical, magical, enchanted, haunting, spell, whispers, shadow, strange silence.",
    "Do not write a generic object description. Give the object a specific function, ritual, belief, or invented theory.",
    "You can choose to mention some fact like years or cultural hint in metadata",
    "Good openings can begin with a place, period, visible detail, social role, user, action",
    "Use a different rhythm for each object: some can start with a direct claim, others with an image detail, a user, a setting, or a cultural practice.",
    "Avoid repeating the same opening grammar across nearby objects.",
    "Use the tone like you're an historian or archaeologist",
    "Return only the narration text. No title, bullets, markdown, or quotation marks.",
    "",
    "",
    `Metadata: ${JSON.stringify(buildMetadata(item))}`,
  ].join("\n");
}

function extractOutputText(result) {
  if (typeof result.output_text === "string") {
    return result.output_text;
  }

  return result.output
    ?.flatMap((entry) => entry.content ?? [])
    .map((content) => content.text ?? "")
    .join("")
    .trim() ?? "";
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function generateWithOpenAI(item, { apiKey, model }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: [
        "You write museum audio labels for a surreal cabinet-of-curiosities web experience.",
        "Your tone is intimate, curious, elegant, and slightly uncanny.",
        "Every answer must be a single short narration that sounds good when spoken aloud.",
      ].join(" "),
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: buildPrompt(item) },
            { type: "input_image", image_url: item.imageUrl, detail: "low" },
          ],
        },
      ],
      max_output_tokens: 160,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed for ${item.id}: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const story = cleanStory(extractOutputText(result));

  if (!story) {
    throw new Error(`OpenAI returned an empty story for ${item.id}`);
  }

  return limitWords(story);
}

async function generateWithRetry(item, config) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await generateWithOpenAI(item, config);
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }

      console.warn(`Attempt ${attempt} failed for ${item.id}; retrying...`);
      await sleep(750 * attempt);
    }
  }

  throw new Error(`Failed to generate story for ${item.id}`);
}

const options = parseArgs(process.argv.slice(2));
const payload = readJson(dataPath);
const items = payload.items ?? [];

if (options.help) {
  printHelp();
  process.exit(0);
}

if (options.validate) {
  const stories = readJson(outputPath, {});
  validateStories(stories, items);
  console.log(`Validated ${items.length} stories against ${outputPath}`);
  process.exit(0);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Missing OPENAI_API_KEY. This script now generates stories only with an LLM.");
  console.error("Example: OPENAI_API_KEY=\"your_key_here\" npm run data:stories");
  process.exit(1);
}

const model = process.env.OPENAI_MODEL ?? defaultModel;
const existingStories = readJson(outputPath, {});
let selectedItems = items;

if (options.ids.size > 0) {
  selectedItems = selectedItems.filter((item) => options.ids.has(item.id));
  const missingIds = [...options.ids].filter((id) => !items.some((item) => item.id === id));
  if (missingIds.length > 0) {
    console.error(`Unknown object id(s): ${missingIds.join(", ")}`);
    process.exit(1);
  }
}

if (options.limit !== null) {
  selectedItems = selectedItems.slice(0, options.limit);
}

const isPartialRun = options.ids.size > 0 || options.limit !== null;
const stories = isPartialRun ? { ...existingStories } : {};
const total = selectedItems.length;

console.log(`Generating ${total} cabinet story/stories with OpenAI model ${model}.`);

for (const [index, item] of selectedItems.entries()) {
  if (!options.force && isPartialRun && stories[item.id]) {
    console.log(`Skipping ${index + 1}/${total}: ${item.id} already exists`);
    continue;
  }

  console.log(`Generating story ${index + 1}/${total}: ${item.id}`);
  stories[item.id] = await generateWithRetry(item, { apiKey, model });
}

const orderedStories = {};
for (const item of items) {
  if (stories[item.id]) {
    orderedStories[item.id] = stories[item.id];
  }
}

validateStories(orderedStories, isPartialRun ? selectedItems : items);
writeJson(outputPath, orderedStories);
console.log(`Wrote ${Object.keys(orderedStories).length} LLM story/stories to ${outputPath}`);
