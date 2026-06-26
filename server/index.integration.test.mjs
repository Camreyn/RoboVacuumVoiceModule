import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalServer, resetLocalState } from "./index.mjs";

const origin = "http://localhost:5173";

beforeEach(() => {
  resetLocalState();
});

afterEach(() => {
  resetLocalState();
  vi.unstubAllEnvs();
});

describe("local Dreame API integration", () => {
  it("returns captcha-required login responses", async () => {
    await withServer(
      {
        clientFactory: () => ({
          login: async () => ({ status: "captcha_required", captchaImage: "data:image/jpeg;base64,abc" }),
        }),
      },
      async ({ baseUrl }) => {
        const response = await postJson(`${baseUrl}/api/auth/login`, {
          username: "user@example.com",
          password: "password",
          country: "us",
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toContain("dvpi_local_session=");
        await expect(response.json()).resolves.toEqual({
          status: "captcha_required",
          captchaImage: "data:image/jpeg;base64,abc",
        });
      },
    );
  });

  it("supports 2FA login completion", async () => {
    const fakeClient = {
      login: vi.fn(async () => ({ status: "2fa_required", destination: "c***@example.com" })),
      verifyCode: vi.fn(async (code) => ({ status: "authenticated", code })),
    };

    await withServer({ clientFactory: () => fakeClient }, async ({ baseUrl }) => {
      const loginResponse = await postJson(`${baseUrl}/api/auth/login`, {
        username: "user@example.com",
        password: "password",
        country: "us",
      });
      const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0] || "";

      const verifyResponse = await postJson(`${baseUrl}/api/auth/verify-2fa`, { code: "123456" }, cookie);

      expect(verifyResponse.status).toBe(200);
      expect(fakeClient.verifyCode).toHaveBeenCalledWith("123456");
      await expect(verifyResponse.json()).resolves.toEqual({ status: "authenticated", code: "123456" });
    });
  });

  it("expires local sessions", async () => {
    const fakeClient = {
      login: async () => ({ status: "authenticated" }),
      getDevices: async () => [],
    };

    await withServer(
      { clientFactory: () => fakeClient, sessionTtlMs: -1 },
      async ({ baseUrl }) => {
        const loginResponse = await postJson(`${baseUrl}/api/auth/login`, {
          username: "user@example.com",
          password: "password",
          country: "us",
        });
        const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0] || "";

        const devicesResponse = await fetch(`${baseUrl}/api/devices`, { headers: { cookie, origin } });

        expect(devicesResponse.status).toBe(401);
        await expect(devicesResponse.json()).resolves.toEqual({ message: "Session is missing or expired." });
      },
    );
  });

  it("prepares voice-pack uploads without sending by default", async () => {
    const fakeClient = {
      login: async () => ({ status: "authenticated" }),
      getVoiceProperties: vi.fn(async () => ({ properties: { voice_packet_id: "en" } })),
      sendVoiceInstallCommand: vi.fn(),
    };

    await withServer(
      {
        clientFactory: () => fakeClient,
        publicFileBaseUrl: "http://192.168.1.50:8787",
      },
      async ({ baseUrl }) => {
        const cookie = await loginCookie(baseUrl);
        const response = await uploadVoicePack(baseUrl, cookie);
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.success).toBe(false);
        expect(payload.status).toBe("prepared");
        expect(payload.md5).toBe("5d41402abc4b2a76b9719d911017c592");
        expect(payload.size).toBe(5);
        expect(payload.fileUrl).toMatch(/^http:\/\/192\.168\.1\.50:8787\/packs\//);
        expect(payload.command).toEqual(
          expect.objectContaining({
            url: payload.fileUrl,
            md5: payload.md5,
            size: payload.size,
            name: "voice.pkg",
          }),
        );
        expect(fakeClient.sendVoiceInstallCommand).not.toHaveBeenCalled();
      },
    );
  });

  it("sends the voice command only when send mode is enabled", async () => {
    const fakeClient = {
      login: async () => ({ status: "authenticated" }),
      getVoiceProperties: vi.fn(async () => ({ properties: { voice_change_status: "ready" } })),
      sendVoiceInstallCommand: vi.fn(async () => [{ code: 0 }]),
    };

    await withServer(
      {
        clientFactory: () => fakeClient,
        publicFileBaseUrl: "http://192.168.1.50:8787",
        voiceInstallMode: "send",
      },
      async ({ baseUrl }) => {
        const cookie = await loginCookie(baseUrl);
        const response = await uploadVoicePack(baseUrl, cookie);
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.status).toBe("sent");
        expect(payload.result).toEqual([{ code: 0 }]);
        expect(fakeClient.sendVoiceInstallCommand).toHaveBeenCalledTimes(1);
        expect(fakeClient.sendVoiceInstallCommand).toHaveBeenCalledWith(
          "107265",
          expect.objectContaining({ md5: "5d41402abc4b2a76b9719d911017c592", fileName: "voice.pkg" }),
        );
      },
    );
  });
});

async function withServer(options, callback) {
  const server = createLocalServer({ allowedOrigin: origin, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await callback({ baseUrl });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function loginCookie(baseUrl) {
  const response = await postJson(`${baseUrl}/api/auth/login`, {
    username: "user@example.com",
    password: "password",
    country: "us",
  });
  return response.headers.get("set-cookie")?.split(";")[0] || "";
}

function postJson(url, body, cookie = "") {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin,
    },
    body: JSON.stringify(body),
  });
}

function uploadVoicePack(baseUrl, cookie) {
  const form = new FormData();
  form.set("file", new File(["hello"], "voice.pkg"));
  return fetch(`${baseUrl}/api/devices/107265/voice-pack`, {
    method: "POST",
    headers: { cookie, origin },
    body: form,
  });
}