// Encoder worker loop: claim a Reel from the AVTube Worker, download the original, encode one 480p MP4 with
// FFmpeg, upload through the Worker's presigned URLs, then mark the Reel ready (or failed).
// It holds no R2 or Firebase credentials; its only secret is ENCODER_TOKEN.
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

import { encodeToMp4, listFiles } from './encode.mjs';

const TYPES = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };

export function contentTypeFor(file) {
  const type = TYPES[path.extname(file)];
  if (!type) throw new Error(`Unexpected output file ${file}`);
  return type;
}

export function safeMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/(\/[\w.-]+){2,}/g, '[path]')
    .slice(0, 180);
}

function api(config) {
  const call = async (route, body) => {
    const response = await fetch(`${config.apiUrl}${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Encoder API ${route} responded ${response.status}`);
    return response.json();
  };
  return { call };
}

async function withRetry(task, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await task();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** i));
    }
  }
  throw last;
}

async function download(url, file, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Original download failed (${response.status}).`);
  const declaredSize = Number(response.headers.get('Content-Length'));
  if (declaredSize > maxBytes) throw new Error('Original has an invalid size.');
  let downloaded = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      downloaded += chunk.length;
      if (downloaded > maxBytes) callback(new Error('Original has an invalid size.'));
      else callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(file));
  const { size } = await stat(file);
  if (size === 0 || size > maxBytes) throw new Error('Original has an invalid size.');
  return size;
}

async function uploadAll(client, reelId, outDir, concurrency = 4) {
  const files = await listFiles(outDir);
  for (let i = 0; i < files.length; i += 100) {
    const batch = files.slice(i, i + 100);
    const { urls } = await client.call('/v1/encoder/upload-urls', {
      reelId,
      files: batch.map((file) => ({ path: file, contentType: contentTypeFor(file) })),
    });
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        const file = batch[next++];
        const body = await readFile(path.join(outDir, file));
        await withRetry(async () => {
          const response = await fetch(urls[file], {
            method: 'PUT',
            headers: { 'Content-Type': contentTypeFor(file) },
            body,
            signal: AbortSignal.timeout(2 * 60 * 1000),
          });
          if (!response.ok) throw new Error(`Upload of ${file} failed (${response.status}).`);
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker));
  }
  return files.length;
}

export async function processJob(config, client, job) {
  const dir = path.join(config.workDir, job.reelId);
  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const input = path.join(dir, 'original');
    const originalSize = await download(job.original.downloadUrl, input, config.maxBytes);
    const outDir = path.join(dir, 'out');
    const result = await encodeToMp4({ input, outDir, ffmpeg: config.ffmpeg, ffprobe: config.ffprobe });
    const uploaded = await uploadAll(client, job.reelId, outDir);
    await client.call('/v1/encoder/complete', {
      reelId: job.reelId,
      result: { ...result, source: undefined, mode: undefined, originalFileSize: originalSize },
    });
    return { ok: true, uploaded, result };
  } catch (error) {
    const message = safeMessage(error);
    try {
      await client.call('/v1/encoder/fail', { reelId: job.reelId, message });
    } catch (failureError) {
      console.error('Could not report encoder failure:', safeMessage(failureError));
    }
    return { ok: false, error: message };
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error('Could not clean encoder work directory:', safeMessage(cleanupError));
    }
  }
}

export async function runLoop(config) {
  const client = api(config);
  for (;;) {
    let job = null;
    try {
      ({ job } = await client.call('/v1/encoder/claim'));
    } catch (error) {
      console.error('claim failed:', safeMessage(error));
    }
    if (job) {
      const outcome = await processJob(config, client, job);
      console.log(job.reelId, outcome.ok ? `ready ${outcome.result.qualities.join('/')}p ${outcome.result.width}x${outcome.result.height} ${outcome.result.encodedFileSize}B (${outcome.result.mode})` : `failed: ${outcome.error}`);
    } else if (config.once) {
      return;
    } else {
      await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
  }
}

export function configFromEnv(env = process.env) {
  if (!env.ENCODER_API_URL || !env.ENCODER_TOKEN) throw new Error('ENCODER_API_URL and ENCODER_TOKEN are required.');
  return {
    apiUrl: env.ENCODER_API_URL.replace(/\/+$/, ''),
    token: env.ENCODER_TOKEN,
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
    workDir: env.WORK_DIR || '/tmp/avtube-encoder',
    pollMs: Number(env.POLL_INTERVAL_MS) || 10_000,
    maxBytes: 500 * 1024 * 1024,
    once: env.ENCODER_ONCE === '1',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLoop(configFromEnv()).catch((error) => {
    console.error(safeMessage(error));
    process.exit(1);
  });
}
