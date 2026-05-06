import curatedCabinetItems from "@/data/curatedCabinetItems.json";

export type CabinetItem = {
  id: string;
  workId: string;
  title: string;
  theme: string;
  year: string;
  imageUrl: string;
  color: string;
  type?: string;
  modelUrl?: string;
  subjects?: string[];
  genres?: string[];
  contributors?: string[];
  objectKinds?: string[];
  linkKeywords?: string[];
  license?: {
    id: string;
    label: string;
    url: string;
  };
};

type CuratedCabinetItem = {
  id: string;
  workId: string;
  title: string;
  imageUrl: string;
  type?: string;
  averageColor?: string;
  subjects?: string[];
  genres?: string[];
  contributors?: string[];
  objectKinds?: string[];
  linkKeywords?: string[];
  license?: {
    id: string;
    label: string;
    url: string;
  };
};

type CuratedCabinetPayload = {
  items: CuratedCabinetItem[];
};

const curatedPayload = curatedCabinetItems as CuratedCabinetPayload;
const minimumLinkKeywordOccurrences = 3;
const linkKeywordCounts = curatedPayload.items.reduce((counts, item) => {
  for (const keyword of item.linkKeywords ?? []) {
    counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
  }

  return counts;
}, new Map<string, number>());
const eligibleLinkKeywords = new Set(
  [...linkKeywordCounts.entries()]
    .filter(([, count]) => count >= minimumLinkKeywordOccurrences)
    .map(([keyword]) => keyword),
);

const modelWorkIds = new Set([
  "az6qx7eu",
  "d6wzjd9e",
  "d75x5jxb",
  "dqeatw9e",
  "dwbj8wfc",
  "gkdmrv39",
  "tush7jc4",
  "vuu9478p",
  "w769nuvt",
  "x5xxa2x3",
  "yc73esn7",
  "yggjzycp",
  "z7vcgdkz",
]);

function getLocalCabinetImageUrl(itemId: string) {
  return `/cabinet-images/${itemId}.jpg`;
}

export const cabinetItems: CabinetItem[] = curatedPayload.items
  .map((item) => ({
    id: item.id,
    workId: item.workId,
    title: item.title,
    theme: item.subjects?.[0] ?? item.genres?.[0] ?? "Cabinet Curiosities",
    year: "date unknown",
    imageUrl: getLocalCabinetImageUrl(item.id),
    color: item.averageColor ?? "#8f7f6a",
    type: item.type,
    modelUrl: modelWorkIds.has(item.workId) ? `/models_3d/${item.workId}.glb` : undefined,
    subjects: item.subjects ?? [],
    genres: item.genres ?? [],
    contributors: item.contributors ?? [],
    objectKinds: item.objectKinds ?? [],
    linkKeywords: (item.linkKeywords ?? []).filter((keyword) => eligibleLinkKeywords.has(keyword)),
    license: item.license,
  }));
