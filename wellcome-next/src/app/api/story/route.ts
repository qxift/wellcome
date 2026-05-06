import { NextResponse } from "next/server";
import type { CabinetItem } from "@/data/cabinetItems";

type StoryRequestBody = {
  item?: Partial<CabinetItem>;
};

function buildFallbackStory(item: Partial<CabinetItem>) {
  const title = item.title?.trim() || "This object";
  const theme = item.theme?.toLowerCase() || "cabinet curiosities";
  const year = item.year?.trim() || "an uncertain date";
  const subjectLine = item.subjects?.slice(0, 2).join(", ");
  const genreLine = item.genres?.slice(0, 2).join(", ");

  return `${title} emerges from the cabinet like a clue from another room. It belongs to the world of ${theme}, and the record points to ${year}. ${subjectLine ? `Its subjects, ${subjectLine}, hint at the ideas people wrapped around it.` : ""} ${genreLine ? `As a ${genreLine}, it likely lived both as an object and as a performance of belief, craft, or care.` : ""} Even without every detail, it still feels intimate: something handled, displayed, and remembered by human hands.`;
}

function buildPrompt(item: Partial<CabinetItem>) {
  const metadata = {
    id: item.id,
    workId: item.workId,
    title: item.title,
    theme: item.theme,
    year: item.year,
    type: item.type,
    genres: item.genres ?? [],
    subjects: item.subjects ?? [],
    contributors: item.contributors ?? [],
    objectKinds: item.objectKinds ?? [],
    linkKeywords: item.linkKeywords ?? [],
    license: item.license ?? null,
  };

  return [
    "You are narrating a cabinet-of-curiosities exhibit.",
    "Write one vivid spoken story of 110 to 170 words.",
    "Ground the narration in the supplied metadata.",
    "You may imaginatively infer atmosphere, symbolism, human use, or emotional context, but do not invent exact catalog facts, dates, or provenance beyond the metadata.",
    "Avoid bullet points, headers, and quotation marks.",
    "Sound elegant, curious, and slightly uncanny.",
    "Write in third person or second person, whichever feels more immersive.",
    `Metadata: ${JSON.stringify(metadata)}`,
  ].join("\n");
}

async function generateWithOpenAI(prompt: string) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      temperature: 0.95,
      messages: [
        {
          role: "system",
          content: "You write museum narration that is concise, vivid, and grounded in metadata.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return payload.choices?.[0]?.message?.content?.trim() ?? null;
}

async function generateWithGemini(prompt: string) {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.95,
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini request failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() || null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as StoryRequestBody;
    const item = body.item;

    if (!item?.id || !item.title) {
      return NextResponse.json({ error: "Missing item payload." }, { status: 400 });
    }

    const prompt = buildPrompt(item);
    const story =
      (await generateWithOpenAI(prompt))
      ?? (await generateWithGemini(prompt))
      ?? buildFallbackStory(item);

    return NextResponse.json({ story });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to generate story." }, { status: 500 });
  }
}
