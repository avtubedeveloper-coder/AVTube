// Reel encoding control plane + playback delivery. The Worker never transcodes (it cannot run FFmpeg):
// it queues Reels, hands jobs to an external encoder service (workers/video-encoder) that holds
// only ENCODER_TOKEN, mints presigned PUT URLs for the encoder's output, verifies the output exists
// in R2 before marking a Reel ready, and serves the single 480p MP4 (with Range support).

export const MAX_ENCODING_ATTEMPTS = 3;
export const LEASE_MS = 30 * 60 * 1000;
const MAX_UPLOAD_FILES = 100;
export const PLAYBACK_QUALITY = 480;
export const PLAYBACK_FILE = `${PLAYBACK_QUALITY}p.mp4`;
const ID = /^[A-Za-z0-9_-]{8,100}$/;

export function encodingEnabled(env) {
  return env.VIDEO_ENCODING_ENABLED === "true" && Boolean(env.ENCODER_TOKEN);
}

/** Fields added to a newly published public Reel when the encoder pipeline is enabled. */
export function queuedFields(originalAsset, now) {
  return {
    encodingStatus: "processing",
    encodingQueuedAt: now,
    ...(Number.isSafeInteger(originalAsset?.size) && originalAsset.size > 0
      ? { originalFileSize: originalAsset.size }
      : {}),
  };
}

export function isValidOutputPath(path) {
  return path === PLAYBACK_FILE || path === "poster.jpg";
}

export function outputContentType(path) {
  if (path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".jpg")) return "image/jpeg";
  return "application/octet-stream";
}

export function outputObjectKey(ownerUid, reelId, path) {
  return `users/${ownerUid}/reels/${reelId}/${path}`;
}

export function playbackUrl(origin, reelId) {
  return `${origin.replace(/\/+$/, "")}/v1/r2/playback/${reelId}/${PLAYBACK_FILE}`;
}

/** Constant-time token comparison (both sides hashed to equal length first). */
export async function tokensEqual(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !expected) return false;
  const digest = async (value) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function pickClaimable(records, now) {
  const rows = Object.entries(records ?? {})
    .filter(([, record]) =>
      record &&
      record.encodingStatus === "processing" &&
      record.mediaType === "reel" &&
      record.visibility === "public" &&
      !(Number(record.encodingLeaseUntil) > now) &&
      (Number(record.encodingAttempts) || 0) < MAX_ENCODING_ATTEMPTS &&
      Array.isArray(record.assets) &&
      record.assets.some((asset) => asset?.purpose === "original" && typeof asset.objectKey === "string"))
    .sort((a, b) => (a[1].createdAt ?? 0) - (b[1].createdAt ?? 0));
  return rows.length ? { id: rows[0][0], record: rows[0][1] } : null;
}

/** Attempts are counted when a job is claimed, so a crashed encoder cannot retry forever. */
export function nextFailureState(record, message, now) {
  const attempts = Number(record?.encodingAttempts) || 0;
  const safe = String(message ?? "Encoding failed.")
    .replace(/https?:\/\/\S+/g, "[url]")
    .slice(0, 200);
  if (attempts < MAX_ENCODING_ATTEMPTS) {
    // Stay in "processing" and back off before the next claim.
    return { encodingLeaseUntil: now + 2 * 60 * 1000 * Math.max(1, attempts) };
  }
  return {
    encodingStatus: "failed",
    encodingError: safe,
    encodingLeaseUntil: null,
  };
}

const positiveInt = (value, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value > 0 && value <= max;

export function validateCompleteResult(result) {
  if (!result || typeof result !== "object") return null;
  const qualities = Array.isArray(result.qualities) ? result.qualities : [];
  if (
    qualities.length === 0 ||
    qualities.length > 6 ||
    qualities.length !== 1 ||
    qualities[0] !== PLAYBACK_QUALITY ||
    new Set(qualities).size !== qualities.length ||
    !positiveInt(result.width, 8192) ||
    !positiveInt(result.height, 8192) ||
    Math.min(result.width, result.height) > PLAYBACK_QUALITY ||
    !positiveInt(result.durationMs, 24 * 60 * 60 * 1000) ||
    !positiveInt(result.encodedFileSize)
  ) return null;
  return {
    qualities: [...qualities].sort((a, b) => a - b),
    width: result.width,
    height: result.height,
    durationMs: result.durationMs,
    encodedFileSize: result.encodedFileSize,
    ...(positiveInt(result.originalFileSize) ? { originalFileSize: result.originalFileSize } : {}),
  };
}

/** compressionRatio = 1 - encoded/original, only when both are real measured sizes. */
export function compressionRatio(originalFileSize, encodedFileSize) {
  if (!(originalFileSize > 0) || !(encodedFileSize > 0)) return undefined;
  return Math.round((1 - encodedFileSize / originalFileSize) * 10000) / 10000;
}

export function readyFields({ result, record, origin, now, posterExists }) {
  const originalFileSize = record.originalFileSize ?? result.originalFileSize;
  const ratio = compressionRatio(originalFileSize, result.encodedFileSize);
  return {
    encodingStatus: "ready",
    playbackUrl: playbackUrl(origin, record.id),
    playbackQuality: PLAYBACK_QUALITY,
    availableQualities: result.qualities,
    width: result.width,
    height: result.height,
    durationMs: record.durationMs ?? result.durationMs,
    encodedFileSize: result.encodedFileSize,
    ...(originalFileSize ? { originalFileSize } : {}),
    ...(ratio === undefined ? {} : { compressionRatio: ratio }),
    encodedAt: now,
    encodingError: null,
    encodingLeaseUntil: null,
    ...(posterExists && !record.thumbnailUrl ? { posterUrl: `${origin.replace(/\/+$/, "")}/v1/r2/playback/${record.id}/poster.jpg` } : {}),
  };
}

function publicOrigin(env, request) {
  return env.PUBLIC_MEDIA_ORIGIN || new URL(request.url).origin;
}

async function requireEncoder(request, env, deps) {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!env.ENCODER_TOKEN || !(await tokensEqual(token, env.ENCODER_TOKEN))) {
    throw new deps.HttpError(401, "Encoder authorization failed.");
  }
}

async function loadProcessingReel(env, deps, reelId) {
  if (!ID.test(String(reelId))) throw new deps.HttpError(400, "Invalid Reel ID.");
  const record = await deps.databaseRequest(env, `publicVideos/${reelId}`);
  if (!record || record.encodingStatus !== "processing" || record.mediaType !== "reel") {
    throw new deps.HttpError(409, "This Reel is not awaiting encoding.");
  }
  return { ...record, id: reelId };
}

async function writeBoth(env, deps, record, fields) {
  const updates = {};
  for (const [key, value] of Object.entries(fields)) {
    updates[`publicVideos/${record.id}/${key}`] = value;
    updates[`mediaReels/${record.ownerUid}/${record.id}/${key}`] = value;
  }
  await deps.databaseRequest(env, "", "PATCH", updates);
}

export async function handleEncoderRequest(pathname, request, env, deps) {
  await requireEncoder(request, env, deps);
  const body = await deps.requestJson(request);
  const now = Date.now();

  if (pathname === "/v1/encoder/claim") {
    const records = await deps.databaseRequest(env, "publicVideos", "GET", undefined, {
      orderBy: '"encodingStatus"',
      equalTo: '"processing"',
      limitToFirst: "20",
    });
    // Several candidates are tried so losing a claim race to another encoder never stalls the queue.
    let candidates = records;
    for (let i = 0; i < 5; i += 1) {
      const picked = pickClaimable(candidates, now);
      if (!picked) break;
      // Compare-and-set on the lease: only one encoder can win a given Reel.
      if (await deps.claimLease(env, picked.id, now, now + LEASE_MS)) {
        const attempts = (Number(picked.record.encodingAttempts) || 0) + 1;
        await deps.databaseRequest(env, `publicVideos/${picked.id}/encodingAttempts`, "PUT", attempts);
        const original = picked.record.assets.find((a) => a.purpose === "original");
        return deps.jsonResponse({
          ok: true,
          job: {
            reelId: picked.id,
            original: { downloadUrl: await deps.createSignedUrl(env, original.objectKey, "GET") },
          },
        });
      }
      candidates = { ...candidates };
      delete candidates[picked.id];
    }
    return deps.jsonResponse({ ok: true, job: null });
  }

  const record = await loadProcessingReel(env, deps, body.reelId);

  if (pathname === "/v1/encoder/upload-urls") {
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0 || files.length > MAX_UPLOAD_FILES) {
      throw new deps.HttpError(400, "Invalid file list.");
    }
    const urls = {};
    for (const file of files) {
      if (!isValidOutputPath(file?.path) || file.contentType !== outputContentType(file.path)) {
        throw new deps.HttpError(400, "Invalid output file.");
      }
      urls[file.path] = await deps.createSignedUrl(
        env, outputObjectKey(record.ownerUid, record.id, file.path), "PUT", file.contentType);
    }
    return deps.jsonResponse({ ok: true, urls });
  }

  if (pathname === "/v1/encoder/complete") {
    const result = validateCompleteResult(body.result);
    if (!result) throw new deps.HttpError(400, "Invalid encoding result.");
    const head = (path) => env.AVTUBE_MEDIA.head(outputObjectKey(record.ownerUid, record.id, path));
    // Never mark a Reel ready unless the MP4 it advertises really exists in R2 with the reported size.
    const video = await head(PLAYBACK_FILE);
    if (!video || video.size !== result.encodedFileSize) {
      throw new deps.HttpError(409, "Encoded output is incomplete.");
    }
    const posterExists = Boolean(await head("poster.jpg"));
    const fields = readyFields({
      result, record, origin: publicOrigin(env, request), now, posterExists,
    });
    if (fields.posterUrl) {
      fields.thumbnailUrl = fields.posterUrl;
      delete fields.posterUrl;
    }
    await writeBoth(env, deps, record, fields);
    return deps.jsonResponse({ ok: true, encodingStatus: "ready" });
  }

  if (pathname === "/v1/encoder/fail") {
    const fields = nextFailureState(record, body.message, now);
    await writeBoth(env, deps, record, fields);
    return deps.jsonResponse({ ok: true, encodingStatus: fields.encodingStatus ?? "processing" });
  }

  throw new deps.HttpError(404, "Not found.");
}

/** Public playback delivery: GET /v1/r2/playback/{reelId}/{480p.mp4|poster.jpg}, Range-aware. */
export async function servePlayback(pathname, request, env, deps) {
  const match = pathname.match(/^\/v1\/r2\/playback\/([A-Za-z0-9_-]{8,100})\/(.+)$/);
  if (!match || !isValidOutputPath(match[2])) throw new deps.HttpError(404, "Media was not found.");
  const [, reelId, path] = match;
  const record = await deps.databaseRequest(env, `publicVideos/${reelId}`);
  if (
    !record ||
    record.status !== "published" ||
    record.visibility !== "public" ||
    record.mediaType !== "reel" ||
    record.encodingStatus !== "ready"
  ) throw new deps.HttpError(404, "Media was not found.");

  const ranged = request.headers.has("Range");
  const object = await env.AVTUBE_MEDIA.get(
    outputObjectKey(record.ownerUid, reelId, path),
    ranged ? { range: request.headers } : undefined,
  );
  if (!object) throw new deps.HttpError(404, "Media was not found.");
  const headers = {
    ...deps.corsHeaders(),
    "Content-Type": outputContentType(path),
    "Accept-Ranges": "bytes",
    // Output files are immutable per Reel.
    "Cache-Control": "public, max-age=86400, immutable",
  };
  let status = 200;
  if (ranged && object.range && "offset" in object.range) {
    status = 206;
    const { offset, length } = object.range;
    headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${object.size}`;
    headers["Content-Length"] = String(length);
  } else {
    headers["Content-Length"] = String(object.size);
  }
  return new Response(object.body, { status, headers });
}
