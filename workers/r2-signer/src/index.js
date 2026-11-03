import { AwsClient } from "aws4fetch";
import {
  encodingEnabled,
  handleEncoderRequest,
  queuedFields,
  servePlayback,
} from "./encoding.js";
import {
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
  SignJWT,
} from "jose";

const FIREBASE_PROJECT_ID = "av-tube-6e417";
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  )
);
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;
const PRESIGN_SECONDS = 900;
const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const STORY_VISIBILITY_INDEX_VERSION = 1;
const MIME_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
};
const MEDIA_FOLDERS = {
  reel: "reels",
  post: "posts",
  story: "stories",
};
const PUBLIC_NODES = {
  reel: "publicVideos",
  post: "publicPosts",
  story: "publicStories",
};

let cachedAdminToken;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(error) {
  const status = error instanceof HttpError ? error.status : 500;
  const message =
    error instanceof HttpError
      ? error.message
      : "The media service could not complete the request.";
  if (!(error instanceof HttpError)) {
    console.error(
      "AVTube R2 Worker:",
      error instanceof Error ? error.message : "Unknown service error"
    );
  }
  return jsonResponse({ ok: false, error: message }, status);
}

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function getToken(request) {
  const match = request.headers
    .get("Authorization")
    ?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

async function authenticate(request) {
  const token = getToken(request);
  if (!token) throw new HttpError(401, "Sign in to manage media.");

  try {
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
      algorithms: ["RS256"],
      issuer: FIREBASE_ISSUER,
      audience: FIREBASE_PROJECT_ID,
    });
    if (typeof payload.sub !== "string" || !payload.sub) {
      throw new Error("Missing Firebase user ID");
    }
    return { uid: payload.sub };
  } catch {
    throw new HttpError(401, "Your sign-in has expired. Sign in and try again.");
  }
}

async function requestJson(request) {
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > 1024 * 1024) {
    throw new HttpError(413, "Media metadata request is too large.");
  }
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "The request body must be valid JSON.");
  }
}

function mediaType(value) {
  if (value !== "reel" && value !== "post" && value !== "story") {
    throw new HttpError(400, "Choose a Reel, Post, or Story media type.");
  }
  return value;
}

function safeId(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(value)
  ) {
    throw new HttpError(400, `Invalid ${label}.`);
  }
  return value;
}

function validateAsset(type, value) {
  const asset = asRecord(value);
  if (!asset) throw new HttpError(400, "Invalid media asset.");

  const assetId = safeId(asset.assetId, "media asset ID");
  const extension =
    typeof asset.extension === "string"
      ? asset.extension.trim().toLowerCase().replace(/^\./, "")
      : "";
  const contentType =
    typeof asset.contentType === "string"
      ? asset.contentType.trim().toLowerCase()
      : "";
  const mediaKind = asset.mediaKind;
  const purpose = asset.purpose;
  const size = asset.size;

  if (purpose !== "original" && purpose !== "thumbnail") {
    throw new HttpError(400, "Invalid media asset purpose.");
  }
  if (mediaKind !== "image" && mediaKind !== "video") {
    throw new HttpError(400, "Invalid media format.");
  }
  if (purpose === "thumbnail" && (type !== "reel" || mediaKind !== "image")) {
    throw new HttpError(400, "Only Reels can have image thumbnails.");
  }
  if (
    purpose === "original" &&
    ((type === "reel" && mediaKind !== "video") ||
      (type === "post" && mediaKind !== "image"))
  ) {
    throw new HttpError(
      400,
      type === "reel"
        ? "A Reel must contain video."
        : "A Post must contain photo media."
    );
  }

  if (
    !Object.hasOwn(MIME_TYPES, extension) ||
    MIME_TYPES[extension] !== contentType ||
    (mediaKind === "image" && !contentType.startsWith("image/")) ||
    (mediaKind === "video" && !contentType.startsWith("video/"))
  ) {
    throw new HttpError(400, "The file extension and content type are unsupported or do not match.");
  }
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new HttpError(400, "Media file size is missing or invalid.");
  }
  if (size > MAX_FILE_BYTES) {
    throw new HttpError(413, "Each media file must be 500 MB or smaller.");
  }
  if (
    asset.durationMs !== undefined &&
    (!Number.isSafeInteger(asset.durationMs) || asset.durationMs < 0)
  ) {
    throw new HttpError(400, "Invalid media duration.");
  }
  const maximumDuration =
    mediaKind === "video"
      ? type === "reel"
        ? 180_000
        : type === "story"
          ? 60_000
          : null
      : null;
  if (
    maximumDuration !== null &&
    asset.durationMs !== undefined &&
    asset.durationMs > maximumDuration
  ) {
    throw new HttpError(
      400,
      type === "reel"
        ? "Reels must be 3 minutes or shorter."
        : "Story videos must be 60 seconds or shorter."
    );
  }

  return {
    assetId,
    extension,
    contentType,
    mediaKind,
    purpose,
    size,
    ...(Number.isSafeInteger(asset.durationMs)
      ? { durationMs: asset.durationMs }
      : {}),
  };
}

function objectKeyFor(uid, type, id, asset) {
  const purposePath =
    asset.purpose === "thumbnail" ? "thumbnails" : "original";
  return `users/${uid}/${MEDIA_FOLDERS[type]}/${id}/${purposePath}/${asset.assetId}.${asset.extension}`;
}

function profilePhotoObjectKey(uid, photoId) {
  return `users/${uid}/profile-photos/${safeId(photoId, "profile photo ID")}.jpg`;
}

function profilePhotoUrl(origin, uid, photoId) {
  return `${origin}/v1/r2/profile-photo/${encodeURIComponent(uid)}/${safeId(photoId, "profile photo ID")}`;
}

function validateProfilePhotoRequest(body) {
  const photoId = safeId(body?.photoId, "profile photo ID");
  const size = body?.size;
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new HttpError(400, "The profile photo size is missing or invalid.");
  }
  if (size > MAX_PROFILE_PHOTO_BYTES) {
    throw new HttpError(413, "Profile photos must be 5 MB or smaller.");
  }
  return { photoId, size };
}

function profilePhotoReferenceMatches(value, uid, photoId) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const match = url.pathname.match(
      /^\/v1\/r2\/profile-photo\/([^/]+)\/([A-Za-z0-9_-]{8,100})$/
    );
    return (
      url.protocol === "https:" &&
      match !== null &&
      decodeURIComponent(match[1]) === uid &&
      match[2] === photoId
    );
  } catch {
    return false;
  }
}

function requireR2Credentials(env) {
  if (
    !env.R2_ACCOUNT_ID ||
    !env.R2_BUCKET_NAME ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY
  ) {
    throw new HttpError(503, "R2 storage is not fully configured.");
  }
}

function r2Client(env) {
  requireR2Credentials(env);
  return new AwsClient({
    service: "s3",
    region: "auto",
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
}

function r2ObjectUrl(env, objectKey) {
  const encodedKey = objectKey
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${encodedKey}`
  );
}

async function createSignedUrl(env, objectKey, method, contentType) {
  requireR2Credentials(env);
  const url = r2ObjectUrl(env, objectKey);
  url.searchParams.set("X-Amz-Expires", String(PRESIGN_SECONDS));
  const headers = contentType ? { "Content-Type": contentType } : undefined;
  const signed = await r2Client(env).sign(
    new Request(url, { method, headers }),
    {
      aws: {
        signQuery: true,
        allHeaders: true,
      },
    }
  );
  return signed.url.toString();
}

function serviceAccount(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON || !env.FIREBASE_DATABASE_URL) {
    throw new HttpError(503, "Firebase media metadata is not configured.");
  }
  let account;
  try {
    account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new HttpError(503, "Firebase media metadata credentials are invalid.");
  }
  if (
    account.project_id !== FIREBASE_PROJECT_ID ||
    typeof account.client_email !== "string" ||
    typeof account.private_key !== "string"
  ) {
    throw new HttpError(503, "Firebase media metadata credentials are invalid.");
  }
  return account;
}

async function firebaseAdminToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAdminToken?.expiresAt > now + 60) {
    return cachedAdminToken.value;
  }

  const account = serviceAccount(env);
  const privateKey = await importPKCS8(account.private_key, "RS256");
  const assertion = await new SignJWT({
    scope:
      "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(account.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new HttpError(502, "Firebase authorization could not be completed.");
  }
  if (
    !response.ok ||
    typeof data.access_token !== "string" ||
    !Number.isFinite(data.expires_in)
  ) {
    throw new HttpError(502, "Firebase authorization could not be completed.");
  }
  cachedAdminToken = {
    value: data.access_token,
    expiresAt: now + data.expires_in,
  };
  return cachedAdminToken.value;
}

async function databaseRequest(env, path, method = "GET", value, queryParameters) {
  if (!env.FIREBASE_DATABASE_URL) {
    throw new HttpError(503, "Firebase media metadata is not configured.");
  }
  const baseUrl = env.FIREBASE_DATABASE_URL.replace(/\/+$/, "");
  const databasePath = path
    ? `/${path.split("/").map(encodeURIComponent).join("/")}`
    : "";
  const accessToken = await firebaseAdminToken(env);
  const query = queryParameters
    ? `?${new URLSearchParams(queryParameters).toString()}`
    : "";
  const endpoint = path
    ? `${baseUrl}${databasePath}.json${query}`
    : `${baseUrl}/.json${query}`;
  const response = await fetch(endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(value === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  if (!response.ok) {
    throw new HttpError(502, "Firebase media metadata could not be saved or loaded.");
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isValidSignature(bytes, asset) {
  if (asset.extension === "jpg" || asset.extension === "jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (asset.extension === "png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (asset.extension === "webp") {
    return (
      bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    );
  }
  if (asset.extension === "webm") {
    return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }
  if (["mp4", "mov", "m4v"].includes(asset.extension)) {
    return String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
  }
  return false;
}

async function verifyUploadedAsset(env, uid, type, id, asset) {
  const objectKey = objectKeyFor(uid, type, id, asset);
  const head = await env.AVTUBE_MEDIA.head(objectKey);
  if (!head) throw new HttpError(400, "An uploaded media file could not be found.");
  if (head.size < 1 || head.size > MAX_FILE_BYTES) {
    await env.AVTUBE_MEDIA.delete(objectKey);
    throw new HttpError(413, "Each media file must be 500 MB or smaller.");
  }
  if (
    head.httpMetadata?.contentType?.toLowerCase() !== asset.contentType ||
    head.size !== asset.size
  ) {
    await env.AVTUBE_MEDIA.delete(objectKey);
    throw new HttpError(400, "Uploaded file metadata does not match the requested media.");
  }
  const sample = await env.AVTUBE_MEDIA.get(objectKey, {
    range: { offset: 0, length: 16 },
  });
  if (!sample) throw new HttpError(400, "The uploaded media could not be verified.");
  const bytes = new Uint8Array(await sample.arrayBuffer());
  if (!isValidSignature(bytes, asset)) {
    await env.AVTUBE_MEDIA.delete(objectKey);
    throw new HttpError(400, "The uploaded file content does not match its media type.");
  }
  return {
    assetId: asset.assetId,
    purpose: asset.purpose,
    mediaKind: asset.mediaKind,
    contentType: asset.contentType,
    extension: asset.extension,
    size: head.size,
    objectKey,
    ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
  };
}

function normalizeAudience(value) {
  if (!["public", "followers", "close-friends"].includes(value)) {
    throw new HttpError(400, "Choose a valid audience.");
  }
  return value;
}

function validatePublishBody(body) {
  const type = mediaType(body?.type);
  const id = safeId(body?.id, "media ID");
  if (!Array.isArray(body?.assets)) {
    throw new HttpError(400, "Media assets are required.");
  }
  const assets = body.assets.map((asset) => validateAsset(type, asset));
  const originals = assets.filter((asset) => asset.purpose === "original");
  const thumbnails = assets.filter((asset) => asset.purpose === "thumbnail");
  if (
    originals.length === 0 ||
    originals.length > (type === "post" ? 10 : 1) ||
    thumbnails.length > (type === "reel" ? 1 : 0) ||
    new Set(assets.map((asset) => asset.assetId)).size !== assets.length
  ) {
    throw new HttpError(400, "The selected media does not match this content type.");
  }
  if (
    (type === "reel" && originals[0].mediaKind !== "video") ||
    (type === "post" && originals.some((asset) => asset.mediaKind !== "image")) ||
    (type === "story" && originals.length !== 1)
  ) {
    throw new HttpError(
      400,
      type === "reel"
        ? "A Reel must contain one video."
        : type === "post"
          ? "A Post can contain photos only."
          : "A Story must contain one story photo or video."
    );
  }
  const caption = typeof body.caption === "string" ? body.caption : "";
  if (caption.length > 2200) throw new HttpError(400, "Caption is too long.");
  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (category.length > 50) throw new HttpError(400, "Category is too long.");
  const location = typeof body.location === "string" ? body.location.trim() : "";
  if (location.length > 200) throw new HttpError(400, "Location is too long.");
  const mentions = body.mentions === undefined ? [] : body.mentions;
  if (
    !Array.isArray(mentions) ||
    mentions.length > 100 ||
    mentions.some(
      (mention) =>
        typeof mention !== "string" || mention.length > 30 || !/^[a-zA-Z0-9_]+$/.test(mention)
    )
  ) {
    throw new HttpError(400, "Invalid mentions.");
  }
  return {
    type,
    id,
    assets,
    caption,
    category,
    location,
    mentions,
    audience: normalizeAudience(body.audience),
    allowComments: body.allowComments !== false,
    allowReposts: type !== "story" && body.allowReposts !== false,
  };
}

function mediaNode(type, uid, id) {
  if (type === "reel") return `mediaReels/${uid}/${id}`;
  if (type === "post") return `mediaPosts/${uid}/${id}`;
  return `stories/${uid}/${id}`;
}

function publicNode(type, id) {
  return `${PUBLIC_NODES[type]}/${id}`;
}

function publicMediaUrl(origin, type, id, asset) {
  return `${origin}/v1/r2/public-media/${type}/${id}/${asset.assetId}/${asset.purpose}`;
}

async function publishMedia(request, env, uid) {
  const body = validatePublishBody(await requestJson(request));
  const existing = await databaseRequest(env, mediaNode(body.type, uid, body.id));
  if (existing) {
    const requestedKeys = body.assets
      .map((asset) => objectKeyFor(uid, body.type, body.id, asset))
      .sort();
    const existingKeys = Array.isArray(existing.assets)
      ? existing.assets
          .map((asset) => asset?.objectKey)
          .filter((key) => typeof key === "string")
          .sort()
      : [];
    const permissionsMatch =
      body.type === "story"
        ? existing.allowReplies === body.allowComments
        : existing.allowComments === body.allowComments &&
          existing.allowReposts === body.allowReposts;
    if (
      existing.ownerUid === uid &&
      existing.mediaType === body.type &&
      existing.status === "published" &&
      existing.visibility === body.audience &&
      existing.caption === body.caption &&
      existing.category === (body.category || undefined) &&
      existing.location === (body.location || undefined) &&
      JSON.stringify(existing.mentions ?? []) === JSON.stringify(body.mentions) &&
      permissionsMatch &&
      requestedKeys.length === existingKeys.length &&
      requestedKeys.every((key, index) => key === existingKeys[index])
    ) {
      return jsonResponse({
        ok: true,
        mediaType: body.type,
        id: body.id,
        status: "published",
      });
    }
    throw new HttpError(409, "This media ID is already in use.");
  }

  const checkedAssets = [];
  for (const asset of body.assets) {
    checkedAssets.push(await verifyUploadedAsset(env, uid, body.type, body.id, asset));
  }
  const originalAssets = checkedAssets.filter((asset) => asset.purpose === "original");
  const thumbnail = checkedAssets.find((asset) => asset.purpose === "thumbnail");
  const profile = asRecord(await databaseRequest(env, `users/${uid}`));
  const createdAt = Date.now();
  const record = {
    id: body.id,
    ownerUid: uid,
    mediaType: body.type,
    mediaKind: originalAssets[0].mediaKind,
    assets: checkedAssets,
    ...(thumbnail ? { thumbnailKey: thumbnail.objectKey } : {}),
    caption: body.caption,
    ...(body.category ? { category: body.category } : {}),
    ...(body.location ? { location: body.location } : {}),
    ...(body.mentions.length ? { mentions: body.mentions } : {}),
    ...(body.type !== "story"
      ? {
          hashtags: [...new Set(body.caption.match(/#[\p{L}\p{N}_]+/gu) ?? [])],
          allowComments: body.allowComments,
          allowReposts: body.allowReposts,
        }
      : { allowReplies: body.allowComments }),
    ...(Number.isSafeInteger(originalAssets[0].durationMs)
      ? { durationMs: originalAssets[0].durationMs }
      : {}),
    creatorName:
      typeof profile?.fullName === "string"
        ? profile.fullName
        : typeof profile?.username === "string"
          ? profile.username
          : "AVTube member",
    creatorUsername:
      typeof profile?.usernameLower === "string"
        ? profile.usernameLower
        : typeof profile?.username === "string"
          ? profile.username
          : "",
    visibility: body.audience,
    status: "published",
    createdAt,
    ...(body.type === "reel" && body.audience === "public" && encodingEnabled(env)
      ? queuedFields(originalAssets[0], createdAt)
      : {}),
  };
  const origin = new URL(request.url).origin;
  const updates = {
    [mediaNode(body.type, uid, body.id)]: record,
  };

  if (body.audience === "public") {
    const publicRecord = { ...record };
    if (body.type === "reel") {
      const video = originalAssets[0];
      publicRecord.videoUrl = publicMediaUrl(origin, body.type, body.id, video);
      if (thumbnail) {
        publicRecord.thumbnailUrl = publicMediaUrl(origin, body.type, body.id, thumbnail);
      }
    } else {
      publicRecord.mediaUrls = originalAssets.map((asset) =>
        publicMediaUrl(origin, body.type, body.id, asset)
      );
    }
    if (await databaseRequest(env, publicNode(body.type, body.id))) {
      throw new HttpError(409, "This media ID is already in use.");
    }
    updates[publicNode(body.type, body.id)] = publicRecord;
  } else if (body.type === "story") {
    updates[`storyVisibilityIndex/${uid.length}_${uid}_${body.id}`] = {
      ownerUid: uid,
      storyId: body.id,
      createdAt,
    };
  }

  await databaseRequest(env, "", "PATCH", updates);
  return jsonResponse({
    ok: true,
    mediaType: body.type,
    id: body.id,
    status: "published",
  });
}

function assetInRecord(record, assetId, purpose) {
  if (!Array.isArray(record?.assets)) return null;
  return (
    record.assets.find(
      (asset) =>
        asset?.assetId === assetId &&
        asset?.purpose === purpose &&
        typeof asset?.objectKey === "string"
    ) ?? null
  );
}

async function findRecord(env, type, id, uid, ownerUid) {
  if (ownerUid) {
    const ownerRecord = await databaseRequest(env, mediaNode(type, ownerUid, id));
    if (ownerRecord?.ownerUid === ownerUid) return ownerRecord;
  } else {
    const ownRecord = await databaseRequest(env, mediaNode(type, uid, id));
    if (ownRecord) return ownRecord;
  }
  return databaseRequest(env, publicNode(type, id));
}

function isAuthorizedPrivateStory(record, uid, isFollower, isCloseFriend) {
  return (
    record.ownerUid === uid ||
    (record.visibility === "followers" && isFollower) ||
    (record.visibility === "close-friends" && isCloseFriend)
  );
}

async function canReadRecord(env, record, uid) {
  if (record.ownerUid === uid || record.visibility === "public") return true;
  if (record.visibility === "followers") {
    const isFollower = (await databaseRequest(
      env,
      `follows/${record.ownerUid}/followers/${uid}`
    )) === true;
    return isAuthorizedPrivateStory(record, uid, isFollower, false);
  }
  if (record.visibility === "close-friends") {
    const isCloseFriend = (await databaseRequest(
      env,
      `closeFriends/${record.ownerUid}/${uid}`
    )) === true;
    return isAuthorizedPrivateStory(record, uid, false, isCloseFriend);
  }
  return false;
}

function isActivePrivateStory(record, ownerUid, storyId, now) {
  return (
    record &&
    record.id === storyId &&
    record.ownerUid === ownerUid &&
    record.mediaType === "story" &&
    record.status === "published" &&
    (record.visibility === "followers" || record.visibility === "close-friends") &&
    Number.isFinite(record.createdAt) &&
    record.createdAt > now - STORY_LIFETIME_MS &&
    (!Number.isFinite(record.expiresAt) || record.expiresAt > now) &&
    (record.mediaKind === "image" || record.mediaKind === "video")
  );
}

function isValidOwnerUid(uid) {
  return (
    typeof uid === "string" &&
    uid.length > 0 &&
    uid.length <= 128 &&
    !/[.#$/[\]\u0000-\u001f\u007f]/.test(uid)
  );
}

function assertStoryVisibilityIndexReady(version) {
  if (version !== STORY_VISIBILITY_INDEX_VERSION) {
    throw new HttpError(
      503,
      "Private Stories are temporarily unavailable while secure access is prepared."
    );
  }
}

async function ensureStoryVisibilityIndex(env) {
  const version = await databaseRequest(env, "storyVisibilityIndexMeta/version");
  assertStoryVisibilityIndexReady(version);
}

async function resolveVisiblePrivateStories(
  index,
  uid,
  now,
  loadStory,
  canRead,
  signAsset
) {
  const candidates = Object.values(index)
    .map(asRecord)
    .filter((entry) =>
      entry &&
      isValidOwnerUid(entry.ownerUid) &&
      typeof entry.storyId === "string" &&
      /^[A-Za-z0-9_-]{8,100}$/.test(entry.storyId) &&
      Number.isFinite(entry.createdAt) &&
      entry.createdAt > now - STORY_LIFETIME_MS
    )
    .sort((left, right) => right.createdAt - left.createdAt);
  const stories = [];
  for (let offset = 0; offset < candidates.length && stories.length < 100; offset += 20) {
    const batch = await Promise.all(candidates.slice(offset, offset + 20).map(async (candidate) => {
      const record = asRecord(await loadStory(candidate.ownerUid, candidate.storyId));
      if (
        !isActivePrivateStory(record, candidate.ownerUid, candidate.storyId, now) ||
        !(await canRead(record, uid))
      ) return null;

      const original = Array.isArray(record.assets)
        ? record.assets.find((item) => item?.purpose === "original")
        : null;
      const asset = original
        ? assetInRecord(record, original.assetId, "original")
        : null;
      if (!asset) return null;
      const mediaUrl = await signAsset(asset);
      return {
        id: record.id,
        ownerUid: record.ownerUid,
        mediaKind: record.mediaKind,
        mediaUrl,
        caption: typeof record.caption === "string" ? record.caption : "",
        creatorName: typeof record.creatorName === "string" ? record.creatorName : "",
        creatorUsername: typeof record.creatorUsername === "string" ? record.creatorUsername : "",
        createdAt: record.createdAt,
        visibility: record.visibility,
        expiresAt: Number.isFinite(record.expiresAt)
          ? record.expiresAt
          : record.createdAt + STORY_LIFETIME_MS,
      };
    }));
    stories.push(...batch.filter((story) => story !== null));
  }
  return stories.slice(0, 100);
}

async function listVisiblePrivateStories(env, uid) {
  await ensureStoryVisibilityIndex(env);
  const now = Date.now();
  const index = asRecord(
    await databaseRequest(
      env,
      "storyVisibilityIndex",
      "GET",
      undefined,
      {
        orderBy: JSON.stringify("createdAt"),
        startAt: JSON.stringify(now - STORY_LIFETIME_MS),
        limitToLast: "500",
      }
    )
  ) ?? {};
  return resolveVisiblePrivateStories(
    index,
    uid,
    now,
    (ownerUid, storyId) =>
      databaseRequest(env, `stories/${ownerUid}/${storyId}`),
    (record, viewerUid) => canReadRecord(env, record, viewerUid),
    (asset) => createSignedUrl(env, asset.objectKey, "GET")
  );
}

async function createDownloadUrl(env, type, id, assetId, purpose, uid, ownerUid) {
  const record = await findRecord(env, type, id, uid, ownerUid);
  if (
    !record ||
    record.status !== "published" ||
    record.mediaType !== type ||
    !(await canReadRecord(env, record, uid))
  ) {
    throw new HttpError(404, "Media was not found or is not available to this account.");
  }
  const asset = assetInRecord(record, assetId, purpose);
  if (!asset) throw new HttpError(404, "Media asset was not found.");
  const url = await createSignedUrl(env, asset.objectKey, "GET");
  return { url, expiresIn: PRESIGN_SECONDS };
}

async function uploadUrl(request, env, uid) {
  const body = await requestJson(request);
  const type = mediaType(body?.type);
  const id = safeId(body?.id, "media ID");
  const asset = validateAsset(type, body?.asset ?? body);
  if (
    (await databaseRequest(env, mediaNode(type, uid, id))) ||
    (await databaseRequest(env, publicNode(type, id)))
  ) {
    throw new HttpError(409, "This media ID is already in use.");
  }
  const objectKey = objectKeyFor(uid, type, id, asset);
  const uploadUrl = await createSignedUrl(
    env,
    objectKey,
    "PUT",
    asset.contentType
  );
  return jsonResponse({
    ok: true,
    uploadUrl,
    objectKey,
    mediaType: type,
    mediaKind: asset.mediaKind,
    contentType: asset.contentType,
    expiresIn: PRESIGN_SECONDS,
  });
}

async function profilePhotoUploadUrl(request, env, uid) {
  const { photoId } = validateProfilePhotoRequest(await requestJson(request));
  const objectKey = profilePhotoObjectKey(uid, photoId);
  if (await env.AVTUBE_MEDIA.head(objectKey)) {
    throw new HttpError(409, "This profile photo upload ID is already in use.");
  }
  const uploadUrl = await createSignedUrl(env, objectKey, "PUT", "image/jpeg");
  return jsonResponse({
    ok: true,
    uploadUrl,
    objectKey,
    contentType: "image/jpeg",
    expiresIn: PRESIGN_SECONDS,
  });
}

async function confirmProfilePhoto(request, env, uid) {
  const { photoId, size } = validateProfilePhotoRequest(await requestJson(request));
  const objectKey = profilePhotoObjectKey(uid, photoId);
  const head = await env.AVTUBE_MEDIA.head(objectKey);
  if (!head) throw new HttpError(400, "The uploaded profile photo could not be found.");
  if (
    head.size !== size ||
    head.size < 1 ||
    head.size > MAX_PROFILE_PHOTO_BYTES ||
    head.httpMetadata?.contentType?.toLowerCase() !== "image/jpeg"
  ) {
    await env.AVTUBE_MEDIA.delete(objectKey);
    throw new HttpError(400, "The uploaded profile photo is invalid or too large.");
  }

  const sample = await env.AVTUBE_MEDIA.get(objectKey, {
    range: { offset: 0, length: 16 },
  });
  if (!sample) {
    await env.AVTUBE_MEDIA.delete(objectKey);
    throw new HttpError(400, "The uploaded profile photo could not be verified.");
  }
  const bytes = new Uint8Array(await sample.arrayBuffer());
  if (!isValidSignature(bytes, { extension: "jpg" })) {
    await env.AVTUBE_MEDIA.delete(objectKey);
    throw new HttpError(400, "The uploaded file is not a valid JPEG photo.");
  }

  return jsonResponse({
    ok: true,
    url: profilePhotoUrl(new URL(request.url).origin, uid, photoId),
  });
}

async function publicProfilePhoto(path, request, env) {
  const match = path.match(
    /^\/v1\/r2\/profile-photo\/([^/]+)\/([A-Za-z0-9_-]{8,100})$/
  );
  if (!match) throw new HttpError(404, "Profile photo was not found.");

  let uid;
  try {
    uid = decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(404, "Profile photo was not found.");
  }
  const [, , photoId] = match;
  if (!uid || uid.length > 128) {
    throw new HttpError(404, "Profile photo was not found.");
  }
  const currentPhoto = await databaseRequest(env, `users/${uid}/profileImage`);
  if (!profilePhotoReferenceMatches(currentPhoto, uid, photoId)) {
    throw new HttpError(404, "Profile photo was not found.");
  }

  const objectKey = profilePhotoObjectKey(uid, photoId);
  if (!(await env.AVTUBE_MEDIA.head(objectKey))) {
    throw new HttpError(404, "Profile photo was not found.");
  }
  const signedUrl = await createSignedUrl(env, objectKey, "GET");
  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders(),
      Location: signedUrl,
      "Cache-Control": "no-store",
    },
  });
}

async function deleteProfilePhoto(request, env, uid) {
  const body = await requestJson(request);
  const photoId = safeId(body?.photoId, "profile photo ID");
  const currentPhoto = await databaseRequest(env, `users/${uid}/profileImage`);
  if (profilePhotoReferenceMatches(currentPhoto, uid, photoId)) {
    throw new HttpError(409, "The active profile photo cannot be deleted.");
  }
  await env.AVTUBE_MEDIA.delete(profilePhotoObjectKey(uid, photoId));
  return jsonResponse({ ok: true });
}

async function downloadUrl(request, env, uid) {
  const body = await requestJson(request);
  const type = mediaType(body?.type);
  const id = safeId(body?.id, "media ID");
  const assetId = safeId(body?.assetId, "media asset ID");
  let ownerUid;
  if (body?.ownerUid !== undefined) {
    if (
      typeof body.ownerUid !== "string" ||
      body.ownerUid.length === 0 ||
      body.ownerUid.length > 128 ||
      /[.#$\/]/.test(body.ownerUid) ||
      body.ownerUid.includes("[") ||
      body.ownerUid.includes("]")
    ) {
      throw new HttpError(400, "Invalid owner UID.");
    }
    ownerUid = body.ownerUid;
  }
  const purpose = body?.purpose;
  if (purpose !== "original" && purpose !== "thumbnail") {
    throw new HttpError(400, "Invalid media asset purpose.");
  }
  const signed = await createDownloadUrl(
    env,
    type,
    id,
    assetId,
    purpose,
    uid,
    ownerUid
  );
  return jsonResponse({
    ok: true,
    ...signed,
  });
}

async function abortUploads(request, env, uid) {
  const body = await requestJson(request);
  const type = mediaType(body?.type);
  const id = safeId(body?.id, "media ID");
  if (!Array.isArray(body?.assets) || body.assets.length > 11) {
    throw new HttpError(400, "Invalid upload cleanup request.");
  }
  if (await databaseRequest(env, mediaNode(type, uid, id))) {
    throw new HttpError(409, "Published media cannot be removed by upload cleanup.");
  }
  for (const value of body.assets) {
    const asset = validateAsset(type, value);
    await env.AVTUBE_MEDIA.delete(objectKeyFor(uid, type, id, asset));
  }
  return jsonResponse({ ok: true });
}

async function publicMedia(path, request, env) {
  const match = path.match(
    /^\/v1\/r2\/public-media\/(reel|post|story)\/([A-Za-z0-9_-]{8,100})\/([A-Za-z0-9_-]{8,100})\/(original|thumbnail)$/
  );
  if (!match) throw new HttpError(404, "Media was not found.");
  const [, type, id, assetId, purpose] = match;
  const record = await databaseRequest(env, publicNode(type, id));
  if (
    !record ||
    record.status !== "published" ||
    record.mediaType !== type ||
    record.visibility !== "public"
  ) {
    throw new HttpError(404, "Media was not found.");
  }
  const asset = assetInRecord(record, assetId, purpose);
  if (!asset) throw new HttpError(404, "Media asset was not found.");
  const signedUrl = await createSignedUrl(env, asset.objectKey, "GET");
  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders(),
      Location: signedUrl,
      "Cache-Control": "no-store",
    },
  });
}

/** Atomically take the encoding lease: succeeds only if nobody changed it since it was read (ETag). */
async function claimLease(env, reelId, now, leaseUntil) {
  const base = env.FIREBASE_DATABASE_URL.replace(/\/+$/, "");
  const url = `${base}/publicVideos/${encodeURIComponent(reelId)}/encodingLeaseUntil.json`;
  const authorization = `Bearer ${await firebaseAdminToken(env)}`;
  const read = await fetch(url, { headers: { Authorization: authorization, "X-Firebase-ETag": "true" } });
  const etag = read.headers.get("ETag");
  if (!read.ok || !etag) throw new HttpError(502, "Firebase media metadata could not be saved or loaded.");
  if (Number(await read.json()) > now) return false;
  const write = await fetch(url, {
    method: "PUT",
    headers: { Authorization: authorization, "Content-Type": "application/json", "if-match": etag },
    body: JSON.stringify(leaseUntil),
  });
  if (write.status === 412) return false;
  if (!write.ok) throw new HttpError(502, "Firebase media metadata could not be saved or loaded.");
  return true;
}

const encodingDeps = {
  claimLease,
  HttpError,
  corsHeaders,
  createSignedUrl,
  databaseRequest,
  jsonResponse,
  requestJson,
};

function internalEncoderRequest(path, env, body, apiUrl) {
  const headers = new Headers();
  headers.set("Authorization", ["Bearer ", env.ENCODER_TOKEN].join(""));
  headers.set("Content-Type", "application/json");
  const request = new Request(`${apiUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return handleEncoderRequest(path, request, env, encodingDeps);
}

export async function claimNextEncodingJob(env, apiUrl) {
  if (!encodingEnabled(env)) return null;
  const response = await internalEncoderRequest("/v1/encoder/claim", env, {}, apiUrl);
  if (!response.ok) throw new Error(`Encoder claim failed (${response.status}).`);
  const data = await response.json();
  return data.job ?? null;
}

export async function hasClaimableEncodingJob(env) {
  if (!encodingEnabled(env)) return false;
  const records = await encodingDeps.databaseRequest(env, "publicVideos", "GET", undefined, {
    orderBy: '"encodingStatus"',
    equalTo: '"processing"',
    limitToFirst: "20",
  });
  return Boolean(pickClaimable(records, Date.now()));
}

export async function failEncodingJob(env, apiUrl, reelId, message) {
  const response = await internalEncoderRequest(
    "/v1/encoder/fail",
    env,
    { reelId, message },
    apiUrl,
  );
  if (!response.ok) throw new Error(`Encoder failure update failed (${response.status}).`);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return jsonResponse({
          ok: true,
          service: "AVTube R2 Signer",
          version: "2.0.0",
        });
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/r2/public-media/")) {
        return await publicMedia(url.pathname, request, env);
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/r2/playback/")) {
        return await servePlayback(url.pathname, request, env, encodingDeps);
      }
      if (request.method === "POST" && url.pathname.startsWith("/v1/encoder/")) {
        return await handleEncoderRequest(url.pathname, request, env, encodingDeps);
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/r2/profile-photo/")) {
        return await publicProfilePhoto(url.pathname, request, env);
      }
      if (request.method !== "POST" && url.pathname !== "/v1/r2/stories") {
        throw new HttpError(404, "Not found.");
      }

      const user = await authenticate(request);
      if (url.pathname === "/v1/r2/upload-url") {
        return await uploadUrl(request, env, user.uid);
      }
      if (url.pathname === "/v1/r2/profile-photo/upload-url") {
        return await profilePhotoUploadUrl(request, env, user.uid);
      }
      if (url.pathname === "/v1/r2/profile-photo/confirm") {
        return await confirmProfilePhoto(request, env, user.uid);
      }
      if (url.pathname === "/v1/r2/profile-photo/delete") {
        return await deleteProfilePhoto(request, env, user.uid);
      }
      if (url.pathname === "/v1/r2/publish") {
        return await publishMedia(request, env, user.uid);
      }
      if (url.pathname === "/v1/r2/download-url") {
        return await downloadUrl(request, env, user.uid);
      }
      if (url.pathname === "/v1/r2/stories") {
        return jsonResponse({
          ok: true,
          stories: await listVisiblePrivateStories(env, user.uid),
        });
      }
      if (url.pathname === "/v1/r2/abort") {
        return await abortUploads(request, env, user.uid);
      }
      throw new HttpError(404, "Not found.");
    } catch (error) {
      return errorResponse(error);
    }
  },
};

export {
  MAX_FILE_BYTES,
  MAX_PROFILE_PHOTO_BYTES,
  isValidSignature,
  objectKeyFor,
  profilePhotoObjectKey,
  profilePhotoReferenceMatches,
  validateAsset,
  validateProfilePhotoRequest,
  validatePublishBody,
  isActivePrivateStory,
  isAuthorizedPrivateStory,
  assertStoryVisibilityIndexReady,
  listVisiblePrivateStories,
  resolveVisiblePrivateStories,
};
