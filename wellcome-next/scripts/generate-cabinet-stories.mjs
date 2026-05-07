import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const dataPath = path.join(rootDir, "src", "data", "curatedCabinetItems.json");
const outputPath = path.join(rootDir, "src", "data", "cabinetStories.json");

const raw = fs.readFileSync(dataPath, "utf8");
const payload = JSON.parse(raw);
const items = payload.items ?? [];

const adjectives = [
  "quiet",
  "enigmatic",
  "weathered",
  "tactile",
  "delicate",
  "solemn",
  "luminous",
  "sturdy",
  "ornate",
  "humble",
  "mysterious",
  "ritual",
  "curious",
  "intimate",
  "historic",
];

const verbs = [
  "lingers",
  "whispers",
  "remembers",
  "echoes",
  "suggests",
  "reveals",
  "marks",
  "tracks",
  "frames",
  "guards",
  "invites",
  "records",
  "holds",
];

const settings = [
  "a workshop",
  "a clinic",
  "a shrine",
  "a traveling show",
  "a private study",
  "a crowded market",
  "a cabinet of wonders",
  "a museum drawer",
  "a river journey",
  "a ritual room",
];

const purposes = [
  "protection",
  "healing",
  "measurement",
  "teaching",
  "display",
  "memory",
  "devotion",
  "care",
  "storytelling",
];

const tones = [
  "It feels personal.",
  "It feels theatrical.",
  "It feels practical.",
  "It feels sacred.",
  "It feels improvised.",
  "It feels ceremonial.",
];

const templates = [
  ({ title, subject, kind, adjective, verb, setting, purpose, tone }) =>
    `${title} is a ${adjective} ${kind} tied to ${subject}. It ${verb} of ${setting} and ${purpose}. ${tone}`,
  ({ title, subject, kind, adjective, verb, setting, purpose }) =>
    `${title} was likely used for ${purpose}. This ${adjective} ${kind} ${verb} from ${setting}, with ${subject} close at hand.`,
  ({ title, subject, kind, adjective, verb, setting, tone }) =>
    `From ${setting}, ${title} appears as a ${adjective} ${kind}. It ${verb} of ${subject} and patience. ${tone}`,
  ({ title, subject, kind, adjective, verb, purpose, tone }) =>
    `${title} is a ${adjective} ${kind} shaped by ${subject}. It ${verb} of ${purpose} and quiet labor. ${tone}`,
  ({ title, subject, kind, adjective, setting, purpose }) =>
    `${title} rests like a ${adjective} ${kind} from ${setting}. Its story circles ${subject} and ${purpose}.`,
];

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function pick(list, seed, offset = 0) {
  if (list.length === 0) return "";
  return list[(seed + offset) % list.length];
}

function trimTitle(title = "") {
  return title.replace(/^\[/, "").replace(/\]\.?$/, "");
}

function firstValue(values, fallback) {
  return values && values.length > 0 ? values[0] : fallback;
}

function limitWords(text, maxWords) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ");
}

const stories = {};

items.forEach((item) => {
  const seed = hashString(item.id ?? "");
  const title = trimTitle(item.title || "This object");
  const subject = firstValue(item.subjects, firstValue(item.genres, "daily life"));
  const kind = firstValue(item.objectKinds, firstValue(item.genres, "artifact"));
  const adjective = pick(adjectives, seed, 1);
  const verb = pick(verbs, seed, 2);
  const setting = pick(settings, seed, 3);
  const purpose = pick(purposes, seed, 4);
  const tone = pick(tones, seed, 5);
  const template = pick(templates, seed, 6);

  const text = template({
    title,
    subject: subject.toLowerCase(),
    kind: kind.toLowerCase(),
    adjective,
    verb,
    setting,
    purpose,
    tone,
  });

  stories[item.id] = limitWords(text, 30);
});

const output = {
  generatedAt: new Date().toISOString(),
  source: "curatedCabinetItems.json",
  stories,
};

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`Wrote ${Object.keys(stories).length} stories to ${outputPath}`);
