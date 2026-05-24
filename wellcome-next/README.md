# Wellcome Next Demo

Interactive Next.js demo for exploring Wellcome Collection items in a 3D cabinet panorama.

## Requirements

- Node.js `22.12.0` as specified in `.nvmrc`
- npm, included with Node.js

If you use `nvm`, switch to the expected Node version before installing dependencies:

```bash
nvm use
```

If that version is not installed yet:

```bash
nvm install
nvm use
```

Using the Node version from `.nvmrc` avoids engine warnings and npm failures from unsupported Node releases.

## Setup

Install dependencies from the committed lockfile:

```bash
npm ci
```

This creates `node_modules` and installs the local `next` binary used by the npm scripts. If `npm run dev` prints `sh: next: command not found`, run `npm ci` first.

## Development

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Useful Commands

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run data:curate -- --limit 100 --seed 42
npm run data:genres
npm run data:stories
npm run data:stories:validate
npm run data:audio
```

## Curating Cabinet Data

The demo can build a smaller 3D-candidate dataset from the large root-level `images.json` file:

```bash
npm run data:curate -- --limit 100 --seed 42
```

This writes `src/data/curatedCabinetItems.json`. The script streams `../images.json`, keeps likely 3D-able works using `source.genres`, object-related keywords, subjects, and titles, then adds `connections` between items that share concepts such as anatomy, eyes, instruments, containers, figures, or other metadata terms.

Use `--limit 50` for a smaller set. Change `--seed` to get a different repeatable random selection.

To inspect genre coverage before tuning the curator, run:

```bash
npm run data:genres
```

This writes `src/data/genreReport.json` with all unique `source.genres` values, counts, example titles, and the curator's current classification for each genre.

## Generating Cabinet Stories

The spoken cabinet descriptions are stored in `src/data/cabinetStories.llm.json`. Each entry is keyed by the object `id` from `src/data/curatedCabinetItems.json`, and `CabinetPanorama` reads this file when a user opens a cabinet door.

Generate or refresh the stories from the `wellcome-next` directory:

```bash
npm run data:stories
```

This script calls the OpenAI Responses API. It sends each object's metadata plus its `imageUrl`, asks for a concise spoken label, and writes the result back to `src/data/cabinetStories.llm.json`. `OPENAI_API_KEY` is required; the story generator does not silently fall back to template text.

```bash
OPENAI_API_KEY="your_key_here" npm run data:stories
```

You can choose a different model with `OPENAI_MODEL`:

```bash
OPENAI_API_KEY="your_key_here" OPENAI_MODEL="gpt-4.1-mini" npm run data:stories
```

For a small test run before regenerating everything:

```bash
OPENAI_API_KEY="your_key_here" npm run data:stories -- --limit=3
```

To regenerate one object:

```bash
OPENAI_API_KEY="your_key_here" npm run data:stories -- --id hbke5rty --force
```

Validate that every curated object has a story and that each story is no more than 50 words:

```bash
npm run data:stories:validate
```

After regenerating stories, restart or refresh the dev server so the app uses the updated JSON.

## Generating Natural Narration Audio

By default, the app can read story text with the browser's built-in `speechSynthesis`, but those voices may sound robotic. For warmer narration, generate MP3 files into `public/cabinet-audio`.

When a cabinet door opens, the app tries to play `/cabinet-audio/{objectId}.mp3` first. If the file is missing, it falls back to browser speech.

Generate ElevenLabs narration:

```bash
ELEVENLABS_API_KEY="your_key_here" npm run data:audio
```

The script uses ElevenLabs automatically when `ELEVENLABS_API_KEY` is set. You can choose a specific ElevenLabs voice and model:

```bash
ELEVENLABS_API_KEY="your_key_here" \
ELEVENLABS_VOICE_ID="your_voice_id" \
ELEVENLABS_MODEL="eleven_multilingual_v2" \
npm run data:audio
```

The default ElevenLabs settings use:

```bash
ELEVENLABS_MODEL="eleven_multilingual_v2"
ELEVENLABS_VOICE_ID="JBFqnCBsd6RMkjVDRZzb"
ELEVENLABS_OUTPUT_FORMAT="mp3_44100_128"
```

Existing MP3 files are skipped. To regenerate everything:

```bash
ELEVENLABS_API_KEY="your_key_here" npm run data:audio -- --force
```

You can still generate OpenAI TTS audio instead:

```bash
OPENAI_API_KEY="your_key_here" TTS_PROVIDER="openai" npm run data:audio
```

To make OpenAI narration slightly faster, set `OPENAI_TTS_SPEED`. `1.0` is normal speed; try `1.08` or `1.12` for a subtle increase:

```bash
OPENAI_API_KEY="your_key_here" TTS_PROVIDER="openai" OPENAI_TTS_SPEED="1.1" npm run data:audio -- --force
```

This reads `src/data/cabinetStories.llm.json` and writes one MP3 per object to `public/cabinet-audio/{objectId}.mp3`. Keep those generated files if you want natural narration available in development and deployment. Add an AI-audio disclosure anywhere appropriate if you ship generated narration publicly.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
