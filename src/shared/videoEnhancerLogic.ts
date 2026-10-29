import crypto from 'node:crypto';
import path from 'node:path';

export type TargetResolutionPreset = '720p' | '1080p' | '1440p' | '4K';

export type AspectHandlingMode = 'fit' | 'pad';

export type ProcessingEngineMode = 'ai_strict' | 'ffmpeg_fallback';

export interface EnhancementOptions {
  aiUpscaling: boolean;
  denoising: boolean;
  sharpening: boolean;
  colorCorrection: boolean;
  aspectHandling: AspectHandlingMode;
}

export interface VideoMediaMetadata {
  originalFilename: string;
  sanitizedFilename: string;
  detectedContainer: 'mp4' | 'mov' | 'webm' | 'avi';
  mimeType: string;
  fileSizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  hasAudio: boolean;
  audioCodec: string | null;
  orientation: 'landscape' | 'portrait' | 'square';
}

export interface TargetDimensionsResult {
  targetPreset: TargetResolutionPreset;
  boundingWidth: number;
  boundingHeight: number;
  scaledWidth: number;
  scaledHeight: number;
  outputWidth: number;
  outputHeight: number;
  padX: number;
  padY: number;
  scaleFactor: number;
  recommendedAiScalePass: 2 | 3 | 4;
  orientation: 'landscape' | 'portrait' | 'square';
}

export interface SignatureVerificationResult {
  valid: boolean;
  detectedFormat: 'mp4' | 'mov' | 'webm' | 'avi' | null;
  mimeType: string | null;
  reason?: string;
}

export const RESOLUTION_BOUNDS: Record<
  TargetResolutionPreset,
  { landscapeWidth: number; landscapeHeight: number; label: string }
> = {
  '720p': { landscapeWidth: 1280, landscapeHeight: 720, label: '720p HD (1280×720)' },
  '1080p': { landscapeWidth: 1920, landscapeHeight: 1080, label: '1080p Full HD (1920×1080)' },
  '1440p': { landscapeWidth: 2560, landscapeHeight: 1440, label: '1440p QHD (2560×1440)' },
  '4K': { landscapeWidth: 3840, landscapeHeight: 2160, label: '4K UHD (3840×2160)' },
};

/**
 * Verifies actual binary magic-byte signatures of uploaded video buffers.
 * Never trusts file extensions or client-supplied Content-Type headers alone.
 */
export function verifyVideoSignature(buffer: Uint8Array): SignatureVerificationResult {
  if (!buffer || buffer.length < 12) {
    return {
      valid: false,
      detectedFormat: null,
      mimeType: null,
      reason: 'File header is too short (minimum 12 bytes required for magic-byte inspection).',
    };
  }

  // 1. Check ISO Base Media File Format (MP4 / MOV) -> 'ftyp' at bytes 4..7
  // Or QuickTime movie atoms ('moov', 'wide', 'mdat', 'free') at bytes 4..7
  const boxType = String.fromCharCode(buffer[4], buffer[5], buffer[6], buffer[7]);
  if (boxType === 'ftyp') {
    const majorBrand = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]);
    const disallowedBrands = ['heic', 'heix', 'mif1', 'msf1', 'avif', 'avis'];
    if (disallowedBrands.includes(majorBrand.toLowerCase())) {
      return {
        valid: false,
        detectedFormat: null,
        mimeType: null,
        reason: `Unsupported image container brand "${majorBrand}" disguised as video.`,
      };
    }
    if (majorBrand === 'qt  ') {
      return { valid: true, detectedFormat: 'mov', mimeType: 'video/quicktime' };
    }
    return { valid: true, detectedFormat: 'mp4', mimeType: 'video/mp4' };
  }

  if (boxType === 'moov' || boxType === 'wide') {
    return { valid: true, detectedFormat: 'mov', mimeType: 'video/quicktime' };
  }

  // 2. Check WebM / Matroska EBML header: 0x1A 0x45 0xDF 0xA3 at bytes 0..3
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return { valid: true, detectedFormat: 'webm', mimeType: 'video/webm' };
  }

  // 3. Check AVI (RIFF....AVI ): 'RIFF' at 0..3 and 'AVI ' at 8..11
  const riffTag = String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3]);
  const aviTag = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]);
  if (riffTag === 'RIFF' && (aviTag === 'AVI ' || aviTag === 'AVIX')) {
    return { valid: true, detectedFormat: 'avi', mimeType: 'video/x-msvideo' };
  }

  return {
    valid: false,
    detectedFormat: null,
    mimeType: null,
    reason: 'Unrecognized binary file signature. Only genuine MP4, MOV, WebM, and AVI video files are permitted.',
  };
}

/**
 * Sanitizes an untrusted user filename to prevent path traversal, null-byte injection,
 * shell metacharacter confusion, and hidden dotfile creation.
 */
export function sanitizeFilename(rawName: string): string {
  if (!rawName || typeof rawName !== 'string') {
    return 'video_upload.mp4';
  }
  const withoutDirs = rawName.replace(/\\/g, '/').split('/').pop() || 'video_upload.mp4';
  const cleaned = withoutDirs
    .replace(/[\x00-\x1f\x80-\x9f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);

  return cleaned.length > 0 ? cleaned : 'video_upload.mp4';
}

/**
 * Validates that a job identifier is strictly a 32-character hex token or standard UUID v4.
 */
export function isSafeJobId(jobId: string): boolean {
  if (!jobId || typeof jobId !== 'string') return false;
  return /^[a-f0-9]{32}$/i.test(jobId) || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId);
}

/**
 * Resolves a child path inside the private storage directory and throws if path traversal is attempted.
 */
export function resolveSafeStoragePath(baseDir: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...segments);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Security violation: Path traversal outside private storage root rejected.');
  }
  return resolvedTarget;
}

/**
 * Rounds a dimension to the nearest positive even integer (required for YUV420p H.264 encoding).
 */
export function toEvenDimension(value: number): number {
  const clamped = Math.max(2, Math.round(value));
  return clamped % 2 === 0 ? clamped : clamped + 1;
}

/**
 * Computes exact output dimensions for landscape, portrait, and square videos
 * while preserving original aspect ratio and orientation.
 */
export function calculateTargetDimensions(
  sourceWidth: number,
  sourceHeight: number,
  preset: TargetResolutionPreset,
  aspectHandling: AspectHandlingMode = 'fit'
): TargetDimensionsResult {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('Invalid source video dimensions.');
  }

  const presetBounds = RESOLUTION_BOUNDS[preset];
  if (!presetBounds) {
    throw new Error(`Unsupported target resolution preset: ${String(preset)}`);
  }

  const orientation: 'landscape' | 'portrait' | 'square' =
    sourceWidth > sourceHeight ? 'landscape' : sourceHeight > sourceWidth ? 'portrait' : 'square';

  const boundingWidth =
    orientation === 'portrait'
      ? presetBounds.landscapeHeight
      : orientation === 'square' && aspectHandling === 'fit'
        ? presetBounds.landscapeHeight
        : presetBounds.landscapeWidth;

  const boundingHeight =
    orientation === 'portrait'
      ? presetBounds.landscapeWidth
      : presetBounds.landscapeHeight;

  const scaleX = boundingWidth / sourceWidth;
  const scaleY = boundingHeight / sourceHeight;
  const rawScale = Math.min(scaleX, scaleY);

  const scaledWidth = toEvenDimension(sourceWidth * rawScale);
  const scaledHeight = toEvenDimension(sourceHeight * rawScale);

  const outputWidth = aspectHandling === 'pad' ? toEvenDimension(boundingWidth) : scaledWidth;
  const outputHeight = aspectHandling === 'pad' ? toEvenDimension(boundingHeight) : scaledHeight;

  const padX = aspectHandling === 'pad' ? Math.max(0, Math.floor((outputWidth - scaledWidth) / 2)) : 0;
  const padY = aspectHandling === 'pad' ? Math.max(0, Math.floor((outputHeight - scaledHeight) / 2)) : 0;

  const recommendedAiScalePass: 2 | 3 | 4 = rawScale <= 2 ? 2 : rawScale <= 3 ? 3 : 4;

  return {
    targetPreset: preset,
    boundingWidth,
    boundingHeight,
    scaledWidth,
    scaledHeight,
    outputWidth,
    outputHeight,
    padX,
    padY,
    scaleFactor: Number(rawScale.toFixed(3)),
    recommendedAiScalePass,
    orientation,
  };
}

/**
 * Builds the FFmpeg video filter chain (-vf) string from validated numeric parameters and boolean flags.
 * Never accepts arbitrary user strings.
 */
export function buildFilterChain(
  dims: TargetDimensionsResult,
  options: EnhancementOptions,
  applyFrameScaling: boolean
): string {
  const filters: string[] = [];

  if (options.denoising) {
    filters.push('hqdn3d=1.8:1.4:3.0:2.5');
  }

  if (applyFrameScaling) {
    filters.push(`scale=${dims.scaledWidth}:${dims.scaledHeight}:flags=lanczos+accurate_rnd+full_chroma_int`);
  } else {
    filters.push(`scale=${dims.scaledWidth}:${dims.scaledHeight}:flags=lanczos`);
  }

  if (
    dims.outputWidth !== dims.scaledWidth ||
    dims.outputHeight !== dims.scaledHeight
  ) {
    filters.push(
      `pad=${dims.outputWidth}:${dims.outputHeight}:${dims.padX}:${dims.padY}:color=black`
    );
  }

  if (options.sharpening) {
    filters.push('unsharp=5:5:0.85:3:3:0.35');
  }

  if (options.colorCorrection) {
    filters.push('eq=contrast=1.04:saturation=1.07:gamma=1.02');
  }

  filters.push('format=yuv420p');

  return filters.join(',');
}

/**
 * Builds a safe FFmpeg argument array (never a shell command string) for reconstructing
 * the enhanced video from processed frame sequences and synchronizing original audio.
 */
export function buildReconstructionFfmpegArgs(params: {
  framesPatternPath: string;
  originalVideoPath: string;
  outputVideoPath: string;
  fps: number;
  hasAudio: boolean;
  filterChain: string;
}): string[] {
  const safeFps = Math.max(1, Math.min(120, Number(params.fps.toFixed(3)) || 24));

  const args: string[] = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-framerate',
    String(safeFps),
    '-i',
    params.framesPatternPath,
    '-i',
    params.originalVideoPath,
    '-map',
    '0:v:0',
  ];

  if (params.hasAudio) {
    args.push('-map', '1:a:0?');
  }

  if (params.filterChain && params.filterChain.trim().length > 0) {
    args.push('-vf', params.filterChain);
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '17',
    '-pix_fmt',
    'yuv420p'
  );

  if (params.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
  } else {
    args.push('-an');
  }

  args.push('-movflags', '+faststart', params.outputVideoPath);
  return args;
}

/**
 * Estimates realistic processing time and evaluates eligibility for the configurable 2-minute target.
 */
export function estimateProcessingTime(params: {
  durationSec: number;
  fps: number;
  targetPreset: TargetResolutionPreset;
  options: EnhancementOptions;
  engineMode: ProcessingEngineMode;
  gpuWorkerAvailable: boolean;
  twoMinuteTargetSec?: number;
}): {
  totalFrames: number;
  estimatedSeconds: number;
  withinTwoMinuteTarget: boolean;
  twoMinuteTargetSec: number;
  note: string;
} {
  const twoMinuteTargetSec = params.twoMinuteTargetSec ?? 120;
  const clampedFps = Math.max(1, Math.min(120, params.fps || 24));
  const totalFrames = Math.max(1, Math.ceil(params.durationSec * clampedFps));

  const resolutionMultiplier: Record<TargetResolutionPreset, number> = {
    '720p': 0.35,
    '1080p': 0.6,
    '1440p': 1.0,
    '4K': 1.85,
  };

  const filterOverhead =
    1 +
    (params.options.denoising ? 0.18 : 0) +
    (params.options.sharpening ? 0.14 : 0) +
    (params.options.colorCorrection ? 0.08 : 0);

  const basePerFrameSec =
    params.engineMode === 'ai_strict' && params.gpuWorkerAvailable
      ? 0.14
      : 0.08;

  const rawEstimate =
    3 + totalFrames * basePerFrameSec * resolutionMultiplier[params.targetPreset] * filterOverhead;

  const estimatedSeconds = Math.max(4, Math.ceil(rawEstimate));
  const withinTwoMinuteTarget = estimatedSeconds <= twoMinuteTargetSec;

  const note = withinTwoMinuteTarget
    ? `Eligible for the ${twoMinuteTargetSec}s short-video target (~${estimatedSeconds}s estimated for ${totalFrames} frames).`
    : `Estimated ${estimatedSeconds}s (${totalFrames} frames at ${params.targetPreset}) exceeds the ${twoMinuteTargetSec}s short-video target; processing will continue safely until completion.`;

  return {
    totalFrames,
    estimatedSeconds,
    withinTwoMinuteTarget,
    twoMinuteTargetSec,
    note,
  };
}

/**
 * Generates an HMAC-SHA256 signed authorization token for a job action (status, cancel, download).
 */
export function createJobAuthToken(
  jobId: string,
  secret: string,
  expiresAtMs: number
): string {
  const payload = `${jobId}.${expiresAtMs}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return `${expiresAtMs}.${signature}`;
}

/**
 * Verifies an HMAC-SHA256 signed authorization token in constant time.
 */
export function verifyJobAuthToken(
  jobId: string,
  token: string,
  secret: string,
  nowMs: number = Date.now()
): { valid: boolean; reason?: string } {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, reason: 'Malformed authorization token.' };
  }
  const [expiresStr, providedSig] = token.split('.');
  const expiresAtMs = Number(expiresStr);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
    return { valid: false, reason: 'Invalid token expiration timestamp.' };
  }
  if (nowMs > expiresAtMs) {
    return { valid: false, reason: 'Authorization token has expired.' };
  }

  const expectedPayload = `${jobId}.${expiresAtMs}`;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(expectedPayload)
    .digest('hex');

  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'Invalid token signature.' };
  }

  return { valid: true };
}
