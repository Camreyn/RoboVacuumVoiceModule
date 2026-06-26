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

Fallback development commands:

```sh
npm run api:dev
npm run dev
```

If Vite cannot spawn `esbuild` on Windows, use `npm run build` followed by `npm run local`.

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

## Important implementation notes

- Credentials are held only in the local Node process memory.
- Login uses Dreamehome cloud OAuth directly; the old Xiaomi/Mi Home login flow is not used at runtime.
- Uploaded voice packs are stored in the OS temp directory under `dreame-voice-packs`.
- Device tokens and sensitive session fields are redacted from API responses.
- The candidate Dreame direct command uses the X40 voice service properties exposed as `siid=7` / `piid=2..4`; this still needs a real-device confirmation pass before treating `send` mode as production-safe.

## Checks

```sh
npm test
npm run build
```
