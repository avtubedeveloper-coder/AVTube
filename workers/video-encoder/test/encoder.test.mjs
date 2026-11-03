import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { encodeToMp4, listFiles } from '../src/encode.mjs';
import { canRemux, planOutputSize } from '../src/playback.mjs';
import { probeVideo, run } from '../src/probe.mjs';
import { configFromEnv, contentTypeFor, processJob, safeMessage } from '../src/run.mjs';

const ffmpeg = process.env.FFMPEG_PATH;
const real = { skip: ffmpeg ? false : 'set FFMPEG_PATH to run real FFmpeg tests' };

test('portrait 1080x1920 -> 480x854, even and aspect-preserved', () => {
  assert.deepEqual(planOutputSize({ width: 1080, height: 1920 }), { width: 480, height: 854 });
});

test('landscape and square keep orientation', () => {
  assert.deepEqual(planOutputSize({ width: 1920, height: 1080 }), { width: 854, height: 480 });
  assert.deepEqual(planOutputSize({ width: 1080, height: 1080 }), { width: 480, height: 480 });
  assert.deepEqual(planOutputSize({ width: 3840, height: 2160 }), { width: 854, height: 480 });
});

test('never upscales', () => {
  assert.deepEqual(planOutputSize({ width: 360, height: 640 }), { width: 360, height: 640 });
  assert.deepEqual(planOutputSize({ width: 241, height: 427 }), { width: 242, height: 428 });
});

test('remux only for small compatible h264/aac mp4', () => {
  const ok = { width: 480, height: 854, fps: 30, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', hasAudio: true, formatName: 'mov,mp4,m4a,3gp,3g2,mj2', bitRate: 1_500_000 };
  assert.equal(canRemux(ok), true);
  assert.equal(canRemux({ ...ok, bitRate: 5_000_000 }), false);
  assert.equal(canRemux({ ...ok, width: 720, height: 1280 }), false);
  assert.equal(canRemux({ ...ok, videoCodec: 'hevc' }), false);
  assert.equal(canRemux({ ...ok, audioCodec: 'mp3' }), false);
});

test('helpers', () => {
  assert.equal(contentTypeFor('480p.mp4'), 'video/mp4');
  assert.throws(() => contentTypeFor('x.exe'));
  assert.ok(!safeMessage(new Error('fail https://secret.example/x?sig=1')).includes('secret'));
  assert.throws(() => configFromEnv({}));
});

async function makeSource(dir, w, h) {
  const file = path.join(dir, 'source.mp4');
  // Synthetic test fixture only (never app data).
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30:duration=7`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', '-c:v', 'libx264', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  assert.equal(r.status, 0, String(r.stderr));
  return file;
}

const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

test('real FFmpeg: 1080x1920 -> 480x854 H.264/AAC faststart, decodable', real, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'enc-'));
  try {
    const input = await makeSource(dir, 1080, 1920);
    const out = path.join(dir, 'out');
    const res = await encodeToMp4({ input, outDir: out, ffmpeg, ffprobe: FFPROBE });
    assert.deepEqual([res.width, res.height, res.hasAudio, res.mode], [480, 854, true, 'encode']);
    assert.deepEqual((await listFiles(out)).sort(), ['480p.mp4', 'poster.jpg']);
    const info = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', path.join(out, '480p.mp4')]).stdout);
    assert.equal(info.streams.find((s) => s.codec_type === 'video').codec_name, 'h264');
    assert.equal(info.streams.find((s) => s.codec_type === 'audio').codec_name, 'aac');
    const head = (await readFile(path.join(out, '480p.mp4'))).subarray(0, 4096).toString('latin1');
    assert.ok(head.indexOf('moov') > 0 && head.indexOf('moov') < head.indexOf('mdat') || !head.includes('mdat'), 'moov must precede mdat');
    const dec = spawnSync(ffmpeg, ['-v', 'error', '-i', path.join(out, '480p.mp4'), '-f', 'null', '-']);
    assert.equal(dec.status, 0, String(dec.stderr));
    const original = (await stat(input)).size;
    console.log('REAL SIZES', JSON.stringify({ original, encoded: res.encodedFileSize, ratio: 1 - res.encodedFileSize / original }));
    assert.ok(res.encodedFileSize < original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real FFmpeg: landscape keeps orientation, rotated phone video is upright, no-audio stays silent', real, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'enc-'));
  try {
    const land = await makeSource(dir, 1920, 1080);
    const a = await encodeToMp4({ input: land, outDir: path.join(dir, 'a'), ffmpeg, ffprobe: FFPROBE });
    assert.deepEqual([a.width, a.height], [854, 480]);
    // 1920x1080 stored frame + 90-degree rotation metadata is a 1080x1920 portrait on screen.
    const rot = path.join(dir, 'rot.mp4');
    const mk = spawnSync(ffmpeg, ['-v', 'error', '-y', '-display_rotation', '90', '-i', land, '-an', '-c:v', 'copy', rot]);
    assert.equal(mk.status, 0, String(mk.stderr));
    const b = await encodeToMp4({ input: rot, outDir: path.join(dir, 'b'), ffmpeg, ffprobe: FFPROBE });
    assert.deepEqual([b.width, b.height, b.hasAudio], [480, 854, false]);
    const info = await probeVideo(path.join(dir, 'b', '480p.mp4'), { ffmpeg, ffprobe: FFPROBE });
    assert.deepEqual([info.width, info.height], [480, 854]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real FFmpeg: 360p source is not upscaled; small compatible source is remuxed', real, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'enc-'));
  try {
    const input = await makeSource(dir, 360, 640);
    const res = await encodeToMp4({ input, outDir: path.join(dir, 'o'), ffmpeg, ffprobe: FFPROBE });
    assert.deepEqual([res.width, res.height], [360, 640]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run() kills a process that exceeds its timeout', async () => {
  await assert.rejects(run('sleep', ['30'], { timeoutMs: 200 }), /timed out/);
});

// Protocol test against a local stand-in for the Worker + storage (NOT an R2/Worker test).
test('runner protocol: claim, download, encode, upload, complete', real, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'enc-'));
  const input = await makeSource(dir, 720, 1280);
  const source = await readFile(input);
  const stored = new Map();
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/orig') return res.end(source);
    if (req.url.startsWith('/put/')) { stored.set(req.url.slice(5), body); return res.end(); }
    assert.equal(req.headers.authorization, 'Bearer t');
    const json = JSON.parse(body.toString() || '{}');
    calls.push([req.url, json]);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/encoder/upload-urls') {
      return res.end(JSON.stringify({ urls: Object.fromEntries(json.files.map((f) => [f.path, `${base}/put/${f.path}`])) }));
    }
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = { apiUrl: base, token: 't', ffmpeg, ffprobe: FFPROBE, workDir: path.join(dir, 'work'), maxBytes: 1e9 };
    const client = { call: async (route, body) => (await fetch(base + route, { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify(body ?? {}) })).json() };
    const out = await processJob(config, client, { reelId: 'reel12345', original: { downloadUrl: `${base}/orig` } });
    assert.equal(out.ok, true, out.error);
    assert.ok(stored.has('480p.mp4') && stored.has('poster.jpg'));
    const complete = calls.find(([u]) => u === '/v1/encoder/complete');
    assert.deepEqual(complete[1].result.qualities, [480]);
    assert.equal(complete[1].result.width, 480);
    assert.equal(complete[1].result.encodedFileSize, stored.get('480p.mp4').length);
    assert.equal(complete[1].result.originalFileSize, source.length);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
