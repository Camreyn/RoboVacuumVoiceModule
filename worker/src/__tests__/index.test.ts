import { describe, expect, it } from "vitest";
import worker, { Env } from "../index";

const env: Env = {
  ALLOWED_ORIGIN: "http://localhost:5173",
};

describe("retired worker API", () => {
  it("responds with the local-only migration message", async () => {
    const response = await worker.fetch(
      new Request("https://worker.test/api/devices", {
        headers: { origin: "http://localhost:5173" },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(410);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    await expect(response.json()).resolves.toEqual({
      message:
        "The Cloudflare Worker API has been retired. Run `npm run api:dev` locally so Dreame credentials stay on this machine.",
    });
  });

  it("handles CORS preflight", async () => {
    const response = await worker.fetch(
      new Request("https://worker.test/api/devices", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173" },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(204);
  });
});
