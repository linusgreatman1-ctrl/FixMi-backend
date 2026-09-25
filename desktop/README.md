# FixMe Desktop (Electron)

A thin desktop shell around the real FixMe web app — same reasoning as
`mobile/`: it loads your deployed backend's `/app` directly instead of
bundling a second copy of the frontend, so there's exactly one frontend to
maintain and the desktop app can never drift from the web version.

## Setup

```bash
cd desktop
npm install
FIXME_APP_URL=https://your-deployed-backend.example.com/app npm start
```

Or edit the `APP_URL` fallback directly in `main.js` if you'd rather not
set the env var every time.

## Building installers

```bash
npm run dist
```

Produces a `.dmg` (macOS), `.exe` installer via NSIS (Windows), or
`.AppImage` (Linux) in `desktop/dist/` via electron-builder, using
whichever OS you run the command on (cross-compiling to macOS requires
running on macOS).

## Known gaps

- No app icon yet — drop a 512×512 `icon.png` in this folder and it'll
  be picked up automatically by both `main.js` (window icon) and
  electron-builder (installer icon).
- No auto-update wiring (e.g. `electron-updater`) — out of scope for
  this first pass.
