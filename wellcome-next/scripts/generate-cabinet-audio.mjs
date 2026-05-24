import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const storiesPath = path.join(rootDir, "src", "data", "cabinetStories.llm.json");
const audioDir = path.join(rootDir, "public", "cabinet-audio");

function parseArgs(argv) {
  const options = {
    force: false,
    ids: new Set(),
    limit: null,
    provider: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--force") {
      options.force = true;
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
    } else if (arg === "--provider") {
      const value = argv[index + 1];
      if (!value) throw new Error("--provider requires a value");
      options.provider = value;
      index += 1;
    } else if (arg.startsWith("--provider=")) {
      options.provider = arg.slice("--provider=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const provider = options.provider ?? process.env.TTS_PROVIDER ?? (process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "openai");
const openAiApiKey = process.env.OPENAI_API_KEY;
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const openAiModel = process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
const openAiVoice = process.env.OPENAI_TTS_VOICE ?? "marin";
const openAiSpeed = Number(process.env.OPENAI_TTS_SPEED ?? "1.1");
const elevenLabsModel = process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2";
const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb";
const outputFormat = process.env.ELEVENLABS_OUTPUT_FORMAT ?? "mp3_44100_128";
const force = options.force;

if (provider !== "elevenlabs" && provider !== "openai") {
  console.error(`Unsupported TTS provider "${provider}". Use "elevenlabs" or "openai".`);
  process.exit(1);
}

if (provider === "elevenlabs" && !elevenLabsApiKey) {
  console.error("Missing ELEVENLABS_API_KEY. Set it before running this script.");
  process.exit(1);
}

if (provider === "openai" && !openAiApiKey) {
  console.error("Missing OPENAI_API_KEY. Set it before running this script.");
  process.exit(1);
}

if (provider === "openai" && (!Number.isFinite(openAiSpeed) || openAiSpeed < 0.25 || openAiSpeed > 4)) {
  console.error("OPENAI_TTS_SPEED must be a number from 0.25 to 4.0.");
  process.exit(1);
}

const stories = JSON.parse(fs.readFileSync(storiesPath, "utf8"));
let selectedStories = Object.entries(stories);

if (options.ids.size > 0) {
  selectedStories = selectedStories.filter(([itemId]) => options.ids.has(itemId));
  const missingIds = [...options.ids].filter((id) => !(id in stories));
  if (missingIds.length > 0) {
    console.error(`Unknown story id(s): ${missingIds.join(", ")}`);
    process.exit(1);
  }
}

if (options.limit !== null) {
  selectedStories = selectedStories.slice(0, options.limit);
}

fs.mkdirSync(audioDir, { recursive: true });

async function generateWithElevenLabs(story) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId}/stream?output_format=${outputFormat}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": elevenLabsApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: story,
        model_id: elevenLabsModel,
        voice_settings: {
          stability: 0.44,
          similarity_boost: 0.82,
          style: 0.34,
          use_speaker_boost: true,
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs TTS failed: ${response.status} ${await response.text()}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function generateWithOpenAI(story) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openAiModel,
      voice: openAiVoice,
      input: story,
      instructions: [
        "Narrate like a calm museum audio guide.",
        "Sound warm, intimate, curious, and natural.",
        "Use measured pacing with subtle wonder.",
        "Avoid sounding like a synthetic assistant.",
      ].join(" "),
      response_format: "mp3",
      speed: openAiSpeed,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI TTS failed: ${response.status} ${await response.text()}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

for (const [index, [itemId, story]] of selectedStories.entries()) {
  const outputPath = path.join(audioDir, `${itemId}.mp3`);

  if (!force && fs.existsSync(outputPath)) {
    console.log(`Skipping ${index + 1}/${selectedStories.length}: ${itemId}.mp3 already exists`);
    continue;
  }

  console.log(`Generating ${provider} audio ${index + 1}/${selectedStories.length}: ${itemId}`);

  const audio = provider === "elevenlabs"
    ? await generateWithElevenLabs(story)
    : await generateWithOpenAI(story);

  fs.writeFileSync(outputPath, audio);
}

console.log(`Audio files are ready in ${audioDir}`);
