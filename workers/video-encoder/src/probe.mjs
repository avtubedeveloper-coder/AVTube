import { spawn } from 'node:child_process';
import path from 'node:path';

/** Runs a process; a process that exceeds timeoutMs is SIGKILLed and the promise rejects. */
export function run(bin, args, { capture = true, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${path.basename(bin)} timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { if (capture) stdout += d; });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function swapIfRotated(width, height, rotation) {
  return Math.abs(rotation) % 180 === 90 ? { width: height, height: width } : { width, height };
}

/** Parse `ffmpeg -i` stderr (used when ffprobe is not installed). */
export function parseFfmpegInfo(text) {
  const video = text.match(/Stream #\d+:\d+[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
  if (!video) return null;
  const duration = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const fps = text.match(/(\d+(?:\.\d+)?)\s*fps/);
  const rotation = text.match(/rotation of (-?\d+(?:\.\d+)?) degrees/);
  const dims = swapIfRotated(Number(video[1]), Number(video[2]), rotation ? Number(rotation[1]) : 0);
  return {
    ...dims,
    durationSec: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    fps: fps ? Number(fps[1]) : 0,
    hasAudio: /Stream #\d+:\d+[^\n]*Audio:/.test(text),
  };
}

export async function probeVideo(input, { ffmpeg, ffprobe }) {
  if (ffprobe) {
    try {
      const { code, stdout } = await run(
        ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', input],
        { timeoutMs: 60_000 },
      );
      if (code === 0) {
        const data = JSON.parse(stdout);
        const v = data.streams?.find((s) => s.codec_type === 'video');
        if (v) {
          const rotation = Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
          const [num, den] = String(v.avg_frame_rate ?? '0/1').split('/').map(Number);
          const a = data.streams.find((s) => s.codec_type === 'audio');
          return {
            ...swapIfRotated(v.width, v.height, rotation),
            videoCodec: v.codec_name,
            pixFmt: v.pix_fmt,
            audioCodec: a?.codec_name,
            rotation,
            formatName: data.format?.format_name ?? '',
            bitRate: Number(data.format?.bit_rate) || 0,
            durationSec: Number(data.format?.duration ?? v.duration ?? 0),
            fps: den ? num / den : 0,
            hasAudio: data.streams.some((s) => s.codec_type === 'audio'),
          };
        }
      }
    } catch {
      // ffprobe not runnable: fall back to ffmpeg.
    }
  }
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', input], { timeoutMs: 60_000 });
  const info = parseFfmpegInfo(stderr);
  if (!info) throw new Error('The file is not a readable video.');
  return info;
}
