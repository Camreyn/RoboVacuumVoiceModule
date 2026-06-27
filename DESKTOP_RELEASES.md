# Desktop App Releases

This repository builds a downloadable Windows desktop app with Electron. The app packages the local Dreame API and the React UI together, so users do not need to run a separate dev server.

## Local Build

```sh
npm install
npm run desktop:build
```

Artifacts are written to `release/`:

- `Dreame Voice-Pack Installer-<version>-win-x64.exe` installer
- `Dreame Voice-Pack Installer-<version>-win-x64.zip` portable zip

For a faster packaging smoke test without generating installers:

```sh
npm run desktop:dir
```

## Automatic Downloads

`.github/workflows/desktop-release.yml` builds the Windows app on pushes to `main` or `master`.

- Normal pushes update the `Latest Desktop Build` prerelease under GitHub Releases.
- Pushing a tag like `v0.1.0` creates a normal versioned GitHub Release.

The GitHub Pages site is independent and is not required for the desktop app.
