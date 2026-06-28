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

  it("allows built frontend localhost origins on alternate ports", async () => {
    await withServer(
      {
        clientFactory: () => ({ login: async () => ({ status: "authenticated" }) }),
      },
      async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/devices`, {
          headers: { origin: "http://localhost:5175" },
        });

        expect(response.status).toBe(401);
        expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5175");
      },
    );
  });
  it("allows GitHub Pages origins and header sessions", async () => {
    const fakeClient = {
      login: async () => ({ status: "authenticated" }),
      getDevices: async () => [{ did: "107265", model: "dreame.vacuum.r2243", name: "X40" }],
    };

    await withServer({ clientFactory: () => fakeClient }, async ({ baseUrl }) => {
      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://camreyn.github.io",
        },
        body: JSON.stringify({ username: "user@example.com", password: "password", country: "us" }),
      });
      const loginPayload = await loginResponse.json();

      const devicesResponse = await fetch(`${baseUrl}/api/devices`, {
        headers: {
          origin: "https://camreyn.github.io",
          "x-local-session": loginPayload.sessionId,
        },
      });

      expect(loginResponse.headers.get("access-control-allow-origin")).toBe("https://camreyn.github.io");
      expect(loginResponse.headers.get("access-control-allow-headers")).toContain("x-local-session");
      expect(devicesResponse.status).toBe(200);
      await expect(devicesResponse.json()).resolves.toEqual({
        devices: [expect.objectContaining({ id: "107265", name: "X40" })],
      });
    });
  });
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
        await expect(response.json()).resolves.toEqual(
          expect.objectContaining({
            status: "captcha_required",
            captchaImage: "data:image/jpeg;base64,abc",
            sessionId: expect.any(String),
          }),
        );
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
      await expect(verifyResponse.json()).resolves.toEqual(
        expect.objectContaining({ status: "authenticated", code: "123456", sessionId: expect.any(String) }),
      );
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

  it("sends voice test action commands", async () => {
    const fakeClient = {
      login: async () => ({ status: "authenticated" }),
      sendVoiceTestAction: vi.fn(async (deviceId, action) => ({
        action,
        label: "Return to dock",
        command: { did: deviceId, siid: 3, aiid: 1 },
        raw: [{ code: 0 }],
      })),
    };

    await withServer({ clientFactory: () => fakeClient }, async ({ baseUrl }) => {
      const cookie = await loginCookie(baseUrl);
      const response = await postJson(`${baseUrl}/api/devices/107265/voice-test`, { action: "charge" }, cookie);
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(fakeClient.sendVoiceTestAction).toHaveBeenCalledWith("107265", "charge");
      expect(payload).toEqual(
        expect.objectContaining({
          action: "charge",
          label: "Return to dock",
          command: { did: "107265", siid: 3, aiid: 1 },
        }),
      );
    });
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
        expect(payload.diagnostics).toEqual(
          expect.objectContaining({
            mode: "discover",
            publicFileBaseUrl: "http://192.168.1.50:8787",
            fileUrl: payload.fileUrl,
            robotFetchMethod: "GET",
            candidateWrite: { method: "set_properties", siid: 7, piid: 4, valueType: "json-string" },
          }),
        );
        expect(payload.diagnostics.readProperties).toHaveLength(3);
        expect(fakeClient.sendVoiceInstallCommand).not.toHaveBeenCalled();
      },
    );
  });


  it("unwraps zipped test artifacts before creating the Dreame install command", async () => {
    const fakeClient = {
      login: async () => ({ status: "authenticated" }),
      getVoiceProperties: vi.fn(async () => ({ properties: { voice_packet_id: "old-custom" } })),
      sendVoiceInstallCommand: vi.fn(),
    };
    const innerBytes = Buffer.from("inner voice archive");
    const zipBytes = makeStoredZip("brad-x40.tar.gz", innerBytes);

    await withServer(
      {
        clientFactory: () => fakeClient,
        publicFileBaseUrl: "http://192.168.1.50:8787",
      },
      async ({ baseUrl }) => {
        const cookie = await loginCookie(baseUrl);
        const response = await uploadVoicePack(baseUrl, cookie, { file: new File([zipBytes], "brad-x40-test.zip") });
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.fileName).toBe("brad-x40.tar.gz");
        expect(payload.size).toBe(innerBytes.length);
        expect(payload.md5).toBe("38d336fccb77bf7d6179efd7bf98c45e");
        expect(payload.fileUrl).toMatch(/brad-x40\.tar\.gz$/);
        expect(payload.diagnostics.unwrappedFrom).toBe("brad-x40-test.zip");
        expect(payload.command).toEqual(expect.objectContaining({ name: "brad-x40.tar.gz", size: innerBytes.length }));

        const served = await fetch(payload.fileUrl.replace("http://192.168.1.50:8787", baseUrl));
        expect(Buffer.from(await served.arrayBuffer()).equals(innerBytes)).toBe(true);
      },
    );
  });
  it("sends the voice command when explicitly requested by upload form", async () => {
    const fakeClient = {
      login: async () => ({ status: "authenticated" }),
      getVoiceProperties: vi.fn(async () => ({ properties: { voice_change_status: "ready" } })),
      sendVoiceInstallCommand: vi.fn(async () => [{ code: 0 }]),
    };

    await withServer(
      {
        clientFactory: () => fakeClient,
        publicFileBaseUrl: "http://192.168.1.50:8787",
      },
      async ({ baseUrl }) => {
        const cookie = await loginCookie(baseUrl);
        const response = await uploadVoicePack(baseUrl, cookie, { send: true });
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.status).toBe("sent");
        expect(payload.diagnostics.mode).toBe("send");
        expect(fakeClient.sendVoiceInstallCommand).toHaveBeenCalledTimes(1);
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

function uploadVoicePack(baseUrl, cookie, options = {}) {
  const form = new FormData();
  form.set("file", options.file || new File(["hello"], "voice.pkg"));
  if (options.send) form.set("mode", "send");
  return fetch(baseUrl + "/api/devices/107265/voice-pack", {
    method: "POST",
    headers: { cookie, origin },
    body: form,
  });
}

function makeStoredZip(fileName, payload) {
  const name = Buffer.from(fileName);
  const data = Buffer.from(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + name.length + data.length;
  const centralSize = central.length + name.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, name, data, central, name, eocd]);
}
