import { claimNextEncodingJob, failEncodingJob, hasClaimableEncodingJob } from "./index.js";
import { encodingEnabled } from "./encoding.js";

const CONTAINER_ID = "avtube-480p-encoder";

export function encoderApiUrl(value) {
  if (typeof value !== "string" || !value) {
    throw new Error("ENCODER_API_URL must be configured.");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("ENCODER_API_URL must be an HTTPS origin or path.");
  }
  return url.toString().replace(/\/+$/, "");
}

export async function dispatchNextEncodingJob(env) {
  if (env.VIDEO_ENCODING_ENABLED !== "true") return { dispatched: false, reason: "disabled" };
  if (!env.ENCODER_TOKEN) throw new Error("ENCODER_TOKEN is required when video encoding is enabled.");
  if (!env.AVTUBE_ENCODER) throw new Error("The AVTUBE_ENCODER Durable Object binding is missing.");

  const apiUrl = encoderApiUrl(env.ENCODER_API_URL);
  if (!(await hasClaimableEncodingJob(env))) {
    return { dispatched: false, reason: "queue-empty" };
  }
  const authorization = ["Bearer ", env.ENCODER_TOKEN].join("");
  const container = env.AVTUBE_ENCODER.getByName(CONTAINER_ID);
  const health = await container.fetch(new Request("https://encoder.internal/health", {
    headers: { Authorization: authorization },
  }));
  if (!health.ok) {
    if (health.status === 503) return { dispatched: false, reason: "container-starting" };
    throw new Error(`Encoder container health check failed (${health.status}).`);
  }
  const status = await health.json();
  if (status.busy === true) return { dispatched: false, reason: "container-busy" };

  const job = await claimNextEncodingJob(env, apiUrl);
  if (!job) return { dispatched: false, reason: "queue-empty" };

  try {
    const response = await container.fetch(new Request("https://encoder.internal/jobs", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ job }),
    }));
    if (!response.ok) throw new Error(`Encoder container rejected the job (${response.status}).`);
    return { dispatched: true, reelId: job.reelId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Encoder container dispatch failed.";
    await failEncodingJob(env, apiUrl, job.reelId, message);
    throw error;
  }
}

export function runScheduledEncoderDispatch(env, executionCtx) {
  if (env.VIDEO_ENCODING_ENABLED !== "true") return;
  if (!env.ENCODER_TOKEN) {
    console.error("VIDEO_ENCODING_ENABLED requires the ENCODER_TOKEN secret.");
    return;
  }
  if (!encodingEnabled(env)) return;
  executionCtx.waitUntil(
    dispatchNextEncodingJob(env).catch((error) => {
      console.error(
        "AVTube encoder dispatch failed:",
        error instanceof Error ? error.message : "Unknown dispatch error",
      );
    }),
  );
}
