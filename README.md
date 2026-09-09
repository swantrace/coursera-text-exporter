# Coursera Text Exporter

Manifest V3 unpacked Chrome extension for collecting Coursera captions and reading materials through the Coursera API. Jobs are stored in IndexedDB and resume after worker restarts. Export Markdown, TXT, JSON, or ZIP locally, and optionally sync Markdown to Google Drive.

## Quick start

1. Sign in to Coursera in the same Chrome profile used to load the extension.
2. Run `npm install` and `npm run build`.
3. Open `chrome://extensions`, enable Developer mode, and load `dist/` unpacked.
4. Enter a course URL or slug, choose options, and start collection.

Video defaults are 360p and MP4. Videos and matching SRT/VTT sidecars are written by Chrome's download manager; media is not placed in ZIP exports or uploaded to Drive.

## Development

```bash
npm run check
npm run smoke
npm run smoke:video
npm run test:hooks
```

`npm run check` runs warning-free Biome, TypeScript, tests, and the production build. Husky runs the Biome write check on staged files before every commit; warnings fail the hook.

## Google Drive

Local export works without OAuth. Configure a Chrome Extension OAuth client ID in `config.local.json`, rebuild, reload the extension, and click Connect Google Drive to enable sync. Only `drive.file` is requested. Tokens are managed by Chrome Identity and are never stored in the database or logs.

## Architecture

- `src/api/`: Coursera API, rate limiting, and network errors.
- `src/parsers/`: outline, WebVTT, HTML/Markdown, and CML conversion.
- `src/background/`: service worker, scheduler, and native downloads.
- `src/storage/`: IndexedDB queue and snapshots.
- `src/sync/`: Google Identity and Drive uploads.
- `src/export/`: aggregation, reports, and ZIP creation.
- `src/popup/`: English control panel.
- `src/offscreen/`: local Blob URL generation.

