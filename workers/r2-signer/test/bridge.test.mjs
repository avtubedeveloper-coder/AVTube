import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchNextEncodingJob, encoderApiUrl, runScheduledEncoderDispatch } from '../src/bridge.js';

test('encoder API URL must be an HTTPS URL without embedded credentials or query values', () => {
  assert.equal(encoderApiUrl('https://avtube.example.workers.dev/'), 'https://avtube.example.workers.dev');
  for (const value of [
    'http://avtube.example.workers.dev',
    'https://user:pass@avtube.example.workers.dev',
    'https://avtube.example.workers.dev/?token=secret',
    '',
  ]) {
    assert.throws(() => encoderApiUrl(value));
  }
});

test('disabled encoder dispatch does not start a Container or claim a job', async () => {
  assert.deepEqual(
    await dispatchNextEncodingJob({ VIDEO_ENCODING_ENABLED: 'false' }),
    { dispatched: false, reason: 'disabled' },
  );
  let waited = false;
  runScheduledEncoderDispatch({ VIDEO_ENCODING_ENABLED: 'false' }, {
    waitUntil() { waited = true; },
  });
  assert.equal(waited, false);
});

test('enabled dispatch requires the shared secret before touching the binding', async () => {
  await assert.rejects(
    dispatchNextEncodingJob({ VIDEO_ENCODING_ENABLED: 'true' }),
    /ENCODER_TOKEN is required/,
  );
});
