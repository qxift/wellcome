import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const dataPath = path.join(rootDir, "src", "data", "curatedCabinetItems.json");
const outputPath = path.join(rootDir, "src", "data", "cabinetStories.llm.json");
const args = new Set(process.argv.slice(2));
const maxWords = 50;

const raw = fs.readFileSync(dataPath, "utf8");
const payload = JSON.parse(raw);
const items = payload.items ?? [];

function trimTitle(title = "") {
  return title.replace(/^\[/, "").replace(/\]\.?$/, "").trim();
}

function compactWords(text, limit = maxWords) {
  const normalized = text
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const words = normalized.split(/\s+/).filter(Boolean);

  if (words.length <= limit) {
    return normalized;
  }

  return `${words.slice(0, limit).join(" ").replace(/[,:;]$/, "")}.`;
}

function firstUseful(values, fallback) {
  return values?.find((value) => value && value.length > 2) ?? fallback;
}

function limitPhrase(text, limit) {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > limit ? words.slice(0, limit).join(" ") : text;
}

function articleFor(text) {
  return /^[aeiou]/i.test(text) ? "an" : "a";
}

function sentenceCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function getDisplayName(item, kind) {
  const title = trimTitle(item.title || "");
  const firstClause = title.split(/[;:]/)[0].replace(/\s+/g, " ").trim();
  const titleWords = firstClause.split(/\s+/).filter(Boolean);

  if (titleWords.length === 0 || titleWords.length > 9) {
    return `the ${kind}`;
  }

  return firstClause.replace(/[,.]$/, "");
}

function getKind(item) {
  const keywords = item.linkKeywords ?? [];
  const kinds = item.objectKinds ?? [];
  const title = item.title?.toLowerCase() ?? "";

  if (kinds.includes("anatomy") || title.includes("anatom")) return "anatomical object";
  if (keywords.includes("amulet") || keywords.includes("charms") || title.includes("amulet")) return "protective charm";
  if (keywords.includes("forceps") || title.includes("forceps")) return "medical instrument";
  if (keywords.includes("stethoscope") || title.includes("stethoscope")) return "listening instrument";
  if (keywords.includes("galvanism") || title.includes("galvani")) return "electrical apparatus";
  if (keywords.includes("ceramic") || title.includes("cup") || title.includes("jug") || title.includes("pot")) return "vessel";
  if (keywords.includes("votive") || title.includes("praying") || title.includes("saint")) return "devotional object";
  if (keywords.includes("medal") || title.includes("medal")) return "medal";
  if (kinds.includes("container")) return "case";
  if (kinds.includes("wearable")) return "worn object";
  if (kinds.includes("figure")) return "figure";

  return firstUseful(kinds, firstUseful(item.genres, "object")).toLowerCase();
}

function hashString(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pick(list, seed, offset = 0) {
  return list[(seed + offset) % list.length];
}

function getSubjectPhrase(item, kind, seed) {
  const raw = limitPhrase(firstUseful(item.subjects, firstUseful(item.linkKeywords, "care")).toLowerCase(), 5)
    .replace(/\s*&\s*/g, " and ")
    .replace(/[.,;:]+$/g, "");
  const generic = new Set([
    "anatomical",
    "figure",
    "case",
    "cup",
    "pot",
    "statuette",
    "model",
    "museum object",
    "instruments",
    "containers",
  ]);

  if (raw && !generic.has(raw)) {
    return raw;
  }

  const subjectByKind = {
    "anatomical object": ["body knowledge", "teaching anatomy", "the visible body"],
    "protective charm": ["protection", "illness and blessing", "fear made portable"],
    "medical instrument": ["clinical urgency", "care under pressure", "the managed body"],
    "listening instrument": ["diagnosis", "private symptoms", "the hidden chest"],
    "electrical apparatus": ["experiment", "invisible energy", "laboratory wonder"],
    vessel: ["domestic medicine", "shared remedies", "household care"],
    "devotional object": ["prayer", "recovery and devotion", "bodies in danger"],
    medal: ["public memory", "professional pride", "medicine as ceremony"],
    case: ["readiness", "order and fear", "tools waiting in darkness"],
    "worn object": ["the body", "public identity", "private protection"],
    figure: ["myth and care", "embodied belief", "watchful presence"],
  };

  return pick(subjectByKind[kind] ?? ["care", "memory", "display"], seed, 5);
}

function localStory(item) {
  const seed = hashString(item.id ?? item.title ?? "");
  const kind = getKind(item);
  const inlineName = getDisplayName(item, kind);
  const displayName = sentenceCase(inlineName);
  const objectPhrase = `${articleFor(kind)} ${kind}`;
  const subject = getSubjectPhrase(item, kind, seed);
  const materialHint = pick(
    [
      "handled in a hurry",
      "kept close to the body",
      "brought out only when words failed",
      "placed where anxious eyes could find it",
      "saved because someone thought it still had power",
      "made to turn fear into something visible",
      "passed between expert hands and private hopes",
      "kept as proof that care can look strange",
      "waiting between belief and experiment",
      "small enough to feel personal, strange enough to endure",
    ],
    seed,
  );
  const ending = pick(
    [
      "It asks us to listen for the hands behind the record.",
      "The cabinet makes it feel less like evidence than a surviving whisper.",
      "What remains is not certainty, but a human attempt to manage danger.",
      "Its mystery is useful: it leaves room for touch, fear, and hope.",
      "Seen briefly, it becomes a compact stage for medicine and imagination.",
      "It turns the archive into a small, uneasy encounter.",
      "The object seems to remember a body just outside the frame.",
      "It carries the mood of a cure, a warning, or a wish.",
    ],
    seed,
    7,
  );
  const templates = [
    `${displayName} may have begun as ${objectPhrase}, ${materialHint}. Around ${subject}, it gathers use, display, and quiet uncertainty. ${ending}`,
    `Someone once trusted ${inlineName} to do more than sit still. This ${kind} feels ${materialHint}, shaped by ${subject} and by the wish to make invisible forces behave.`,
    `In the cabinet, ${inlineName} becomes a clue rather than an answer: ${objectPhrase} tied to ${subject}, ${materialHint}. ${ending}`,
    `${displayName} looks like ${objectPhrase} with a private task. It is ${materialHint}, carrying ${subject} from the record into the room of imagination.`,
    `This ${kind} does not tell one clean truth. ${displayName} is ${materialHint}, and the metadata points toward ${subject}: part remedy, part theatre, part memory.`,
    `Imagine ${inlineName} before it reached the museum: ${objectPhrase} ${materialHint}. Its link to ${subject} turns ordinary handling into a small ceremony.`,
    `${displayName} holds its silence carefully. As ${objectPhrase} associated with ${subject}, it seems ${materialHint}. ${ending}`,
    `The record names ${inlineName}; the cabinet lets it breathe. Connected to ${subject}, this ${kind} feels ${materialHint}, as if its purpose was never only practical.`,
    `${displayName} sits between catalogue and rumour. As ${objectPhrase}, it lets ${subject} take a visible shape, small enough to approach and strange enough to resist explanation.`,
    `Open the door and ${inlineName} becomes intimate. It suggests ${subject}, but also the ordinary suspense of being held, used, cleaned, hidden, or saved.`,
    `${displayName} feels less like a specimen than a pause in someone else's day. Its connection to ${subject} turns the cabinet into a brief, watchful room.`,
    `The image gives ${inlineName} a second life: not proof, exactly, but atmosphere. This ${kind} carries ${subject} as if belief and technique once shared the same breath.`,
    `${displayName} seems designed for a moment of attention. It draws ${subject} into view, then leaves the rest to the listener: touch, risk, trust, and display.`,
    `A record can name ${inlineName}, but it cannot finish the story. This ${kind} carries ${subject} like a small pressure mark left by anxious hands.`,
    `${displayName} enters the cabinet as ${objectPhrase}, but it behaves like a memory. Around ${subject}, it makes care feel practical, theatrical, and unresolved.`,
    `There is a private drama inside ${inlineName}. The metadata points to ${subject}; the object itself suggests the hush before treatment, prayer, experiment, or display.`,
  ];

  return compactWords(pick(templates, seed, 13));
}

function validateStories(stories) {
  const missingStories = items.map((item) => item.id).filter((id) => !(id in stories));
  const longStories = Object.entries(stories)
    .filter(([, story]) => story.split(/\s+/).filter(Boolean).length > maxWords)
    .map(([id]) => id);

  if (missingStories.length > 0 || longStories.length > 0) {
    if (missingStories.length > 0) {
      console.error(`Missing stories for ${missingStories.length} object(s): ${missingStories.join(", ")}`);
    }
    if (longStories.length > 0) {
      console.error(`Stories over ${maxWords} words: ${longStories.join(", ")}`);
    }
    process.exit(1);
  }
}

async function generateWithOpenAI(item) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const metadata = {
    id: item.id,
    title: item.title,
    type: item.type,
    imageUrl: item.imageUrl,
    genres: item.genres ?? [],
    subjects: item.subjects ?? [],
    objectKinds: item.objectKinds ?? [],
    linkKeywords: item.linkKeywords ?? [],
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
      instructions: [
        "You write concise spoken labels for a cabinet-of-curiosities experience.",
        `Write no more than ${maxWords} words.`,
        "Use the metadata and image as inspiration. You may imagine atmosphere or possible use, but do not assert invented provenance as fact.",
        "Return only the narration text. No title, bullets, markdown, or quotation marks.",
      ].join(" "),
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: JSON.stringify(metadata) },
            { type: "input_image", image_url: item.imageUrl, detail: "low" },
          ],
        },
      ],
      max_output_tokens: 120,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed for ${item.id}: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const outputText = result.output_text
    ?? result.output?.flatMap((entry) => entry.content ?? [])
      .map((content) => content.text ?? "")
      .join("")
      .trim();

  return outputText ? compactWords(outputText) : null;
}

if (args.has("--validate")) {
  const stories = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  validateStories(stories);
  console.log(`Validated ${items.length} objects against ${outputPath}`);
  process.exit(0);
}

const stories = {};
const useOpenAI = Boolean(process.env.OPENAI_API_KEY) && !args.has("--offline");

for (const [index, item] of items.entries()) {
  if (useOpenAI) {
    console.log(`Generating story ${index + 1}/${items.length}: ${item.id}`);
  }

  stories[item.id] = useOpenAI ? await generateWithOpenAI(item) : localStory(item);
  if (!stories[item.id]) {
    stories[item.id] = localStory(item);
  }
}

validateStories(stories);
fs.writeFileSync(outputPath, `${JSON.stringify(stories, null, 2)}\n`);
console.log(`Wrote ${Object.keys(stories).length} stories to ${outputPath}${useOpenAI ? " using OpenAI" : " using local fallback"}`);
