# Dreame Voice-Pack Installer

A local-first web app for preparing and installing user-provided voice packs on a Dreame X40 without relying on the Mindsolo service at runtime.

The original Cloudflare Worker/Mindsolo-compatible API flow has been retired in this repo. Run the API locally so Dreame account credentials and session tokens stay on your machine.

## Local development

1. Install dependencies:

   ```sh
   npm install
   ```

2. Build the frontend:

   ```sh
   npm run build
   ```

3. Start the local API and built frontend together:

   ```sh
   npm run local
   ```

4. Open `http://localhost:5175`, sign in with your Dreamehome account, find the X40, refresh voice status, and upload a voice-pack file.
5. Use the Vacuum panel test buttons to trigger normal robot prompts after sending a pack.

Fallback development commands:

```sh
npm run api:dev
npm run dev
```

If Vite cannot spawn `esbuild` on Windows, use `npm run build` followed by `npm run local`.


## GitHub Pages from another PC

GitHub Pages hosts only the static frontend. The Dreamehome API must still run somewhere you control, because that process holds the Dreame session and serves uploaded voice-pack files.

One workable remote setup is:

```sh
npm run api:dev
cloudflared tunnel --url http://localhost:8787
```

Then open the GitHub Pages app, paste the HTTPS tunnel URL into `API endpoint`, save it, and sign in. If the robot needs to fetch the uploaded voice pack through the same public tunnel, either leave the API behind that tunnel so it can infer the HTTPS host, or start the API with:

```sh
$env:PUBLIC_FILE_BASE_URL='https://YOUR-TUNNEL.trycloudflare.com'; npm run api:dev
```

The Pages app stores only the API endpoint and a temporary local session id in that browser. Dreame credentials still go to your API process, not to GitHub Pages.
## Voice-pack install mode

By default the local API runs in discovery mode. It uploads the file to a temporary local URL, computes MD5 and size, reads the X40 voice-related MIOT properties, and returns the candidate command payload without sending the final write command.

After confirming the payload against your X40, run the API with:

```sh
$env:DREAME_VOICE_INSTALL_MODE='send'; npm run api:dev
```

If the auto-detected LAN URL is not reachable by the robot, set:

```sh
$env:PUBLIC_FILE_BASE_URL='http://YOUR_LAN_IP:8787'; npm run api:dev
```

## Manual X40 validation

Use this sequence before treating send mode as stable:

1. In default discovery mode, confirm Dreamehome password login works locally.
2. Confirm device discovery returns the X40 and the expected model/device id.
3. Refresh voice status and confirm the app reads `siid=7`, `piid=2..4` values.
4. Upload a known-good voice pack and confirm the returned `fileUrl` is reachable from another device on the same LAN.
5. Review the returned command payload, then restart the API with `DREAME_VOICE_INSTALL_MODE=send`.
6. Send one known-good pack, poll voice status before and after, and record the final payload shape if the robot requires changes.
7. Use Return, Pause, or Stop from the Vacuum panel to make the robot speak a normal system prompt and confirm the installed pack is active.

## Important implementation notes

- Credentials are held only in the local Node process memory.
- Login uses Dreamehome cloud OAuth directly; the old Xiaomi/Mi Home login flow is not used at runtime.
- Uploaded voice packs are stored in the OS temp directory under `dreame-voice-packs`.
- Device tokens and sensitive session fields are redacted from API responses.
- The candidate Dreame direct command uses the X40 voice service properties exposed as `siid=7` / `piid=2..4`; this still needs a real-device confirmation pass before treating `send` mode as production-safe.
- The voice test buttons send normal Dreame action commands such as return-to-dock, pause, and stop. They verify audible robot prompts, not arbitrary individual voice-pack files.

## Checks

```sh
npm test
npm run build
```

## Brad quote voice-pack builder

This repo includes a local builder for a Dreame X40 quote pack sourced from [Shit Brad Says](https://shitbradsays.com/) and numbered according to the [voicepacks_dreame](https://github.com/Makers-Im-Zigerschlitz/voicepacks_dreame) sound list.

Prerequisites:

- `ffmpeg` for cutting, filtering, normalizing, and exporting `.ogg` clips.
- `yt-dlp` is strongly recommended for Brad-specific clips because most high-confidence Brad/Snow Plow Show matches are YouTube sources. Some YouTube downloads require explicit `--yt-remote-components`, which lets yt-dlp use its GitHub-hosted JS challenge solver. Without YouTube support, the builder can only cut direct-audio notla/Prankcast matches and coverage will be much lower.
- Optional `tar` for creating `brad-x40.tar.gz` from the generated clips.

Review planned quote matches and source links first:

```sh
npm run build:brad-pack -- -- --dry-run
```

Build a pack:

```sh
npm run build:brad-pack
```

Outputs are written under `.generated/brad-x40/`:

- `clips/*.ogg`: numbered Dreame voice files such as `7.ogg` and `13.ogg`.
- `source-manifest.json`: selected quotes, search terms, timestamps, source links, and runner diagnostics.
- `source-manifest.csv`: spreadsheet-friendly review file.
- `brad-x40.tar.gz`: upload this with the installer after reviewing the manifest.

Useful narrower runs:

```sh
npm run build:brad-pack -- -- --sound-ids "7,13,18"
npm run build:brad-pack -- -- --direct-only
npm run build:brad-pack -- -- --prefer-youtube --yt-remote-components
# Use the old broad transcript behavior only for manual research:
npm run build:brad-pack -- -- --loose --include-prankcast
```

The builder uses a default transcript blocklist to avoid obviously bad home-announcement clips. Pass `--allow-explicit` only if you want to review unfiltered results yourself.
