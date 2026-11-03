import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compressionRatio, handleEncoderRequest, outputObjectKey, playbackUrl, isValidOutputPath, nextFailureState,
  pickClaimable, queuedFields, readyFields, servePlayback, tokensEqual, validateCompleteResult,
} from '../src/encoding.js';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

test('output path validation allows only the 480p MP4 and poster', () => {
  for (const ok of ['480p.mp4', 'poster.jpg']) assert.ok(isValidOutputPath(ok), ok);
  for (const bad of ['../480p.mp4', '720p.mp4', 'a.mp4', 'master.m3u8', '480p.mp4/x', '/480p.mp4', '']) assert.ok(!isValidOutputPath(bad), bad);
});

test('token compare', async () => {
  assert.equal(await tokensEqual('abc', 'abc'), true);
  assert.equal(await tokensEqual('abd', 'abc'), false);
  assert.equal(await tokensEqual('', ''), false);
  assert.equal(await tokensEqual(undefined, 'abc'), false);
});

test('queued fields only carry real sizes', () => {
  assert.deepEqual(queuedFields({ size: 1000 }, 5), { encodingStatus: 'processing', encodingQueuedAt: 5, originalFileSize: 1000 });
  assert.equal('originalFileSize' in queuedFields({}, 5), false);
});

test('claim skips leased, non-processing and non-public Reels, oldest first', () => {
  const assets = [{ purpose: 'original', objectKey: 'k' }];
  const base = { mediaType: 'reel', visibility: 'public', encodingStatus: 'processing', assets };
  const records = {
    a: { ...base, createdAt: 3 },
    b: { ...base, createdAt: 1, encodingLeaseUntil: 999 },
    c: { ...base, createdAt: 2, encodingStatus: 'ready' },
    d: { ...base, createdAt: 2, visibility: 'private' },
    e: { ...base, createdAt: 2 },
  };
  assert.equal(pickClaimable(records, 1000).id, 'b');
  assert.equal(pickClaimable(records, 100).id, 'e');
  assert.equal(pickClaimable({ x: { ...base, encodingAttempts: 3 } }, 1), null);
  assert.equal(pickClaimable({}, 1), null);
});

test('failure: retries then marks failed with a sanitized message', () => {
  const first = nextFailureState({}, 'x', 0);
  assert.equal(first.encodingStatus, undefined);
  assert.ok(first.encodingLeaseUntil > 0);
  const last = nextFailureState({ encodingAttempts: 3 }, 'boom https://a.b/c', 0);
  assert.equal(last.encodingStatus, 'failed');
  assert.ok(!last.encodingError.includes('https'));
});

test('compression ratio uses real sizes only', () => {
  assert.equal(compressionRatio(1000, 250), 0.75);
  assert.equal(compressionRatio(undefined, 250), undefined);
  assert.equal(compressionRatio(1000, 0), undefined);
});

test('complete result validation', () => {
  const ok = { qualities: [480], width: 480, height: 854, durationMs: 7000, encodedFileSize: 10 };
  assert.deepEqual(validateCompleteResult(ok).qualities, [480]);
  assert.equal(validateCompleteResult({ ...ok, qualities: [360] }), null);
  assert.equal(validateCompleteResult({ ...ok, width: 1080, height: 1920 }), null);
  assert.equal(validateCompleteResult({ ...ok, qualities: [] }), null);
  assert.equal(validateCompleteResult({ ...ok, qualities: [480, 480] }), null);
  assert.equal(validateCompleteResult({ ...ok, width: -1 }), null);
});

test('readyFields', () => {
  const f = readyFields({
    result: validateCompleteResult({ qualities: [480], width: 480, height: 854, durationMs: 1000, encodedFileSize: 100 }),
    record: { id: 'reel12345', originalFileSize: 400 }, origin: 'https://m.example/', now: 9, posterExists: true,
  });
  assert.equal(f.encodingStatus, 'ready');
  assert.equal(f.playbackUrl, 'https://m.example/v1/r2/playback/reel12345/480p.mp4');
  assert.equal('hlsUrl' in f, false);
  assert.equal(f.compressionRatio, 0.75);
  assert.equal(playbackUrl('https://x', 'r'), 'https://x/v1/r2/playback/r/480p.mp4');
  assert.equal(outputObjectKey('u', 'r', '480p.mp4'), 'users/u/reels/r/480p.mp4');
});

function harness(record, objects = new Set()) {
  const writes = [];
  const claimedBy = new Set();
  const deps = {
    HttpError, corsHeaders: () => ({}),
    jsonResponse: (data, status = 200) => ({ status, data }),
    requestJson: (r) => r.body,
    claimLease: async (_e, id) => { if (claimedBy.has(id)) return false; claimedBy.add(id); return true; },
    createSignedUrl: async (_e, key, method) => `signed:${method}:${key}`,
    databaseRequest: async (_e, path, method = 'GET', value, query) => {
      if (method === 'PATCH') { writes.push(value); return null; }
      if (method === 'PUT') { writes.push({ [path]: value }); return null; }
      if (path === 'publicVideos' && query) return { r1234567: record };
      return record;
    },
  };
  const env = { ENCODER_TOKEN: 't', AVTUBE_MEDIA: { head: async (k) => (objects.has(k) ? { size: 100 } : null), get: async (k) => (objects.has(k) ? { body: 'x', size: 1 } : null) } };
  const req = (body, token = 't') => ({ headers: new Headers({ Authorization: `Bearer ${token}` }), body, url: 'https://w.example/x' });
  return { deps, env, req, writes };
}

const proc = { mediaType: 'reel', visibility: 'public', status: 'published', ownerUid: 'u1', encodingStatus: 'processing', assets: [{ purpose: 'original', objectKey: 'users/u1/reels/reel12345/original' }] };

test('encoder endpoints require the token', async () => {
  const h = harness(proc);
  await assert.rejects(handleEncoderRequest('/v1/encoder/claim', h.req({}, 'bad'), h.env, h.deps), /authorization/i);
});

test('claim returns a signed original URL and leases the Reel', async () => {
  const h = harness(proc);
  const res = await handleEncoderRequest('/v1/encoder/claim', h.req({}), h.env, h.deps);
  assert.equal(res.data.job.reelId, 'r1234567');
  assert.match(res.data.job.original.downloadUrl, /^signed:GET:/);
  assert.ok(Object.keys(h.writes[0])[0].endsWith('encodingAttempts'));
  assert.equal(h.writes[0]['publicVideos/r1234567/encodingAttempts'], 1);
  const again = await handleEncoderRequest('/v1/encoder/claim', h.req({}), h.env, h.deps);
  assert.equal(again.data.job, null, 'a Reel whose lease was already won is not handed out twice');
});

test('upload-urls only signs the MP4/poster with matching content types', async () => {
  const h = harness(proc);
  const ok = await handleEncoderRequest('/v1/encoder/upload-urls', h.req({ reelId: 'reel12345', files: [{ path: '480p.mp4', contentType: 'video/mp4' }] }), h.env, h.deps);
  assert.equal(ok.data.urls['480p.mp4'], 'signed:PUT:users/u1/reels/reel12345/480p.mp4');
  await assert.rejects(handleEncoderRequest('/v1/encoder/upload-urls', h.req({ reelId: 'reel12345', files: [{ path: '../x', contentType: 'x' }] }), h.env, h.deps));
  await assert.rejects(handleEncoderRequest('/v1/encoder/upload-urls', h.req({ reelId: 'reel12345', files: [{ path: '480p.mp4', contentType: 'text/html' }] }), h.env, h.deps));
});

test('complete refuses when the R2 MP4 is missing or the wrong size, succeeds when present', async () => {
  const result = { qualities: [480], width: 480, height: 854, durationMs: 1000, encodedFileSize: 100, originalFileSize: 400 };
  const missing = harness(proc);
  await assert.rejects(handleEncoderRequest('/v1/encoder/complete', missing.req({ reelId: 'reel12345', result }), missing.env, missing.deps), /incomplete/i);
  assert.equal(missing.writes.length, 0);
  const wrong = harness(proc, new Set(['users/u1/reels/reel12345/480p.mp4']));
  await assert.rejects(handleEncoderRequest('/v1/encoder/complete', wrong.req({ reelId: 'reel12345', result: { ...result, encodedFileSize: 99 } }), wrong.env, wrong.deps), /incomplete/i);
  const keys = ['480p.mp4', 'poster.jpg'].map((p) => `users/u1/reels/reel12345/${p}`);
  const h = harness(proc, new Set(keys));
  await handleEncoderRequest('/v1/encoder/complete', h.req({ reelId: 'reel12345', result }), h.env, h.deps);
  const w = h.writes[0];
  assert.equal(w['publicVideos/reel12345/encodingStatus'], 'ready');
  assert.equal(w['mediaReels/u1/reel12345/encodingStatus'], 'ready');
  assert.match(w['publicVideos/reel12345/playbackUrl'], /\/v1\/r2\/playback\/reel12345\/480p\.mp4$/);
  assert.equal(w['publicVideos/reel12345/compressionRatio'], 0.75);
});

test('playback delivery serves only ready public Reels and honours Range', async () => {
  const key = 'users/u1/reels/reel12345/480p.mp4';
  const ready = { ...proc, encodingStatus: 'ready' };
  const h = harness(ready, new Set([key]));
  const path = '/v1/r2/playback/reel12345/480p.mp4';
  const req = { headers: new Headers(), url: `https://w.example${path}` };
  const res = await servePlayback(path, req, h.env, h.deps);
  assert.equal(res.headers.get('Content-Type'), 'video/mp4');
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  h.env.AVTUBE_MEDIA.get = async () => ({ body: 'x', size: 1000, range: { offset: 10, length: 20 } });
  const part = await servePlayback(path, { ...req, headers: new Headers({ Range: 'bytes=10-29' }) }, h.env, h.deps);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('Content-Range'), 'bytes 10-29/1000');
  const h2 = harness(proc, new Set([key]));
  await assert.rejects(servePlayback(path, req, h2.env, h2.deps));
  await assert.rejects(servePlayback('/v1/r2/playback/reel12345/720p.mp4', req, h.env, h.deps));
});
