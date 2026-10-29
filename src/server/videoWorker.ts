import { execFile, spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  EnhancementOptions,
  ProcessingEngineMode,
  TargetDimensionsResult,
  TargetResolutionPreset,
  VideoMediaMetadata,
  buildFilterChain,
  buildReconstructionFfmpegArgs,
  calculateTargetDimensions,
  resolveSafeStoragePath,
} from '../shared/videoEnhancerLogic';

const execFileAsync = promisify(execFile);

export interface WorkerCapabilities {
  gpuAiAvailable: boolean;
  gpuWorkerMode: 'remote_worker' | 'local_ncnn_vulkan' | 'unconfigured';
  aiModelName: string;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ffmpegVersion: string;
  ffmpegFallbackAllowed: boolean;
}

export interface JobProgressUpdate {
  stage:
    | 'queued'
    | 'extracting_frames'
    | 'processing_batches'
    | 'reconstructing_video'
    | 'validating_output'
    | 'completed'
    | 'failed'
    | 'cancelled';
  stageDetail: string;
  progressPercent: number;
  processedFrames: number;
  totalFrames: number;
  currentBatch: number;
  totalBatches: number;
  estimatedRemainingSec: number | null;
  elapsedSec: number;
}

export interface CompletedEnhancementArtifact {
  outputFilePath: string;
  outputMetadata: VideoMediaMetadata;
  targetDimensions: TargetDimensionsResult;
  actualEngineUsed: 'real_esrgan_gpu' | 'ffmpeg_optical_fallback';
  aiModelUsed: string | null;
  totalFramesProcessed: number;
  processingDurationSec: number;
}

/**
 * Checks whether local or remote Real-ESRGAN GPU inference and FFmpeg are available.
 */
export async function detectWorkerCapabilities(): Promise<WorkerCapabilities> {
  const remoteWorkerUrl = (process.env.REAL_ESRGAN_WORKER_URL || '').trim();
  const configuredBinPath = (process.env.REAL_ESRGAN_BIN_PATH || '').trim();
  const aiModelName = (process.env.REAL_ESRGAN_MODEL || 'realesr-animevideov3').trim();
  const ffmpegFallbackAllowed =
    (process.env.ALLOW_FFMPEG_FALLBACK || 'true').toLowerCase() !== 'false';

  let ffmpegAvailable = false;
  let ffprobeAvailable = false;
  let ffmpegVersion = 'unavailable';

  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    ffmpegAvailable = true;
    ffmpegVersion = (stdout.split('\n')[0] || 'FFmpeg').trim();
  } catch {
    ffmpegAvailable = false;
  }

  try {
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000 });
    ffprobeAvailable = true;
  } catch {
    ffprobeAvailable = false;
  }

  let localBinaryAvailable = false;
  const binCandidate = configuredBinPath || 'realesrgan-ncnn-vulkan';
  try {
    await execFileAsync(binCandidate, ['-h'], { timeout: 4000 });
    localBinaryAvailable = true;
  } catch {
    localBinaryAvailable = false;
  }

  if (remoteWorkerUrl.startsWith('http://') || remoteWorkerUrl.startsWith('https://')) {
    return {
      gpuAiAvailable: true,
      gpuWorkerMode: 'remote_worker',
      aiModelName,
      ffmpegAvailable,
      ffprobeAvailable,
      ffmpegVersion,
      ffmpegFallbackAllowed,
    };
  }

  if (localBinaryAvailable) {
    return {
      gpuAiAvailable: true,
      gpuWorkerMode: 'local_ncnn_vulkan',
      aiModelName,
      ffmpegAvailable,
      ffprobeAvailable,
      ffmpegVersion,
      ffmpegFallbackAllowed,
    };
  }

  return {
    gpuAiAvailable: false,
    gpuWorkerMode: 'unconfigured',
    aiModelName,
    ffmpegAvailable,
    ffprobeAvailable,
    ffmpegVersion,
    ffmpegFallbackAllowed,
  };
}

/**
 * Parses FFprobe frame rate strings such as "24000/1001" or "30/1" safely without eval.
 */
function parseFrameRate(rateStr: string | undefined): number {
  if (!rateStr || typeof rateStr !== 'string') return 24;
  if (rateStr.includes('/')) {
    const [numStr, denStr] = rateStr.split('/');
    const num = Number(numStr);
    const den = Number(denStr);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0) {
      return Number((num / den).toFixed(3));
    }
  }
  const direct = Number(rateStr);
  return Number.isFinite(direct) && direct > 0 ? Number(direct.toFixed(3)) : 24;
}

/**
 * Probes a video file using ffprobe with safe argument arrays (shell: false) to extract
 * real width, height, duration, frame rate, and audio stream presence.
 */
export async function probeVideoFile(
  filePath: string,
  originalFilename: string,
  sanitizedFilename: string,
  detectedContainer: 'mp4' | 'mov' | 'webm' | 'avi',
  mimeType: string
): Promise<VideoMediaMetadata> {
  const stat = await fs.stat(filePath);
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate',
      '-of',
      'json',
      filePath,
    ],
    { timeout: 15000 }
  );

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
    }>;
    format?: {
      duration?: string;
      size?: string;
    };
  };

  const streams = parsed.streams || [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  if (!videoStream || !videoStream.width || !videoStream.height) {
    throw new Error('Uploaded file does not contain a valid, decodable video stream.');
  }

  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const width = Number(videoStream.width);
  const height = Number(videoStream.height);
  const fps = parseFrameRate(videoStream.avg_frame_rate !== '0/0' ? videoStream.avg_frame_rate : videoStream.r_frame_rate);
  const durationSec = Math.max(0.2, Number(parsed.format?.duration || 0));

  const orientation: 'landscape' | 'portrait' | 'square' =
    width > height ? 'landscape' : height > width ? 'portrait' : 'square';

  return {
    originalFilename,
    sanitizedFilename,
    detectedContainer,
    mimeType,
    fileSizeBytes: stat.size,
    durationSec: Number(durationSec.toFixed(2)),
    width,
    height,
    fps,
    videoCodec: videoStream.codec_name || 'unknown',
    hasAudio: Boolean(audioStream),
    audioCodec: audioStream?.codec_name || null,
    orientation,
  };
}

/**
 * Spawns a child process using safe argument arrays (shell: false) with cancellation and timeout support.
 */
function runSafeChildProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Job was cancelled by user.'));
      return;
    }

    const child: ChildProcess = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBuf.length < 4096) {
        stderrBuf += chunk.toString('utf8');
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Processing step timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error('Job was cancelled by user.'));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        reject(new Error('Job was cancelled by user.'));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Media processing subprocess exited with code ${code}. ${stderrBuf.slice(0, 300).trim()}`
          )
        );
      }
    });
  });
}

/**
 * Generates a real 360p (640x360) low-resolution sample MP4 video with audio using FFmpeg
 * so users can test end-to-end 4K UHD enhancement immediately or upload their own video.
 */
export async function ensureSampleLowResVideo(storageRoot: string): Promise<string> {
  const sampleDir = resolveSafeStoragePath(storageRoot, '_sample');
  await fs.mkdir(sampleDir, { recursive: true });
  const sampleFilePath = resolveSafeStoragePath(sampleDir, 'sample_360p_observatory.mp4');

  try {
    const stat = await fs.stat(sampleFilePath);
    if (stat.size > 1024) {
      return sampleFilePath;
    }
  } catch {
    // Proceed to generate sample
  }

  // Generate a 2.5-second 640x360 @ 24fps test pattern MP4 with a clean 440Hz harmonic audio tone
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=24:duration=2.5',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100:duration=2.5',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '26',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      sampleFilePath,
    ],
    { timeout: 20000 }
  );

  return sampleFilePath;
}

/**
 * Sends a batch of extracted frames to a configured remote Real-ESRGAN GPU worker over HTTPS/HTTP
 * with HMAC-SHA256 request signing.
 */
async function processBatchWithRemoteGpuWorker(params: {
  workerUrl: string;
  sharedSecret: string;
  modelName: string;
  scalePass: 2 | 3 | 4;
  batchFiles: string[];
  framesInDir: string;
  framesOutDir: string;
  signal: AbortSignal;
}): Promise<void> {
  const framesPayload = await Promise.all(
    params.batchFiles.map(async (filename) => {
      const fullIn = path.join(params.framesInDir, filename);
      const buf = await fs.readFile(fullIn);
      return {
        filename,
        dataBase64: buf.toString('base64'),
      };
    })
  );

  const bodyStr = JSON.stringify({
    model: params.modelName,
    scale: params.scalePass,
    frames: framesPayload,
  });

  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac('sha256', params.sharedSecret || 'worker-secret')
    .update(`${timestamp}.${bodyStr}`)
    .digest('hex');

  const endpoint = `${params.workerUrl.replace(/\/+$/, '')}/v1/upscale-batch`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Timestamp': timestamp,
      'X-Worker-Signature': signature,
    },
    body: bodyStr,
    signal: params.signal,
  });

  if (!response.ok) {
    throw new Error(`Remote GPU worker returned HTTP ${response.status}`);
  }

  const result = (await response.json()) as {
    frames: Array<{ filename: string; dataBase64: string }>;
  };

  if (!result.frames || result.frames.length !== params.batchFiles.length) {
    throw new Error('Remote GPU worker returned incomplete frame batch.');
  }

  await Promise.all(
    result.frames.map(async (frame) => {
      const safeName = path.basename(frame.filename);
      const outPath = path.join(params.framesOutDir, safeName);
      await fs.writeFile(outPath, Buffer.from(frame.dataBase64, 'base64'));
    })
  );
}

/**
 * Executes the complete multi-stage video enhancement pipeline:
 * 1. Extracts frames from the validated input video into a private job directory
 * 2. Processes frames in manageable batches (via Real-ESRGAN GPU worker/binary or explicit FFmpeg optical fallback)
 * 3. Reconstructs the output MP4 preserving aspect ratio and synchronizing original audio
 * 4. Validates the final output file and resolution with ffprobe
 */
export async function runEnhancementPipeline(params: {
  jobDir: string;
  inputVideoPath: string;
  inputMetadata: VideoMediaMetadata;
  targetPreset: TargetResolutionPreset;
  options: EnhancementOptions;
  engineMode: ProcessingEngineMode;
  capabilities: WorkerCapabilities;
  signal: AbortSignal;
  timeoutSec: number;
  onProgress: (update: JobProgressUpdate) => void;
}): Promise<CompletedEnhancementArtifact> {
  const startedAtMs = Date.now();
  const elapsedSec = () => Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));

  // Enforce strict honesty: Never pretend AI super-resolution ran if no GPU worker is configured
  if (params.engineMode === 'ai_strict' && !params.capabilities.gpuAiAvailable) {
    throw new Error(
      'GPU_WORKER_UNAVAILABLE: Real-ESRGAN GPU worker is not configured in this environment. Set REAL_ESRGAN_WORKER_URL or REAL_ESRGAN_BIN_PATH for genuine AI super-resolution, or select the Compatible Local FFmpeg Optical Pipeline fallback.'
    );
  }

  const targetDims = calculateTargetDimensions(
    params.inputMetadata.width,
    params.inputMetadata.height,
    params.targetPreset,
    params.options.aspectHandling
  );

  const framesInDir = resolveSafeStoragePath(params.jobDir, 'frames_in');
  const framesOutDir = resolveSafeStoragePath(params.jobDir, 'frames_out');
  const outputVideoPath = resolveSafeStoragePath(
    params.jobDir,
    `enhanced_${params.targetPreset.toLowerCase()}.mp4`
  );

  await fs.mkdir(framesInDir, { recursive: true });
  await fs.mkdir(framesOutDir, { recursive: true });

  const expectedFrames = Math.max(
    1,
    Math.ceil(params.inputMetadata.durationSec * params.inputMetadata.fps)
  );

  try {
    // STAGE 1: Extract source frames
    params.onProgress({
      stage: 'extracting_frames',
      stageDetail: `Extracting source frames (${params.inputMetadata.width}×${params.inputMetadata.height} @ ${params.inputMetadata.fps} fps)...`,
      progressPercent: 6,
      processedFrames: 0,
      totalFrames: expectedFrames,
      currentBatch: 0,
      totalBatches: 1,
      estimatedRemainingSec: null,
      elapsedSec: elapsedSec(),
    });

    const framesInPattern = path.join(framesInDir, 'frame_%05d.png');
    await runSafeChildProcess(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        params.inputVideoPath,
        '-vsync',
        '0',
        framesInPattern,
      ],
      params.signal,
      params.timeoutSec * 1000
    );

    const extractedFiles = (await fs.readdir(framesInDir))
      .filter((f) => f.startsWith('frame_') && f.endsWith('.png'))
      .sort();

    if (extractedFiles.length === 0) {
      throw new Error('FFmpeg extracted 0 frames from the input video.');
    }

    const totalFrames = extractedFiles.length;
    const batchSize = 18;
    const totalBatches = Math.ceil(totalFrames / batchSize);
    const usingRealEsrgan =
      params.engineMode === 'ai_strict' && params.capabilities.gpuAiAvailable;

    // Build per-batch optical filter chain
    const batchFilterChain = buildFilterChain(
      targetDims,
      params.options,
      !usingRealEsrgan
    );

    const batchProcessingStartMs = Date.now();

    // STAGE 2: Process frames in manageable batches
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      if (params.signal.aborted) {
        throw new Error('Job was cancelled by user.');
      }

      const startIdx = batchIndex * batchSize;
      const batchFiles = extractedFiles.slice(startIdx, startIdx + batchSize);
      const startFrameNumber = startIdx + 1; // 1-indexed frame_%05d.png

      if (usingRealEsrgan) {
        if (params.capabilities.gpuWorkerMode === 'remote_worker') {
          await processBatchWithRemoteGpuWorker({
            workerUrl: process.env.REAL_ESRGAN_WORKER_URL || '',
            sharedSecret: process.env.WORKER_SHARED_SECRET || '',
            modelName: params.capabilities.aiModelName,
            scalePass: targetDims.recommendedAiScalePass,
            batchFiles,
            framesInDir,
            framesOutDir,
            signal: params.signal,
          });
        } else {
          // Local realesrgan-ncnn-vulkan binary execution on batch
          const binPath = (process.env.REAL_ESRGAN_BIN_PATH || 'realesrgan-ncnn-vulkan').trim();
          for (const filename of batchFiles) {
            const inFile = path.join(framesInDir, filename);
            const outFile = path.join(framesOutDir, filename);
            await runSafeChildProcess(
              binPath,
              [
                '-i',
                inFile,
                '-o',
                outFile,
                '-n',
                params.capabilities.aiModelName,
                '-s',
                String(targetDims.recommendedAiScalePass),
                '-f',
                'png',
              ],
              params.signal,
              params.timeoutSec * 1000
            );
          }
        }
      } else {
        // Explicit Compatible Local FFmpeg Optical Batch Pipeline:
        // Upscale & enhance this batch of frames (startFrameNumber .. startFrameNumber + batchFiles.length - 1)
        const framesOutPattern = path.join(framesOutDir, 'frame_%05d.png');
        await runSafeChildProcess(
          'ffmpeg',
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-start_number',
            String(startFrameNumber),
            '-i',
            framesInPattern,
            '-frames:v',
            String(batchFiles.length),
            '-vf',
            batchFilterChain,
            '-start_number',
            String(startFrameNumber),
            framesOutPattern,
          ],
          params.signal,
          params.timeoutSec * 1000
        );
      }

      const processedFrames = Math.min(totalFrames, startIdx + batchFiles.length);
      const batchElapsedMs = Math.max(50, Date.now() - batchProcessingStartMs);
      const msPerFrame = batchElapsedMs / processedFrames;
      const remainingFrames = totalFrames - processedFrames;
      const estimatedRemainingSec = Math.max(
        1,
        Math.ceil((remainingFrames * msPerFrame) / 1000 + 2)
      );

      // Map batch progress into 12% -> 82% of overall pipeline
      const progressPercent = Math.min(
        82,
        Math.round(12 + (processedFrames / totalFrames) * 70)
      );

      params.onProgress({
        stage: 'processing_batches',
        stageDetail: usingRealEsrgan
          ? `Running Real-ESRGAN (${params.capabilities.aiModelName}) on batch ${batchIndex + 1} of ${totalBatches} (${processedFrames}/${totalFrames} frames)...`
          : `Processing optical upscale & filter batch ${batchIndex + 1} of ${totalBatches} (${processedFrames}/${totalFrames} frames -> ${targetDims.outputWidth}×${targetDims.outputHeight})...`,
        progressPercent,
        processedFrames,
        totalFrames,
        currentBatch: batchIndex + 1,
        totalBatches,
        estimatedRemainingSec,
        elapsedSec: elapsedSec(),
      });
    }

    // STAGE 3: Reconstruct video and synchronize original audio
    params.onProgress({
      stage: 'reconstructing_video',
      stageDetail: `Reconstructing ${targetDims.outputWidth}×${targetDims.outputHeight} video & synchronizing audio stream...`,
      progressPercent: 88,
      processedFrames: totalFrames,
      totalFrames,
      currentBatch: totalBatches,
      totalBatches,
      estimatedRemainingSec: 2,
      elapsedSec: elapsedSec(),
    });

    const framesOutPattern = path.join(framesOutDir, 'frame_%05d.png');
    // If Real-ESRGAN ran, apply final exact target dimension fit/pad + optional denoise/sharpen/color filters during reconstruction.
    // If FFmpeg batch pipeline already scaled and filtered the frames, only enforce yuv420p during H.264 reconstruction.
    const reconstructionFilter = usingRealEsrgan ? batchFilterChain : 'format=yuv420p';

    const reconstructArgs = buildReconstructionFfmpegArgs({
      framesPatternPath: framesOutPattern,
      originalVideoPath: params.inputVideoPath,
      outputVideoPath,
      fps: params.inputMetadata.fps,
      hasAudio: params.inputMetadata.hasAudio,
      filterChain: reconstructionFilter,
    });

    await runSafeChildProcess(
      'ffmpeg',
      reconstructArgs,
      params.signal,
      params.timeoutSec * 1000
    );

    // STAGE 4: Validate resulting file and output resolution with ffprobe
    params.onProgress({
      stage: 'validating_output',
      stageDetail: 'Verifying output video stream and 4K/target dimensions with ffprobe...',
      progressPercent: 96,
      processedFrames: totalFrames,
      totalFrames,
      currentBatch: totalBatches,
      totalBatches,
      estimatedRemainingSec: 1,
      elapsedSec: elapsedSec(),
    });

    const outputMetadata = await probeVideoFile(
      outputVideoPath,
      `enhanced_${params.targetPreset}_${params.inputMetadata.sanitizedFilename}.mp4`,
      `enhanced_${params.targetPreset}_${params.inputMetadata.sanitizedFilename}.mp4`,
      'mp4',
      'video/mp4'
    );

    if (
      outputMetadata.width !== targetDims.outputWidth ||
      outputMetadata.height !== targetDims.outputHeight
    ) {
      throw new Error(
        `Output resolution verification failed: expected ${targetDims.outputWidth}×${targetDims.outputHeight}, got ${outputMetadata.width}×${outputMetadata.height}.`
      );
    }

    // Clean up temporary frame directories immediately
    await fs.rm(framesInDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(framesOutDir, { recursive: true, force: true }).catch(() => {});

    const totalSec = Math.max(1, Number(((Date.now() - startedAtMs) / 1000).toFixed(1)));

    params.onProgress({
      stage: 'completed',
      stageDetail: `Enhancement verified (${outputMetadata.width}×${outputMetadata.height}). Ready for download.`,
      progressPercent: 100,
      processedFrames: totalFrames,
      totalFrames,
      currentBatch: totalBatches,
      totalBatches,
      estimatedRemainingSec: 0,
      elapsedSec: Math.round(totalSec),
    });

    return {
      outputFilePath: outputVideoPath,
      outputMetadata,
      targetDimensions: targetDims,
      actualEngineUsed: usingRealEsrgan ? 'real_esrgan_gpu' : 'ffmpeg_optical_fallback',
      aiModelUsed: usingRealEsrgan ? params.capabilities.aiModelName : null,
      totalFramesProcessed: totalFrames,
      processingDurationSec: totalSec,
    };
  } finally {
    // Always purge intermediate frame directories even on failure or cancellation
    await fs.rm(framesInDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(framesOutDir, { recursive: true, force: true }).catch(() => {});
  }
}
