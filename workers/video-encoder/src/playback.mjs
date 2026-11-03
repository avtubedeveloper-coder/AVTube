// Pure planning for the single 480p playback MP4. The output description is a "profile" so that
// 360p/720p (or HLS) can later be added as more profiles without touching the job protocol.

export const PROFILE_480 = {
  quality: 480,
  file: '480p.mp4',
  crf: 23,
  maxrateKbps: 1800,
  bufsizeKbps: 3600,
  audioKbps: 128,
  // Sources already at/below 480p with a bitrate under this are remuxed instead of re-encoded.
  copyMaxTotalKbps: 2200,
};

export const MAX_FPS = 30;

const even = (value) => Math.max(2, Math.round(value / 2) * 2);

/**
 * Output size for a source given in display dimensions (after rotation). The short side becomes
 * min(480, source short side): never upscaled, aspect ratio kept, both sides even.
 */
export function planOutputSize({ width, height }, profile = PROFILE_480) {
  if (!(width > 0) || !(height > 0)) throw new Error('Source dimensions are unknown.');
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const outShort = short <= profile.quality ? even(short) : profile.quality;
  const outLong = short <= profile.quality ? even(long) : even((long * profile.quality) / short);
  return width <= height ? { width: outShort, height: outLong } : { width: outLong, height: outShort };
}

export function targetFps(sourceFps) {
  return sourceFps > 0 ? Math.min(MAX_FPS, sourceFps) : MAX_FPS;
}

/** A source can be remuxed (no re-encode) only if it already is a small, compatible H.264/AAC MP4. */
export function canRemux(source, profile = PROFILE_480) {
  const { width, height } = planOutputSize(source, profile);
  return (
    Math.min(source.width, source.height) <= profile.quality &&
    width === source.width && height === source.height &&
    source.videoCodec === 'h264' && source.pixFmt === 'yuv420p' &&
    (!source.hasAudio || source.audioCodec === 'aac') &&
    /(^|,)mp4(,|$)/.test(source.formatName ?? '') &&
    source.bitRate > 0 && source.bitRate <= profile.copyMaxTotalKbps * 1000 &&
    !(source.fps > MAX_FPS + 0.5)
  );
}
