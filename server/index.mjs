import { createHash, randomBytes } from "node:crypto";
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
    this.country = country;
    this.clientId = generateClientId();
    this.cookieJar = new CookieJar();
    this.userAgent = `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${this.clientId} APP/xiaomi.smarthome APPV/62830`;
    this.locale = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
    this.timezone = formatTimezone();
    this.sign = null;
    this.ssecurity = null;
    this.userId = null;
    this.serviceToken = null;
    this.location = null;
    this.verificationUrl = null;
    this.verificationDest = null;
    this.captchaIck = null;
    this.captchaImage = null;
  }

  async login({ captchaCode } = {}) {
    if (!(await this.loginStep1())) throw new HttpError("Unable to start Dreame/Xiaomi login.", 502);
    const step2 = await this.loginStep2({ captchaCode });
    if (step2.status !== "continue") return step2;
    await this.loginStep3();
    return { status: "authenticated" };
  }

  async loginStep1() {
    const response = await this.fetchWithCookies(
      "https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true",
      { headers: this.loginHeaders() },
    );
    if (!response.ok) return false;
    const data = parseXiaomiJson(await response.text());
    this.sign = data._sign || this.sign;
    this.userId = data.userId || this.userId;
    this.ssecurity = data.ssecurity || this.ssecurity;
    this.location = data.location || this.location;
    return true;
  }

  async loginStep2({ captchaCode } = {}) {
    const data = new URLSearchParams({
      user: this.username,
      hash: createHash("md5").update(this.password).digest("hex").toUpperCase(),
      callback: "https://sts.api.io.mi.com/sts",
      sid: "xiaomiio",
      qs: "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
      _sign: this.sign || "",
    });

    const url = new URL("https://account.xiaomi.com/pass/serviceLoginAuth2");
    url.searchParams.set("_json", "true");
    const cookies = {};
    if (captchaCode && this.captchaIck) {
      data.set("captCode", captchaCode);
      url.searchParams.set("_dc", String(Date.now()));
      cookies.ick = this.captchaIck;
    }

    const response = await this.fetchWithCookies(url, { method: "POST", headers: this.loginHeaders(), body: data, cookies });
    if (!response.ok) throw new HttpError("Dreame/Xiaomi login request failed.", 502);
    const payload = parseXiaomiJson(await response.text());

    if (payload.location) {
      this.userId = payload.userId || this.userId;
      this.ssecurity = payload.ssecurity || this.ssecurity;
      this.location = payload.location;
      return { status: "continue" };
    }

    if (payload.notificationUrl) {
      const sent = await this.send2faCode(absoluteAccountUrl(payload.notificationUrl));
      if (!sent) throw new HttpError("Dreame/Xiaomi requires 2FA, but the code could not be sent.", 401);
      return { status: "2fa_required", destination: this.verificationDest };
    }

    if (payload.captchaUrl) {
      await this.loadCaptcha(absoluteAccountUrl(payload.captchaUrl));
      return { status: "captcha_required", captchaImage: this.captchaImage };
    }

    throw new HttpError(payload.desc || payload.description || "Dreame/Xiaomi login failed.", 401);
  }

  async loginStep3() {
    if (!this.location) throw new HttpError("Dreame/Xiaomi login did not return a token location.", 401);
    const response = await this.fetchWithCookies(this.location, { headers: this.loginHeaders() });
    if (!response.ok || !this.cookieJar.get("serviceToken")) {
      throw new HttpError("Dreame/Xiaomi service token was not returned.", 401);
    }
    this.serviceToken = this.cookieJar.get("serviceToken");
    return true;
  }

  async loadCaptcha(url) {
    const response = await this.fetchWithCookies(url, { headers: { "User-Agent": this.userAgent } });
    this.captchaIck = this.cookieJar.get("ick");
    const bytes = Buffer.from(await response.arrayBuffer());
    this.captchaImage = `data:${response.headers.get("content-type") || "image/jpeg"};base64,${bytes.toString("base64")}`;
  }

  async send2faCode(verificationUrl) {
    this.verificationUrl = verificationUrl;
    await this.fetchWithCookies(verificationUrl, { headers: { "User-Agent": this.userAgent } });
    const context = new URL(verificationUrl).searchParams.get("context");
    if (!context) return false;

    const identity = await this.fetchWithCookies(
      `https://account.xiaomi.com/identity/list?sid=xiaomiio&context=${encodeURIComponent(context)}&_locale=${encodeURIComponent(this.locale)}`,
    );
    const identityData = parseXiaomiJson(await identity.text());
    const identitySession = this.cookieJar.get("identity_session");
    if (!identity.ok || !identitySession) return false;

    const flag = identityData.options?.includes(4) ? 4 : identityData.options?.includes(8) ? 8 : identityData.flag || 4;
    const kind = flag === 4 ? "Phone" : "Email";
    const verify = await this.fetchWithCookies(
      `https://account.xiaomi.com/identity/auth/verify${kind}?_flag=${flag}&_json=true&sid=xiaomiio&context=${encodeURIComponent(context)}&mask=0&_locale=${encodeURIComponent(this.locale)}`,
    );
    const verifyData = parseXiaomiJson(await verify.text());
    this.verificationDest = verifyData.maskedPhone || verifyData.maskedEmail || "masked destination";

    const send = await this.fetchWithCookies(
      `https://account.xiaomi.com/identity/auth/send${kind}Ticket?_dc=${Date.now()}&sid=xiaomiio&context=${encodeURIComponent(context)}&mask=0&_locale=${encodeURIComponent(this.locale)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ retry: "0", icode: "", _json: "true", ick: this.cookieJar.get("ick") || "" }),
      },
    );
    const sendData = parseXiaomiJson(await send.text());
    return send.ok && sendData.code === 0;
  }

  async verifyCode(code) {
    if (!this.verificationUrl) throw new HttpError("No pending 2FA challenge is active.", 400);
    const context = new URL(this.verificationUrl).searchParams.get("context");
    if (!context) throw new HttpError("2FA challenge is missing context.", 400);

    const identity = await this.fetchWithCookies(
      `https://account.xiaomi.com/identity/list?sid=xiaomiio&context=${encodeURIComponent(context)}&_locale=${encodeURIComponent(this.locale)}`,
    );
    const identityData = parseXiaomiJson(await identity.text());
    const flag = identityData.options?.includes(4) ? 4 : identityData.options?.includes(8) ? 8 : identityData.flag || 4;
    const kind = flag === 4 ? "Phone" : "Email";
    const response = await this.fetchWithCookies(
      `https://account.xiaomi.com/identity/auth/verify${kind}?_flag=${flag}&_json=true&sid=xiaomiio&context=${encodeURIComponent(context)}&mask=0&_locale=${encodeURIComponent(this.locale)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _flag: String(flag), ticket: code, trust: "false", _json: "true", ick: this.cookieJar.get("ick") || "" }),
      },
    );
    const data = parseXiaomiJson(await response.text());
    const location = data.location || response.headers.get("location");
    if (!response.ok || data.code !== 0 || !location) {
      throw new HttpError(data.description || data.message || "2FA verification failed.", 401);
    }
    this.location = location;
    await this.loginStep3();
    return { status: "authenticated" };
  }

  async getDevices() {
    const home = await this.apiCall("v2/homeroom/gethome", {
      fg: true,
      fetch_share: true,
      fetch_share_dev: true,
      limit: 100,
      app_ver: 7,
    });
    const devices = [];
    const homes = new Map();
    for (const item of home?.result?.homelist || []) homes.set(String(item.id), this.userId);
    for (const [homeId, homeOwner] of homes) {
      const response = await this.apiCall("v2/home/home_device_list", {
        home_id: Number(homeId),
        home_owner: homeOwner,
        limit: 100,
        get_split_device: true,
        support_smart_home: true,
      });
      devices.push(...(response?.result?.device_info || []));
    }
    const fallback = await this.apiCall("home/device_list", { getVirtualModel: false, getHuamiDevices: 0 });
    devices.push(...(fallback?.result?.list || []));
    return dedupeDevices(devices);
  }

  async getVoiceProperties(deviceId) {
    const result = await this.send(deviceId, "get_properties", VOICE_PROPERTIES);
    return { raw: result, properties: mapVoiceProperties(result) };
  }

  async sendVoiceInstallCommand(deviceId, fileRecord) {
    const payload = createVoiceInstallPayload(fileRecord);
    return this.send(deviceId, "set_properties", [
      { did: "7.4", siid: 7, piid: 4, value: JSON.stringify(payload) },
    ]);
  }

  async send(deviceId, method, params) {
    const response = await this.apiCall(`v2/home/rpc/${deviceId}`, { method, params });
    if (!response || !("result" in response)) throw new HttpError(`Dreame RPC ${method} did not return a result.`, 502);
    return response.result;
  }

  async apiCall(path, params) {
    if (!this.serviceToken || !this.ssecurity) throw new HttpError("Dreame session is not authenticated.", 401);
    const url = `${this.apiBaseUrl()}/${path}`;
    const fields = generateEncParams(url, "POST", { data: JSON.stringify(params) }, this.ssecurity);
    const response = await this.fetchWithCookies(url, {
      method: "POST",
      headers: {
        "User-Agent": this.userAgent,
        "Accept-Encoding": "identity",
        "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
        "Content-Type": "application/x-www-form-urlencoded",
        "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4",
      },
      cookies: {
        userId: String(this.userId),
        yetAnotherServiceToken: this.serviceToken,
        serviceToken: this.serviceToken,
        locale: this.locale,
        timezone: this.timezone,
        is_daylight: "0",
        dst_offset: "0",
        channel: "MI_APP_STORE",
      },
      body: new URLSearchParams(fields),
    });
    const encrypted = await response.text();
    if (!response.ok) throw new HttpError(`Dreame API request failed with HTTP ${response.status}.`, 502);
    const decoded = decryptRc4(signedNonce(fields._nonce, this.ssecurity), encrypted);
    return JSON.parse(decoded);
  }

  apiBaseUrl() {
    return `https://${this.country === "cn" ? "" : `${this.country}.`}api.io.mi.com/app`;
  }

  loginHeaders() {
    return { "User-Agent": this.userAgent, "Content-Type": "application/x-www-form-urlencoded" };
  }

  async fetchWithCookies(url, init = {}) {
    const headers = new Headers(init.headers || {});
    const cookie = this.cookieJar.header(init.cookies);
    if (cookie) headers.set("Cookie", cookie);
    const response = await fetch(url, { ...init, headers });
    this.cookieJar.store(response.headers);
    return response;
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
  if (!id || !model || !model.includes("vacuum")) return null;
  return {
    id,
    app: "dreamehome",
    name: stringValue(device.name) || stringValue(device.device_name) || model,
    model,
    localIp: stringValue(device.localip),
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
  res.setHeader("Access-Control-Allow-Origin", origin === allowedOrigin ? origin : allowedOrigin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Vary", "Origin");
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

