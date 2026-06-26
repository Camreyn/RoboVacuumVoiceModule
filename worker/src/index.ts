export interface Env {
  ALLOWED_ORIGIN?: string;
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request, env);
    }

    return withCors(
      json(
        {
          message:
            "The Cloudflare Worker API has been retired. Run `npm run api:dev` locally so Dreame credentials stay on this machine.",
        },
        410,
      ),
      request,
      env,
    );
  },
};

export default worker;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get("origin");
  const allowedOrigin = env.ALLOWED_ORIGIN || "http://localhost:5173";
  const corsOrigin = origin === allowedOrigin ? origin : allowedOrigin;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", corsOrigin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
