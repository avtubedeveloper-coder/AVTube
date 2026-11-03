import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { processJob, safeMessage } from './run.mjs';

const MAX_REQUEST_BYTES = 1024 * 1024;
const REEL_ID = /^[A-Za-z0-9_-]{8,100}$/;

function authorized(request, token) {
  const header = request.headers.authorization ?? '';
  if (!token || !header.startsWith('Bearer ')) return false;
  const provided = createHash('sha256').update(header.slice(7)).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(provided, expected);
}

function validJob(job, apiUrl) {
  if (!job || !REEL_ID.test(job.reelId) || !job.original || typeof job.original.downloadUrl !== 'string') {
    return false;
  }
  try {
    const source = new URL(job.original.downloadUrl);
    return source.protocol === 'https:' &&
      source.hostname.endsWith('.r2.cloudflarestorage.com') &&
      !source.username && !source.password && !source.hash &&
      typeof apiUrl === 'string' && apiUrl.startsWith('https://');
  } catch {
    return false;
  }
}

async function readJson(request) {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) throw new Error('Request body is too large.');
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function respond(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

export function createEncoderServer(config, executeJob = processJob) {
  const activeJobs = new Set();
  return createServer(async (request, response) => {
    if (!authorized(request, config.token)) {
      respond(response, 401, { ok: false, error: 'Encoder authorization failed.' });
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      respond(response, 200, { ok: true, busy: activeJobs.size > 0 });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/jobs') {
      respond(response, 404, { ok: false, error: 'Not found.' });
      return;
    }

    let payload;
    try {
      payload = await readJson(request);
    } catch (error) {
      respond(response, 400, { ok: false, error: safeMessage(error) });
      return;
    }
    const job = payload?.job;
    if (!validJob(job, config.apiUrl)) {
      respond(response, 400, { ok: false, error: 'Invalid encoder job.' });
      return;
    }
    if (activeJobs.has(job.reelId)) {
      respond(response, 202, { ok: true, duplicate: true });
      return;
    }
    if (activeJobs.size > 0) {
      respond(response, 503, { ok: false, error: 'Encoder is busy.' });
      return;
    }

    activeJobs.add(job.reelId);
    respond(response, 202, { ok: true, accepted: true });
    void executeJob(config, { call: async (route, body) => {
      const result = await fetch(`${config.apiUrl}${route}`, {
        method: 'POST',
        headers: {
          Authorization: ['Bearer ', config.token].join(''),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (!result.ok) throw new Error(`Encoder API ${route} responded ${result.status}`);
      return result.json();
    } }, job).then((outcome) => {
      console.log(job.reelId, outcome.ok ? 'encoding completed' : `encoding failed: ${outcome.error}`);
    }).catch((error) => {
      console.error(job.reelId, 'encoder job failed:', safeMessage(error));
    }).finally(() => {
      activeJobs.delete(job.reelId);
    });
  });
}

export function startEncoderServer(env = process.env) {
  const config = {
    apiUrl: env.ENCODER_API_URL?.replace(/\/+$/, ''),
    token: env.ENCODER_TOKEN,
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
    workDir: env.WORK_DIR || '/tmp/avtube-encoder',
    maxBytes: 500 * 1024 * 1024,
  };
  if (!config.apiUrl || !config.token) {
    throw new Error('ENCODER_API_URL and ENCODER_TOKEN are required.');
  }
  const server = createEncoderServer(config);
  server.listen(8080, '0.0.0.0');
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startEncoderServer();
  } catch (error) {
    console.error(safeMessage(error));
    process.exit(1);
  }
}
