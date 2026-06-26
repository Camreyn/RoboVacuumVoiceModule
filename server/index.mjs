import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = Number(process.env.PORT || 8787);
const DEFAULT_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const COOKIE_NAME = "dvpi_local_session";
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const VOICE_PROPERTIES = [
  { did: "7.2", siid: 7, piid: 2, name: "voice_packet_id" },
  { did: "7.3", siid: 7, piid: 3, name: "voice_change_status" },
  { did: "7.4", siid: 7, piid: 4, name: "voice_change" },
];

const sessions = new Map();
const jobs = new Map();

export function createLocalServer(options = {}) {
  const config = {
    allowedOrigin: options.allowedOrigin || DEFAULT_ORIGIN,
    clientFactory: options.clientFactory || ((credentials) => new DreameCloudClient(credentials)),
    publicFileBaseUrl: options.publicFileBaseUrl,
    sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    voiceInstallMode: options.voiceInstallMode,
  };

  return createServer(async (req, res) => {
    try {
      await routeRequest(req, res, config);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(req, res, { message: error.message || "Unexpected error" }, status, config.allowedOrigin);
    }
  });
}

async function routeRequest(req, res, config) {
  const { allowedOrigin } = config;
  setCors(req, res, allowedOrigin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readJsonBody(req);
    const username = stringField(body, "username");
    const password = stringField(body, "password");
    const country = stringField(body, "country");
    const captchaCode = optionalString(body.captchaCode);
    const client = config.clientFactory({ username, password, country });
    const result = await client.login({ captchaCode });
    const sessionId = createSession(client, result.status === "authenticated" ? "authenticated" : "pending");

    sendJson(req, res, result, 200, allowedOrigin, sessionCookie(sessionId));
    return;
  }

  if (url.pathname === "/api/auth/verify-2fa" && req.method === "POST") {
    const session = getSession(req, config.sessionTtlMs);
    const body = await readJsonBody(req);
    const code = stringField(body, "code");
    const result = await session.client.verifyCode(code);
    session.state = "authenticated";
    session.updatedAt = Date.now();
    sendJson(req, res, result, 200, allowedOrigin);
    return;
  }

  if (url.pathname === "/api/auth/session" && req.method === "DELETE") {
    const sessionId = getSessionId(req);
    if (sessionId) sessions.delete(sessionId);
    sendJson(req, res, { ok: true }, 200, allowedOrigin, clearSessionCookie());
    return;
  }

  if (url.pathname === "/api/devices" && req.method === "GET") {
    const { client } = requireAuthenticatedSession(req, config.sessionTtlMs);
    const devices = (await client.getDevices()).map(normalizeDevice).filter(Boolean);
    sendJson(req, res, { devices }, 200, allowedOrigin);
    return;
  }

  const propertiesMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/properties$/);
  if (propertiesMatch && req.method === "GET") {
    const { client } = requireAuthenticatedSession(req, config.sessionTtlMs);
    const deviceId = decodeURIComponent(propertiesMatch[1]);
    const properties = await client.getVoiceProperties(deviceId);
    sendJson(req, res, properties, 200, allowedOrigin);
    return;
  }

  const voicePackMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/voice-pack$/);
  if (voicePackMatch && req.method === "POST") {
    const { client } = requireAuthenticatedSession(req, config.sessionTtlMs);
    const deviceId = decodeURIComponent(voicePackMatch[1]);
    const formRequest = await toWebRequest(req);
    const form = await formRequest.formData();
    const file = form.get("file");

    if (!(file instanceof File)) throw new HttpError("Voice-pack file is required.", 400);

    const record = await persistVoicePack(file, publicBaseUrl(req, config.publicFileBaseUrl));
    const before = await client.getVoiceProperties(deviceId).catch((error) => ({ message: error.message }));
    const command = createVoiceInstallPayload(record);
    const job = {
      id: record.jobId,
      deviceId,
      fileName: record.fileName,
      fileUrl: record.url,
      md5: record.md5,
      size: record.size,
      status: "prepared",
      command,
      before,
      createdAt: Date.now(),
    };

    const shouldSend = (config.voiceInstallMode || process.env.DREAME_VOICE_INSTALL_MODE || "discover") === "send";
    if (shouldSend) {
      const result = await client.sendVoiceInstallCommand(deviceId, record);
      job.status = "sent";
      job.result = result;
      job.after = await client.getVoiceProperties(deviceId).catch((error) => ({ message: error.message }));
    }

    jobs.set(job.id, job);
    sendJson(
      req,
      res,
      {
        success: shouldSend,
        jobId: job.id,
        message: shouldSend
          ? "Voice-pack install command sent."
          : "Voice pack is prepared. Set DREAME_VOICE_INSTALL_MODE=send after confirming the X40 payload.",
        ...job,
      },
      200,
      allowedOrigin,
    );
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/voice-jobs\/([^/]+)$/);
  if (jobMatch && req.method === "GET") {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    if (!job) throw new HttpError("Voice job was not found.", 404);
    sendJson(req, res, job, 200, allowedOrigin);
    return;
  }

  const packMatch = url.pathname.match(/^\/packs\/([^/]+)\/([^/]+)$/);
  if (packMatch && req.method === "GET") {
    await servePack(res, packMatch[1], packMatch[2]);
    return;
  }

  sendJson(req, res, { message: "Not found" }, 404, allowedOrigin);
}

export class DreameCloudClient {
  constructor({ username, password, country }) {
    this.username = username;
    this.password = password;
    this.region = normalizeDreameRegion(country || "eu");
    this.accountCountry = "GB";
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this.uid = null;
  }

  async login() {
    const body = await this.passwordLogin();
    this.applyTokenResponse(body);
    const deviceRegion = regionForCountry(this.accountCountry, this.region);
    if (deviceRegion !== this.region) this.region = deviceRegion;
    return { status: "authenticated" };
  }

  async passwordLogin() {
    const response = await this.dreamePost("/dreame-auth/oauth/token", {
      data: {
        grant_type: "password",
        username: this.username,
        password: hashDreamePassword(this.password),
        scope: "all",
        platform: "IOS",
        type: "account",
        country: this.accountCountry,
        lang: "en",
      },
      auth: false,
    });
    return response.body;
  }

  async verifyCode() {
    throw new HttpError("Dreamehome email-code verification is not wired yet. Add a password to your Dreamehome account and sign in with that password.", 400);
  }

  async getDevices() {
    await this.ensureValidToken();
    const response = await this.dreamePost("/dreame-user-iot/iotuserbind/device/listV2");
    const raw = response.body?.data ?? response.body?.result ?? [];
    return dedupeDevices(extractDreameDeviceRecords(raw));
  }

  async getVoiceProperties(deviceId) {
    const result = await this.send(deviceId, "get_properties", VOICE_PROPERTIES.map(({ siid, piid }) => ({ siid, piid, did: deviceId })));
    return { raw: result, properties: mapVoiceProperties(result) };
  }

  async sendVoiceInstallCommand(deviceId, fileRecord) {
    const payload = createVoiceInstallPayload(fileRecord);
    return this.send(deviceId, "set_properties", [
      { did: deviceId, siid: 7, piid: 4, value: JSON.stringify(payload) },
    ]);
  }

  async send(deviceId, method, params) {
    await this.ensureValidToken();
    const body = await this.sendCommand(deviceId, method, params);
    return extractDreameRpcResult(body);
  }

  async sendCommand(deviceId, method, params, retry = true) {
    const response = await this.dreamePost("/dreame-iot-com-10000/device/sendCommand", {
      json: {
        did: deviceId,
        id: 1,
        data: {
          did: deviceId,
          id: 1,
          method,
          params,
        },
      },
      throwOnAuth: false,
    });

    if (response.status === 401 && retry && this.refreshToken) {
      await this.refreshAccessToken();
      return this.sendCommand(deviceId, method, params, false);
    }

    if (response.status === 401) throw new HttpError("Dreamehome session expired. Sign in again.", 401);
    if (response.status !== 200) throw dreameHttpError(response, `Dreame RPC ${method} failed`);

    const code = response.body?.code;
    if (code === -1 || code === -9999) throw new HttpError(`Device ${deviceId} appears offline.`, 409);
    return response.body;
  }

  async ensureValidToken() {
    if (!this.accessToken) throw new HttpError("Dreamehome session is not authenticated.", 401);
    if (Date.now() + 60_000 < this.expiresAt) return;
    if (!this.refreshToken) return;
    await this.refreshAccessToken();
  }

  async refreshAccessToken() {
    const response = await this.dreamePost("/dreame-auth/oauth/token", {
      data: {
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
      },
      auth: false,
      throwOnAuth: false,
    });
    if (response.status === 401) throw new HttpError("Dreamehome session expired. Sign in again.", 401);
    if (response.status !== 200) throw dreameHttpError(response, "Dreamehome token refresh failed");
    this.applyTokenResponse(response.body);
  }

  applyTokenResponse(body) {
    if (!body?.access_token) throw new HttpError(dreameErrorMessage(body, "Dreamehome login did not return an access token."), 401);
    this.accessToken = String(body.access_token);
    this.refreshToken = body.refresh_token ? String(body.refresh_token) : this.refreshToken;
    this.uid = body.uid ? String(body.uid) : this.uid;
    this.accountCountry = body.country ? String(body.country).toUpperCase() : this.accountCountry;
    const expiresIn = Number(body.expires_in || 7200);
    this.expiresAt = Date.now() + expiresIn * 1000;
  }

  async dreamePost(path, options = {}) {
    const headers = this.dreameHeaders(Boolean(options.auth ?? true));
    let body;

    if (options.data) {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(options.data);
    }

    if (options.json) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.json);
    }

    const response = await fetch(`${this.baseUrl()}${path}`, { method: "POST", headers, body });
    const text = await response.text();
    const parsed = text ? parseJsonBody(text) : {};
    const result = { status: response.status, ok: response.ok, body: parsed };

    if (response.status === 401 && options.throwOnAuth !== false) {
      throw new HttpError(dreameErrorMessage(parsed, "Dreamehome login failed."), 401);
    }
    if (response.status >= 500) throw dreameHttpError(result, "Dreamehome service request failed");
    return result;
  }

  dreameHeaders(includeToken) {
    const headers = new Headers({
      Authorization: "Basic ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg=",
      "Tenant-Id": "000000",
      "Dreame-Meta": "cv=i_829",
      "Dreame-Rlc": makeDreameRlc(this.region, "en", this.accountCountry),
      "User-Agent": "Dreame_Smarthome/2.1.9 (iPhone; iOS 18.4.1; Scale/3.00)",
    });
    if (includeToken && this.accessToken) headers.set("Dreame-Auth", `bearer ${this.accessToken}`);
    return headers;
  }

  baseUrl() {
    return `https://${this.region}.iot.dreame.tech:13267`;
  }
}
export function hashDreamePassword(password) {
  return createHash("md5").update(`${password}RAylYC%fmSKp7%Tq`).digest("hex");
}

export function makeDreameRlc(region, lang = "en", country = "GB") {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from("EETjszu*XI5znHsI"), null);
  const encrypted = Buffer.concat([cipher.update(`${region}|${lang}|${country}`, "utf8"), cipher.final()]);
  return encrypted.toString("base64");
}

export function normalizeDreameRegion(value) {
  const region = String(value || "eu").trim().toLowerCase();
  if (["eu", "us", "cn"].includes(region)) return region;
  if (["usa", "ca", "canada"].includes(region)) return "us";
  if (["china"].includes(region)) return "cn";
  return "eu";
}

export function regionForCountry(country, fallback = "eu") {
  const code = String(country || "").toUpperCase();
  if (["US", "CA"].includes(code)) return "us";
  if (code === "CN") return "cn";
  return normalizeDreameRegion(fallback);
}

function extractDreameDeviceRecords(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.page?.records)) return raw.page.records;
  if (Array.isArray(raw?.records)) return raw.records;
  return [];
}

function extractDreameRpcResult(body) {
  const data = body?.data ?? body;
  const result = data?.result ?? data;
  return Array.isArray(result) ? result : result?.result ?? result;
}

function dreameHttpError(response, fallback) {
  return new HttpError(dreameErrorMessage(response.body, `${fallback} with HTTP ${response.status}.`), response.status >= 400 && response.status < 600 ? response.status : 502);
}

function dreameErrorMessage(body, fallback) {
  if (!body || typeof body !== "object") return fallback;
  return String(body.msg || body.message || body.error_description || body.error || fallback);
}

function parseJsonBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
export function createVoiceInstallPayload(fileRecord) {
  return {
    id: "custom",
    lang_id: "custom",
    url: fileRecord.url,
    md5: fileRecord.md5,
    size: fileRecord.size,
    name: fileRecord.fileName,
  };
}

export function normalizeDevice(device) {
  if (!device || typeof device !== "object") return null;
  const id = stringValue(device.did) || stringValue(device.id);
  const model = stringValue(device.model);
  if (!id || !model || !model.toLowerCase().includes("vacuum")) return null;
  return {
    id,
    app: "dreamehome",
    name: stringValue(device.customName) || stringValue(device.name) || stringValue(device.device_name) || model,
    model,
    localIp: stringValue(device.localip) || stringValue(device.localIp) || stringValue(device.ip),
    token: device.token ? "[redacted]" : undefined,
    source: "dreame-cloud",
  };
}

export function generateEncParams(url, method, params, ssecurity) {
  const nonce = generateNonce();
  const nextSignedNonce = signedNonce(nonce, ssecurity);
  const fields = { ...params };
  fields.rc4_hash__ = generateEncSignature(url, method, nextSignedNonce, fields);
  for (const [key, value] of Object.entries(fields)) fields[key] = encryptRc4(nextSignedNonce, String(value));
  fields.signature = generateEncSignature(url, method, nextSignedNonce, fields);
  fields.ssecurity = ssecurity;
  fields._nonce = nonce;
  return fields;
}

function generateEncSignature(url, method, signed, params) {
  const path = new URL(url).pathname.replace(/^\/app\//, "/");
  const parts = [method.toUpperCase(), path, ...Object.entries(params).map(([key, value]) => `${key}=${value}`), signed];
  return createHash("sha1").update(parts.join("&")).digest("base64");
}

function signedNonce(nonce, ssecurity) {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from(ssecurity, "base64"), Buffer.from(nonce, "base64")]))
    .digest("base64");
}

function generateNonce() {
  const minute = Math.floor(Date.now() / 60000);
  const minuteBytes = [];
  let value = minute;
  while (value > 0) {
    minuteBytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.concat([randomBytes(8), Buffer.from(minuteBytes)]).toString("base64");
}

function encryptRc4(password, payload) {
  return arc4(Buffer.from(password, "base64"), Buffer.from(payload)).toString("base64");
}

function decryptRc4(password, payload) {
  return arc4(Buffer.from(password, "base64"), Buffer.from(payload, "base64")).toString("utf8");
}

export function arc4(key, payload) {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let i = 0;
  j = 0;
  const next = () => {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
    return state[(state[i] + state[j]) & 0xff];
  };
  for (let drop = 0; drop < 1024; drop += 1) next();
  return Buffer.from(Array.from(payload, (byte) => byte ^ next()));
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  get(name) {
    return this.cookies.get(name);
  }
  header(extra = {}) {
    const pairs = [...this.cookies.entries(), ...Object.entries(extra)].filter(([, value]) => value);
    return pairs.map(([key, value]) => `${key}=${value}`).join("; ");
  }
  store(headers) {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : splitSetCookie(headers.get("set-cookie"));
    for (const value of values) {
      const [pair] = value.split(";");
      const index = pair.indexOf("=");
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,]+=)/);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function toWebRequest(req) {
  return new Request(`http://${req.headers.host || "localhost"}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half",
  });
}

async function persistVoicePack(file, baseUrl) {
  const jobId = randomBytes(8).toString("hex");
  const fileName = sanitizeFileName(file.name || "voice-pack.pkg");
  const bytes = Buffer.from(await file.arrayBuffer());
  const md5 = createHash("md5").update(bytes).digest("hex");
  const root = join(tmpdir(), "dreame-voice-packs", jobId);
  await mkdir(root, { recursive: true });
  const path = join(root, fileName);
  await writeFile(path, bytes);
  return { jobId, fileName, path, md5, size: bytes.length, url: `${baseUrl}/packs/${jobId}/${encodeURIComponent(fileName)}` };
}

async function servePack(res, jobId, fileName) {
  const safeJobId = jobId.replace(/[^a-f0-9]/gi, "");
  const safeFileName = sanitizeFileName(decodeURIComponent(fileName));
  const path = join(tmpdir(), "dreame-voice-packs", safeJobId, safeFileName);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${basename(safeFileName)}"`,
  });
  createReadStream(path).pipe(res);
}

function publicBaseUrl(req, configuredBaseUrl) {
  if (configuredBaseUrl) return configuredBaseUrl.replace(/\/$/, "");
  if (process.env.PUBLIC_FILE_BASE_URL) return process.env.PUBLIC_FILE_BASE_URL.replace(/\/$/, "");
  const host = req.headers.host || `localhost:${DEFAULT_PORT}`;
  const lanIp = findLanIp();
  const port = host.includes(":") ? host.split(":").pop() : String(DEFAULT_PORT);
  return `http://${lanIp || "localhost"}:${port}`;
}

function findLanIp() {
  const interfaces = Object.values(networkInterfaces()).flat();
  const candidate = interfaces.find((item) => item && item.family === "IPv4" && !item.internal);
  return candidate?.address;
}

function mapVoiceProperties(result) {
  const mapped = {};
  for (const item of Array.isArray(result) ? result : []) {
    const match = VOICE_PROPERTIES.find((prop) => prop.siid === item.siid && prop.piid === item.piid);
    if (match) mapped[match.name] = item.value ?? item.code ?? item;
  }
  return mapped;
}

function dedupeDevices(devices) {
  const seen = new Set();
  return devices.filter((device) => {
    const key = device?.did || device?.id || device?.mac;
    if (!key || seen.has(String(key))) return false;
    seen.add(String(key));
    return true;
  });
}

function createSession(client, state) {
  const id = randomBytes(18).toString("base64url");
  sessions.set(id, { id, client, state, updatedAt: Date.now() });
  return id;
}

function getSession(req, sessionTtlMs = DEFAULT_SESSION_TTL_MS) {
  const id = getSessionId(req);
  const session = id ? sessions.get(id) : null;
  if (!session || Date.now() - session.updatedAt > sessionTtlMs) throw new HttpError("Session is missing or expired.", 401);
  return session;
}

function requireAuthenticatedSession(req, sessionTtlMs = DEFAULT_SESSION_TTL_MS) {
  const session = getSession(req, sessionTtlMs);
  if (session.state !== "authenticated") throw new HttpError("Dreame session is not authenticated.", 401);
  session.updatedAt = Date.now();
  return session;
}

function getSessionId(req) {
  return parseCookies(req.headers.cookie || "")[COOKIE_NAME];
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function sessionCookie(id) {
  return `${COOKIE_NAME}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function sendJson(req, res, body, status, allowedOrigin, cookie) {
  setCors(req, res, allowedOrigin);
  if (cookie) res.setHeader("Set-Cookie", cookie);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(redact(body)));
}

function setCors(req, res, allowedOrigin) {
  const origin = req.headers.origin;
  const corsOrigin = isAllowedLocalOrigin(origin) ? origin : allowedOrigin;
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Vary", "Origin");
}

function isAllowedLocalOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || origin === DEFAULT_ORIGIN;
  } catch {
    return false;
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, /token|password|ssecurity|service/i.test(key) ? "[redacted]" : redact(item)]),
  );
}

function parseXiaomiJson(text) {
  return JSON.parse(text.replace(/^&&&START&&&/, ""));
}

function absoluteAccountUrl(value) {
  return value.startsWith("http") ? value : `https://account.xiaomi.com${value}`;
}

function sanitizeFileName(value) {
  return basename(value).replace(/[^a-zA-Z0-9._-]/g, "_") || "voice-pack.pkg";
}

function stringField(body, key) {
  const value = optionalString(body?.[key]);
  if (!value) throw new HttpError(`${key} is required.`, 400);
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function stringValue(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function generateClientId() {
  return Array.from({ length: 16 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
}

function formatTimezone() {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `GMT${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function resetLocalState() {
  sessions.clear();
  jobs.clear();
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

if (process.argv[1] && /server[\\/]index\.mjs$/.test(process.argv[1])) {
  createLocalServer().listen(DEFAULT_PORT, () => {
    console.log(`Dreame local API listening on http://localhost:${DEFAULT_PORT}`);
  });
}

