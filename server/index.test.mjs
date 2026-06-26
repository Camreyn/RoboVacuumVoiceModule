import { describe, expect, it } from "vitest";
import {
  arc4,
  createVoiceInstallPayload,
  generateEncParams,
  hashDreamePassword,
  makeDreameRlc,
  normalizeDevice,
  normalizeDreameRegion,
  regionForCountry,
} from "./index.mjs";

describe("local Dreame API helpers", () => {
  it("builds Dreamehome auth crypto fields", () => {
    expect(hashDreamePassword("password")).toBe("584f291aa7759cb88f281bcafab1c5ba");
    expect(makeDreameRlc("us", "en", "GB")).toBe("JUC3ZcGzvVewBA2Uu593LA==");
    expect(normalizeDreameRegion("USA")).toBe("us");
    expect(regionForCountry("CN", "eu")).toBe("cn");
  });
  it("normalizes Dreame vacuum records and redacts device tokens", () => {
    expect(
      normalizeDevice({
        did: 107265,
        name: "Kitchen X40",
        model: "dreame.vacuum.r2243",
        localip: "192.168.1.24",
        token: "secret",
      }),
    ).toEqual({
      id: "107265",
      app: "dreamehome",
      name: "Kitchen X40",
      model: "dreame.vacuum.r2243",
      localIp: "192.168.1.24",
      token: "[redacted]",
      source: "dreame-cloud",
    });
  });

  it("ignores non-vacuum device records", () => {
    expect(normalizeDevice({ did: 1, model: "xiaomi.light.v1" })).toBeNull();
  });

  it("builds the candidate X40 voice install payload", () => {
    expect(
      createVoiceInstallPayload({
        url: "http://192.168.1.10:8787/packs/abc/voice.pkg",
        md5: "900150983cd24fb0d6963f7d28e17f72",
        size: 123,
        fileName: "voice.pkg",
      }),
    ).toEqual({
      id: "custom",
      lang_id: "custom",
      url: "http://192.168.1.10:8787/packs/abc/voice.pkg",
      md5: "900150983cd24fb0d6963f7d28e17f72",
      size: 123,
      name: "voice.pkg",
    });
  });

  it("uses symmetric RC4 transform with the Xiaomi 1024-byte drop", () => {
    const key = Buffer.from("test-key");
    const payload = Buffer.from("voice payload");
    const encrypted = arc4(key, payload);
    expect(encrypted.equals(payload)).toBe(false);
    expect(arc4(key, encrypted).toString("utf8")).toBe("voice payload");
  });

  it("generates encrypted Xiaomi API form fields", () => {
    const fields = generateEncParams(
      "https://us.api.io.mi.com/app/v2/home/rpc/107265",
      "POST",
      { data: JSON.stringify({ method: "get_properties", params: [] }) },
      Buffer.from("security").toString("base64"),
    );

    expect(fields).toEqual(
      expect.objectContaining({
        data: expect.any(String),
        rc4_hash__: expect.any(String),
        signature: expect.any(String),
        ssecurity: Buffer.from("security").toString("base64"),
        _nonce: expect.any(String),
      }),
    );
    expect(fields.data).not.toContain("get_properties");
  });
});
