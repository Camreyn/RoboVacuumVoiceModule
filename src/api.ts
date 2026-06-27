export type LoginRequest = {
  username: string;
  password: string;
  country: string;
  captchaCode?: string;
};

export type LoginResponse = (
  | { status: "authenticated" }
  | { status: "captcha_required"; captchaImage: string }
  | { status: "2fa_required"; destination?: string }
) & { sessionId?: string };

export type ApiError = {
  message: string;
};

export type DeviceSummary = {
  id: string;
  app: string;
  name?: string;
  model?: string;
  localIp?: string;
  source?: string;
};

export type DeviceListResponse = {
  devices: DeviceSummary[];
  message?: string;
};

export type VoicePropertiesResponse = {
  raw?: unknown;
  properties?: {
    voice_packet_id?: unknown;
    voice_change_status?: unknown;
    voice_change?: unknown;
  };
  message?: string;
};

export type VoiceJobDiagnostics = {
  mode?: "discover" | "send";
  publicFileBaseUrl?: string;
  detectedLanIp?: string | null;
  requestHost?: string | null;
  fileUrl?: string;
  robotFetchMethod?: string;
  readProperties?: Array<{ did: string; siid: number; piid: number; name: string }>;
  candidateWrite?: { method: string; siid: number; piid: number; valueType: string };
};

export type InstallResult = {
  success: boolean;
  jobId: string;
  message: string;
  status?: string;
  fileUrl?: string;
  md5?: string;
  size?: number;
  command?: unknown;
  diagnostics?: VoiceJobDiagnostics;
  before?: VoicePropertiesResponse;
  after?: VoicePropertiesResponse;
  result?: unknown;
};

const API_BASE_STORAGE_KEY = "dreame-api-base-url";
const SESSION_STORAGE_KEY = "dreame-local-session";
const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

function normalizeApiBaseUrl(value: string): string {
  return value.trim().replace(/\/$/, "");
}

export function getApiBaseUrl(): string {
  const queryApiBase = new URLSearchParams(window.location.search).get("apiBase");
  if (queryApiBase) {
    const normalized = normalizeApiBaseUrl(queryApiBase);
    window.localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
    return normalized;
  }
  return normalizeApiBaseUrl(window.localStorage.getItem(API_BASE_STORAGE_KEY) || DEFAULT_API_BASE);
}

export function setApiBaseUrl(value: string): string {
  const normalized = normalizeApiBaseUrl(value);
  if (normalized) {
    window.localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
    return normalized;
  }
  window.localStorage.removeItem(API_BASE_STORAGE_KEY);
  return normalizeApiBaseUrl(DEFAULT_API_BASE);
}

export function getLocalSessionId(): string {
  return window.localStorage.getItem(SESSION_STORAGE_KEY) || "";
}

function setLocalSessionId(value?: string) {
  if (value) window.localStorage.setItem(SESSION_STORAGE_KEY, value);
}

function clearLocalSessionId() {
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

export async function login(requestBody: LoginRequest): Promise<LoginResponse> {
  const response = await request<LoginResponse>("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  setLocalSessionId(response.sessionId);
  return response;
}

export async function verifyTwoFactor(code: string): Promise<LoginResponse> {
  const response = await request<LoginResponse>("/api/auth/verify-2fa", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  setLocalSessionId(response.sessionId);
  return response;
}

export async function clearSession(): Promise<void> {
  try {
    await request("/api/auth/session", { method: "DELETE" });
  } finally {
    clearLocalSessionId();
  }
}

export async function findDevices(): Promise<DeviceListResponse> {
  return request<DeviceListResponse>("/api/devices");
}

export async function getVoiceProperties(deviceId: string): Promise<VoicePropertiesResponse> {
  return request<VoicePropertiesResponse>(`/api/devices/${encodeURIComponent(deviceId)}/properties`);
}

export async function installVoicePack(deviceId: string, file: File, options: { send?: boolean } = {}): Promise<InstallResult> {
  const form = new FormData();
  form.set("file", file);
  if (options.send) form.set("mode", "send");

  return request<InstallResult>(`/api/devices/${encodeURIComponent(deviceId)}/voice-pack`, {
    method: "POST",
    body: form,
  });
}

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  const sessionId = getLocalSessionId();
  if (sessionId) headers.set("x-local-session", sessionId);

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });

  const text = await response.text();
  const data = text ? parseJson(text) : null;

  if (!response.ok) {
    const message =
      typeof data === "object" && data && "message" in data
        ? String((data as ApiError).message)
        : `Request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return data as T;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
