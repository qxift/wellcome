import curatedCabinetItems from "@/data/curatedCabinetItems.json";

export type CabinetItem = {
  id: string;
  title: string;
  theme: string;
  year: string;
  imageUrl: string;
  color: string;
};

type CuratedCabinetItem = {
  id: string;
  title: string;
  imageUrl: string;
  averageColor?: string;
  subjects?: string[];
  genres?: string[];
};

type CuratedCabinetPayload = {
  items: CuratedCabinetItem[];
};

const curatedPayload = curatedCabinetItems as CuratedCabinetPayload;

export const cabinetItems: CabinetItem[] = curatedPayload.items.map((item) => ({
  id: item.id,
  title: item.title,
  theme: item.subjects?.[0] ?? item.genres?.[0] ?? "Cabinet Curiosities",
  year: "date unknown",
  imageUrl: item.imageUrl,
  color: item.averageColor ?? "#8f7f6a",
}));
