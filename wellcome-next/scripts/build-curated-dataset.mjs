import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(projectRoot, "..");

const defaultInput = path.join(repoRoot, "images.json");
const defaultOutput = path.join(projectRoot, "src", "data", "curatedCabinetItems.json");

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const inputPath = path.resolve(args.get("--input") ?? defaultInput);
const outputPath = path.resolve(args.get("--output") ?? defaultOutput);
const limit = Number.parseInt(args.get("--limit") ?? "100", 10);
const seed = Number.parseInt(args.get("--seed") ?? "42", 10);
const maxConnections = Number.parseInt(args.get("--max-connections") ?? "8", 10);
const mode = args.get("--mode") ?? "curate";

const strong3dGenreLabels = new Set([
  "amulets",
  "badges",
  "bags",
  "boxes",
  "bronze sculpture",
  "chessmen",
  "clocks and watches",
  "condoms",
  "medal",
  "medals",
  "museum object",
  "plaster sculpture",
  "portrait sculpture",
  "powders",
  "sandals",
  "sculpture",
  "shelf clocks",
  "stereoscopes",
  "tiles",
  "tusks",
  "votive offerings",
  "wax-modeling",
  "wood sculpture",
  "wood-carving",
]);
const supporting3dGenreLabels = new Set([
  "cloth prints",
  "clothing",
  "coats",
  "costumes",
  "painted signs and signboards",
  "samples",
  "scientific illustrations",
  "signs (notices)",
  "still life drawings",
  "still life paintings",
  "still life photographs",
  "still life prints",
  "still lifes",
  "textile fabrics",
  "trade cards",
  "trade catalogues",
  "wooden signs and signboards",
]);
const weak2dGenreLabels = new Set([
  "advertisements",
  "book",
  "book illustrations",
  "broadsides",
  "cards",
  "caricatures",
  "clippings",
  "drawings",
  "engravings",
  "ephemera",
  "etchings",
  "gouaches",
  "handbills",
  "intaglio prints",
  "leaflets",
  "lithographs",
  "manuscript",
  "oil paintings",
  "paintings",
  "pamphlets",
  "periodicals",
  "photographic prints",
  "photographs",
  "postcards",
  "posters",
  "prints",
  "watercolors",
  "wood engravings",
  "woodcuts",
]);

const objectKeywordGroups = {
  anatomy: [
    "anatomical",
    "anatomical figure",
    "anatomical model",
    "body",
    "bone",
    "brain",
    "ear",
    "eye",
    "eyeball",
    "face",
    "foot",
    "hand",
    "heart",
    "head",
    "jaw",
    "limb",
    "skeleton",
    "skull",
    "teeth",
    "tooth",
  ],
  instrument: [
    "apparatus",
    "aspirator",
    "forceps",
    "instrument",
    "microscope",
    "ophthalmoscope",
    "scalpel",
    "speculum",
    "stethoscope",
    "syringe",
    "thermometer",
  ],
  container: ["bottle", "box", "case", "container", "cup", "jar", "pot", "vessel"],
  figure: ["bust", "doll", "effigy", "figure", "figurine", "mask", "model", "statue", "statuette"],
  specimen: ["fossil", "plant", "shell", "specimen", "wax model"],
  wearable: ["amulet", "costume", "dress", "hat", "jewellery", "medal", "ring"],
};

const stopwords = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "being",
  "between",
  "black",
  "brand",
  "century",
  "colour",
  "from",
  "front",
  "group",
  "here",
  "into",
  "made",
  "medical",
  "medicine",
  "museum",
  "number",
  "object",
  "other",
  "part",
  "parts",
  "photograph",
  "property",
  "showing",
  "shown",
  "the",
  "their",
  "this",
  "three",
  "used",
  "with",
]);

function seededRandom(seedValue) {
  let state = seedValue >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function collectConcepts(record) {
  const concepts = [];

  for (const subject of record.source?.subjects ?? []) {
    if (subject.label) {
      concepts.push({
        id: subject.id,
        label: subject.label,
        type: subject.type ?? "Subject",
      });
    }

    for (const concept of subject.concepts ?? []) {
      if (concept.label) {
        concepts.push({
          id: concept.id,
          label: concept.label,
          type: concept.type ?? "Concept",
        });
      }
    }
  }

  return dedupeBy(concepts, (concept) => `${concept.id ?? ""}:${normalizeText(concept.label)}`);
}

function collectGenres(record) {
  return (record.source?.genres ?? [])
    .map((genre) => genre.label)
    .filter(Boolean);
}

function collectContributors(record) {
  return (record.source?.contributors ?? [])
    .map((contributor) => contributor.agent?.label)
    .filter(Boolean);
}

async function reportGenres() {
  const counts = new Map();
  const examples = new Map();
  const input = fs.createReadStream(inputPath);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    for (const genre of record.source?.genres ?? []) {
      const label = genre.label || "(missing)";
      counts.set(label, (counts.get(label) ?? 0) + 1);
      if (!examples.has(label)) examples.set(label, record.source?.title ?? "");
    }
  }

  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => {
      const key = normalizeText(label);
      const category = strong3dGenreLabels.has(key)
        ? "strong-3d"
        : supporting3dGenreLabels.has(key)
          ? "supporting-3d"
          : weak2dGenreLabels.has(key)
            ? "mostly-2d"
            : "unclassified";

      return { label, count, category, exampleTitle: examples.get(label) };
    });

  const output = {
    generatedAt: new Date().toISOString(),
    source: path.relative(projectRoot, inputPath),
    uniqueGenreCount: rows.length,
    categories: {
      strong3d: [...strong3dGenreLabels].sort(),
      supporting3d: [...supporting3dGenreLabels].sort(),
      mostly2d: [...weak2dGenreLabels].sort(),
    },
    genres: rows,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`Wrote ${rows.length} unique genres to ${path.relative(projectRoot, outputPath)}`);
}

function dedupeBy(values, getKey) {
  const seen = new Set();
  const deduped = [];

  for (const value of values) {
    const key = getKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
  }

  return deduped;
}

function getImageUrl(record) {
  const infoUrl = record.thumbnail?.url ?? record.locations?.find((location) => location.locationType?.id === "iiif-image")?.url;

  if (!infoUrl) return "";

  return infoUrl.replace(/\/info\.json$/, "/full/700,/0/default.jpg");
}

function getLicense(record) {
  const license = record.thumbnail?.license ?? record.locations?.find((location) => location.license)?.license;

  return license
    ? {
        id: license.id,
        label: license.label,
        url: license.url,
      }
    : null;
}

function findKeywordGroups(text) {
  const hits = [];

  for (const [group, keywords] of Object.entries(objectKeywordGroups)) {
    for (const keyword of keywords) {
      const normalizedKeyword = normalizeText(keyword);
      const pattern = new RegExp(`(^| )${normalizedKeyword.replaceAll(" ", " +")}( |$)`);

      if (pattern.test(text)) {
        hits.push({ group, keyword });
      }
    }
  }

  return hits;
}

function extractLooseKeywords(record, concepts) {
  const labels = [record.source?.title, ...concepts.map((concept) => concept.label)];
  const words = labels
    .flatMap((label) => normalizeText(label).split(" "))
    .filter((word) => word.length >= 4 && !stopwords.has(word) && !/^\d+$/.test(word));

  const counts = new Map();
  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([word]) => word);
}

function scoreCandidate(record) {
  const title = record.source?.title ?? "";
  const concepts = collectConcepts(record);
  const genres = collectGenres(record);
  const contributors = collectContributors(record);
  const genreKeys = genres.map(normalizeText);
  const metadataText = normalizeText([
    title,
    ...concepts.map((concept) => concept.label),
    ...genres,
    ...contributors,
  ].join(" "));
  const keywordHits = findKeywordGroups(metadataText);
  const strong3dGenres = genreKeys.filter((genre) => strong3dGenreLabels.has(genre));
  const supporting3dGenres = genreKeys.filter((genre) => supporting3dGenreLabels.has(genre));
  const hasStrong3dGenre = strong3dGenres.length > 0;
  const hasSupporting3dGenre = supporting3dGenres.length > 0;
  const hasOnlyWeak2dGenres = genreKeys.length > 0 && genreKeys.every((genre) => weak2dGenreLabels.has(genre));

  let score = 0;
  const reasons = [];

  if (hasStrong3dGenre) {
    score += 8;
    reasons.push(...strong3dGenres.slice(0, 3).map((genre) => `genre:${genre}`));
  }

  if (hasSupporting3dGenre) {
    score += 4;
    reasons.push(...supporting3dGenres.slice(0, 3).map((genre) => `supporting-genre:${genre}`));
  }

  if (keywordHits.length > 0) {
    score += Math.min(7, keywordHits.length * 2);
    reasons.push(...keywordHits.slice(0, 4).map((hit) => `keyword:${hit.keyword}`));
  }

  if (record.aspectRatio && record.aspectRatio > 0.45 && record.aspectRatio < 1.8) {
    score += 1;
  }

  if (record.thumbnail?.license?.id === "pdm" || record.thumbnail?.license?.id === "cc-0") {
    score += 1;
    reasons.push(`license:${record.thumbnail.license.id}`);
  }

  if (hasOnlyWeak2dGenres && !hasStrong3dGenre && !hasSupporting3dGenre) {
    score -= 5;
  }

  return {
    concepts,
    genres,
    contributors,
    keywordHits,
    reasons: dedupeBy(reasons, (reason) => reason),
    score,
  };
}

async function readCandidates() {
  const candidates = [];
  const input = fs.createReadStream(inputPath);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const imageUrl = getImageUrl(record);
    if (!imageUrl || !record.source?.title) continue;

    const scored = scoreCandidate(record);
    if (scored.score < 7) continue;

    const linkKeywords = dedupeBy(
      [
        ...scored.keywordHits.map((hit) => hit.keyword),
        ...scored.concepts.map((concept) => normalizeText(concept.label)),
        ...extractLooseKeywords(record, scored.concepts),
      ],
      (keyword) => keyword,
    ).slice(0, 18);

    const objectKinds = dedupeBy(scored.keywordHits.map((hit) => hit.group), (group) => group);

    candidates.push({
      id: record.id,
      workId: record.source.id,
      title: record.source.title,
      type: record.type,
      imageUrl,
      iiifInfoUrl: record.thumbnail?.url ?? "",
      averageColor: record.averageColor ?? "#9c8f7a",
      aspectRatio: record.aspectRatio ?? null,
      license: getLicense(record),
      genres: scored.genres,
      subjects: scored.concepts.map((concept) => concept.label),
      contributors: scored.contributors,
      objectKinds,
      linkKeywords,
      curation: {
        score: scored.score,
        reasons: scored.reasons,
        needsHumanReview: true,
        modelPath: "",
      },
    });
  }

  return candidates;
}

function selectCuratedItems(candidates) {
  const random = seededRandom(seed);
  const candidateBuckets = new Map();
  const selected = [];
  const workIds = new Set();
  const titles = new Set();

  for (const candidate of candidates) {
    const primaryKind = candidate.objectKinds[0] ?? "other";
    if (!candidateBuckets.has(primaryKind)) candidateBuckets.set(primaryKind, []);
    candidateBuckets.get(primaryKind).push(candidate);
  }

  for (const bucket of candidateBuckets.values()) {
    bucket.sort((a, b) => {
      const weightedA = a.curation.score + random() * 8;
      const weightedB = b.curation.score + random() * 8;
      return weightedB - weightedA;
    });
  }

  const bucketNames = [...candidateBuckets.keys()].sort((a, b) => {
    const sizeDifference = candidateBuckets.get(b).length - candidateBuckets.get(a).length;
    if (sizeDifference !== 0) return sizeDifference;
    return a.localeCompare(b);
  });

  let cursor = 0;
  while (selected.length < limit && bucketNames.length > 0) {
    const bucketName = bucketNames[cursor % bucketNames.length];
    const bucket = candidateBuckets.get(bucketName);
    const candidate = bucket.shift();

    if (!candidate) {
      bucketNames.splice(cursor % bucketNames.length, 1);
      continue;
    }

    const titleKey = normalizeText(candidate.title).replace(/\b\d+(st|nd|rd|th)?\b/g, "").replace(/\s+/g, " ");

    if (!workIds.has(candidate.workId) && !titles.has(titleKey)) {
      selected.push(candidate);
      workIds.add(candidate.workId);
      titles.add(titleKey);
    }

    cursor += 1;
  }

  return selected;
}

function buildConnections(items) {
  const keywordIndex = new Map();
  const subjectIndex = new Map();
  const genreIndex = new Map();

  for (const item of items) {
    for (const keyword of item.linkKeywords) {
      if (!keywordIndex.has(keyword)) keywordIndex.set(keyword, new Set());
      keywordIndex.get(keyword).add(item.id);
    }

    for (const subject of item.subjects.map(normalizeText)) {
      if (!subjectIndex.has(subject)) subjectIndex.set(subject, new Set());
      subjectIndex.get(subject).add(item.id);
    }

    for (const genre of item.genres.map(normalizeText)) {
      if (!genreIndex.has(genre)) genreIndex.set(genre, new Set());
      genreIndex.get(genre).add(item.id);
    }
  }

  return items.map((item) => {
    const scores = new Map();
    const reasons = new Map();

    function addReason(otherId, score, reason) {
      if (otherId === item.id) return;
      scores.set(otherId, (scores.get(otherId) ?? 0) + score);
      if (!reasons.has(otherId)) reasons.set(otherId, []);
      reasons.get(otherId).push(reason);
    }

    for (const keyword of item.linkKeywords) {
      for (const otherId of keywordIndex.get(keyword) ?? []) {
        addReason(otherId, 3, `keyword:${keyword}`);
      }
    }

    for (const subject of item.subjects.map(normalizeText)) {
      for (const otherId of subjectIndex.get(subject) ?? []) {
        addReason(otherId, 4, `subject:${subject}`);
      }
    }

    for (const genre of item.genres.map(normalizeText)) {
      for (const otherId of genreIndex.get(genre) ?? []) {
        addReason(otherId, genre === "museum object" ? 1 : 2, `genre:${genre}`);
      }
    }

    const connections = [...scores.entries()]
      .map(([targetId, score]) => ({
        targetId,
        score,
        reasons: dedupeBy(reasons.get(targetId) ?? [], (reason) => reason).slice(0, 6),
      }))
      .filter((connection) => connection.score >= 5)
      .sort((a, b) => b.score - a.score || a.targetId.localeCompare(b.targetId))
      .slice(0, maxConnections);

    return {
      ...item,
      connections,
    };
  });
}

async function main() {
  if (mode === "genres") {
    await reportGenres();
    return;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }

  const candidates = await readCandidates();
  const selected = selectCuratedItems(candidates);
  const items = buildConnections(selected);
  const output = {
    generatedAt: new Date().toISOString(),
    source: path.relative(projectRoot, inputPath),
    selection: {
      requestedLimit: limit,
      actualCount: items.length,
      seed,
      candidateCount: candidates.length,
      method:
        "Stream images.json, keep likely 3D records from strong 3D genres, supporting object-like genres, and object-related metadata keywords, then link selected items by shared subjects, genres, and normalized object keywords.",
    },
    items,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`Read ${candidates.length} likely 3D candidates from ${path.relative(projectRoot, inputPath)}`);
  console.log(`Wrote ${items.length} curated items to ${path.relative(projectRoot, outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
