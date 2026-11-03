import { DurableObject } from "cloudflare:workers";

import worker from "./index.js";
import { runScheduledEncoderDispatch } from "./bridge.js";
import { tokensEqual } from "./encoding.js";

const CONTAINER_PORT = 8080;
const STARTUP_RETRY_MS = 60_000;

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

async function forwardToContainer(container, request) {
  const url = new URL(request.url);
  url.protocol = "http:";
  url.host = "container";
  const forwarded = new Request(url, request);
  forwarded.headers.delete("host");
  return container.getTcpPort(CONTAINER_PORT).fetch(forwarded);
}

export class AvTubeEncoderContainer extends DurableObject {
  async fetch(request) {
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/, "") ?? "";
    if (!this.env.ENCODER_TOKEN || !(await tokensEqual(token, this.env.ENCODER_TOKEN))) {
      return jsonResponse({ ok: false, error: "Encoder authorization failed." }, 401);
    }

    const url = new URL(request.url);
    if (
      (url.pathname !== "/health" || request.method !== "GET") &&
      (url.pathname !== "/jobs" || request.method !== "POST")
    ) {
      return jsonResponse({ ok: false, error: "Not found." }, 404);
    }
    const container = this.ctx.container;
    if (!container) {
      console.error("AVTube encoder Container binding is unavailable.");
      return jsonResponse({ ok: false, error: "Encoder service is unavailable." }, 503);
    }

    try {
      if (!container.running) {
        container.start({
          env: {
            ENCODER_API_URL: this.env.ENCODER_API_URL,
            ENCODER_TOKEN: this.env.ENCODER_TOKEN,
          },
          enableInternet: true,
        });
      }
      await container.setInactivityTimeout(45 * 60 * 1000);
      const response = await forwardToContainer(container, request);
      if (request.method === "GET" && !response.ok) {
        return jsonResponse(
          { ok: false, error: "Encoder service is starting." },
          503,
          { "Retry-After": "60" },
        );
      }
      return response;
    } catch (error) {
      console.error(
        "AVTube encoder Container is not ready:",
        error instanceof Error ? error.message : "Unknown startup error",
      );
      return jsonResponse(
        { ok: false, error: "Encoder service is starting." },
        503,
        { "Retry-After": String(STARTUP_RETRY_MS / 1000) },
      );
    }
  }
}

export default {
  fetch(request, env) {
    return worker.fetch(request, env);
  },
  scheduled(_event, env, executionCtx) {
    runScheduledEncoderDispatch(env, executionCtx);
  },
};
