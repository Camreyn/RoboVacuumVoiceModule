export type LoginRequest = {
  username: string;
  password: string;
  country: string;
  captchaCode?: string;
};

export type LoginResponse =
  | { status: "authenticated" }
  | { status: "captcha_required"; captchaImage: string }
  | { status: "2fa_required"; destination?: string };

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

export type InstallResult = {
  success: boolean;
  jobId: string;
  message: string;
  status?: string;
  fileUrl?: string;
  md5?: string;
  size?: number;
  command?: unknown;
  before?: VoicePropertiesResponse;
  after?: VoicePropertiesResponse;
  result?: unknown;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://localhost:8787").replace(
  /\/$/,
  "",
);

export async function login(requestBody: LoginRequest): Promise<LoginResponse> {
  return request<LoginResponse>("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
}

export async function verifyTwoFactor(code: string): Promise<LoginResponse> {
  return request<LoginResponse>("/api/auth/verify-2fa", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

export async function clearSession(): Promise<void> {
  await request("/api/auth/session", { method: "DELETE" });
}

export async function findDevices(): Promise<DeviceListResponse> {
  return request<DeviceListResponse>("/api/devices");
}

export async function getVoiceProperties(deviceId: string): Promise<VoicePropertiesResponse> {
  return request<VoicePropertiesResponse>(`/api/devices/${encodeURIComponent(deviceId)}/properties`);
}

export async function installVoicePack(deviceId: string, file: File): Promise<InstallResult> {
  const form = new FormData();
  form.set("file", file);

  return request<InstallResult>(`/api/devices/${encodeURIComponent(deviceId)}/voice-pack`, {
    method: "POST",
    body: form,
  });
}

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
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
