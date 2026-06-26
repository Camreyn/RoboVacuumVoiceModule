import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { createLocalServer } from "../server/index.mjs";

const apiPort = Number(process.env.PORT || process.env.API_PORT || 8787);
const webPort = Number(process.env.WEB_PORT || 5175);
const distDir = join(process.cwd(), "dist");

try {
  await stat(join(distDir, "index.html"));
} catch {
  console.error("dist/index.html was not found. Run `npm run build` before `npm run local`.");
  process.exit(1);
}

const allowedOrigin = `http://localhost:${webPort}`;
const api = createLocalServer({ allowedOrigin });
const web = createStaticServer(distDir);

await listen(api, apiPort, "Dreame local API");
await listen(web, webPort, "Dreame frontend");

console.log("");
console.log(`Open http://localhost:${webPort}`);
console.log(`API  http://localhost:${apiPort}`);
console.log("Press Ctrl+C to stop both servers.");

function createStaticServer(root) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      const requestedPath = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
      const filePath = join(root, requestedPath || "index.html");
      const safePath = filePath.startsWith(root) ? filePath : join(root, "index.html");
      const resolvedPath = (await fileExists(safePath)) ? safePath : join(root, "index.html");
      response.writeHead(200, { "content-type": contentType(resolvedPath) });
      createReadStream(resolvedPath).pipe(response);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : "Static server failed");
    }
  });
}

async function fileExists(path) {
  try {
    const entry = await stat(path);
    return entry.isFile();
  } catch {
    return false;
  }
}

function contentType(path) {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      console.log(`${label} listening on http://localhost:${port}`);
      resolve();
    });
  });
}