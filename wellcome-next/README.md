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

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
