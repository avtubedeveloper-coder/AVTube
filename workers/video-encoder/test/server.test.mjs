import assert from 'node:assert/strict';
import test from 'node:test';

import { createEncoderServer } from '../src/server.mjs';

const TOKEN = 'test-encoder-token';
const API_URL = 'https://avtube.example.workers.dev';

async function withServer(run) {
  const server = createEncoderServer({ token: TOKEN, apiUrl: API_URL }, async () => ({ ok: true }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('container health and job endpoints require the encoder token', async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 401);
    const jobs = await fetch(`${base}/jobs`, { method: 'POST', body: '{}' });
    assert.equal(jobs.status, 401);
  });
});

test('container rejects invalid jobs before running the encoder', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job: { reelId: '../outside', original: { downloadUrl: 'http://127.0.0.1/source' } },
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'Invalid encoder job.' });
  });
});

test('container suppresses duplicate active Reel jobs', async () => {
  let releaseJob;
  let jobStarted;
  const started = new Promise((resolve) => { jobStarted = resolve; });
  const running = new Promise((resolve) => { releaseJob = resolve; });
  let executions = 0;
  const server = createEncoderServer(
    { token: TOKEN, apiUrl: API_URL },
    async () => {
      executions += 1;
      jobStarted();
      await running;
      return { ok: true };
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (reelId = 'reel12345') => fetch(`${base}/jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job: {
        reelId,
        original: { downloadUrl: 'https://account.r2.cloudflarestorage.com/bucket/source?signature=x' },
      },
    }),
  });

  try {
    const first = await request();
    assert.equal(first.status, 202);
    await started;
    const duplicate = await request();
    assert.deepEqual(await duplicate.json(), { ok: true, duplicate: true });
    const competing = await request('reel22345');
    assert.equal(competing.status, 503);
    assert.equal(executions, 1);
  } finally {
    releaseJob();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
