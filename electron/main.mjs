import { app, BrowserWindow, dialog } from "electron";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalServer } from "../server/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, "..");
const distRoot = join(appRoot, "dist");
const preferredApiPort = Number(process.env.PORT || 8787);

let apiServer;
let uiServer;
let mainWindow;

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server.address().port;
}

async function startApi() {
  apiServer = createLocalServer();
  try {
    return await listen(apiServer, preferredApiPort);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
      apiServer = createLocalServer();
      return listen(apiServer, 0);
    }
    throw error;
  }
}

async function startUi() {
  uiServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      const fullPath = normalize(join(distRoot, requestedPath));

      if (!fullPath.startsWith(normalize(distRoot))) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const file = await stat(fullPath).catch(() => null);
      if (!file?.isFile()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      res.writeHead(200, {
        "Content-Type": contentTypes.get(extname(fullPath).toLowerCase()) || "application/octet-stream",
        "Content-Length": String(file.size),
      });
      createReadStream(fullPath).pipe(res);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(error instanceof Error ? error.message : "Unexpected error");
    }
  });

  return listen(uiServer, 0);
}

async function createWindow() {
  const actualApiPort = await startApi();
  const uiPort = await startUi();

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Dreame Voice-Pack Installer",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await mainWindow.loadURL(`http://localhost:${uiPort}?apiBase=${encodeURIComponent(`http://localhost:${actualApiPort}`)}`);
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox("Dreame Voice-Pack Installer failed to start", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  apiServer?.close();
  uiServer?.close();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((error) => {
      dialog.showErrorBox("Dreame Voice-Pack Installer failed to start", error instanceof Error ? error.message : String(error));
    });
  }
});
