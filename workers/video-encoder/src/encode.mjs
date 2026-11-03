// Real FFmpeg encoding of one source into a single 480p-class H.264/AAC fast-start MP4 plus a poster.
// Output layout (relative to outDir), mirrored 1:1 in R2: 480p.mp4, poster.jpg
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { PROFILE_480, canRemux, planOutputSize, targetFps } from './playback.mjs';
import { probeVideo, run } from './probe.mjs';

export const ENCODE_TIMEOUT_MS = 20 * 60 * 1000;

export function encodeArgs({ input, output, size, fps, hasAudio, profile = PROFILE_480 }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0?'] : []), '-sn', '-dn', '-map_metadata', '-1',
    '-vf', `scale=${size.width}:${size.height}:flags=lanczos,fps=${fps},format=yuv420p`,
    // Quality-controlled (CRF) H.264 with a bitrate ceiling only to bound worst-case complex scenes.
    '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'main', '-level', '3.1',
    '-crf', String(profile.crf), '-maxrate', `${profile.maxrateKbps}k`, '-bufsize', `${profile.bufsizeKbps}k`,
    '-g', String(Math.round(fps * 2)),
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', `${profile.audioKbps}k`, '-ac', '2', '-ar', '44100'] : ['-an']),
    '-movflags', '+faststart', '-f', 'mp4', output,
  ];
}

export function remuxArgs({ input, output, hasAudio }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0?'] : []), '-sn', '-dn',
    '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output,
  ];
}

/** Re-probes the produced file so the reported facts describe the real output, not the plan. */
export async function verifyOutput(file, { ffmpeg, ffprobe, expectAudio, sourceDurationSec }) {
  const out = await probeVideo(file, { ffmpeg, ffprobe });
  if (out.videoCodec && out.videoCodec !== 'h264') throw new Error('Output is not H.264.');
  if (expectAudio && !out.hasAudio) throw new Error('Output lost its audio track.');
  if (Math.abs(out.durationSec - sourceDurationSec) > Math.max(1, sourceDurationSec * 0.05)) {
    throw new Error('Output duration does not match the source.');
  }
  return out;
}

export async function encodeToMp4({ input, outDir, ffmpeg = 'ffmpeg', ffprobe, timeoutMs = ENCODE_TIMEOUT_MS }) {
  const source = await probeVideo(input, { ffmpeg, ffprobe });
  if (!(source.durationSec > 0)) throw new Error('The video has no readable duration.');
  const profile = PROFILE_480;
  const size = planOutputSize(source, profile);
  const remux = canRemux(source, profile);
  await mkdir(outDir, { recursive: true });
  const output = path.join(outDir, profile.file);

  const args = remux
    ? remuxArgs({ input, output, hasAudio: source.hasAudio })
    : encodeArgs({ input, output, size, fps: targetFps(source.fps), hasAudio: source.hasAudio, profile });
  const { code, stderr } = await run(ffmpeg, args, { timeoutMs });
  if (code !== 0) throw new Error(`Encoding ${profile.quality}p failed: ${stderr.trim().split('\n').slice(-2).join(' ')}`);

  const { size: bytes } = await stat(output);
  if (!(bytes > 0)) throw new Error('Encoder produced an empty file.');
  const probed = await verifyOutput(output, { ffmpeg, ffprobe, expectAudio: source.hasAudio, sourceDurationSec: source.durationSec });
  if (probed.width !== size.width || probed.height !== size.height) {
    throw new Error(`Output is ${probed.width}x${probed.height}, expected ${size.width}x${size.height}.`);
  }

  const poster = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(0.5, source.durationSec / 2)), '-i', input,
    '-frames:v', '1', '-vf', "scale=w='min(720,iw)':h=-2", '-q:v', '3', path.join(outDir, 'poster.jpg'),
  ], { timeoutMs: 60_000 });
  if (poster.code !== 0) throw new Error('Poster generation failed.');

  return {
    width: probed.width,
    height: probed.height,
    durationMs: Math.round(probed.durationSec * 1000),
    hasAudio: probed.hasAudio,
    qualities: [profile.quality],
    encodedFileSize: bytes,
    mode: remux ? 'remux' : 'encode',
    source: { width: source.width, height: source.height, durationSec: source.durationSec, videoCodec: source.videoCodec },
  };
}

export async function listFiles(root, rel = '') {
  const out = [];
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listFiles(root, next));
    else out.push(next);
  }
  return out;
}
