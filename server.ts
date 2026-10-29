import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import {
  AspectHandlingMode,
  EnhancementOptions,
  ProcessingEngineMode,
  TargetDimensionsResult,
  TargetResolutionPreset,
  VideoMediaMetadata,
  calculateTargetDimensions,
  createJobAuthToken,
  estimateProcessingTime,
  isSafeJobId,
  resolveSafeStoragePath,
  sanitizeFilename,
  verifyJobAuthToken,
  verifyVideoSignature,
} from './src/shared/videoEnhancerLogic';
import {
  JobProgressUpdate,
  WorkerCapabilities,
  detectWorkerCapabilities,
  ensureSampleLowResVideo,
  probeVideoFile,
  runEnhancementPipeline,
} from './src/server/videoWorker';

dotenv.config();

const PORT = 3000;
const PRIVATE_STORAGE_DIR = path.resolve(
  process.env.PRIVATE_STORAGE_DIR || '/tmp/free-4k-video-enhancer'
);
const JOB_TOKEN_SECRET =
  process.env.JOB_TOKEN_SECRET && process.env.JOB_TOKEN_SECRET.length >= 16
    ? process.env.JOB_TOKEN_SECRET
    : crypto.randomBytes(32).toString('hex');

const MAX_UPLOAD_MB = Math.max(5, Number(process.env.MAX_UPLOAD_MB || 80));
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_VIDEO_DURATION_SEC = Math.max(5, Number(process.env.MAX_VIDEO_DURATION_SEC || 60));
const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 2));
const JOB_TIMEOUT_SEC = Math.max(30, Number(process.env.JOB_TIMEOUT_SEC || 300));
const TWO_MINUTE_TARGET_SEC = Math.max(30, Number(process.env.TWO_MINUTE_TARGET_SEC || 120));
const RETENTION_MINUTES = Math.max(5, Number(process.env.RETENTION_MINUTES || 30));
const RETENTION_MS = RETENTION_MINUTES * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = Math.max(
  5,
  Number(process.env.RATE_LIMIT_MAX_REQUESTS_PER_WINDOW || 30)
);
const RATE_LIMIT_WINDOW_MS =
  Math.max(60, Number(process.env.RATE_LIMIT_WINDOW_SEC || 600)) * 1000;

interface JobRecord {
  jobId: string;
  createdAtMs: number;
  expiresAtMs: number;
  jobDir: string;
  inputVideoPath: string;
  inputMetadata: VideoMediaMetadata;
  status:
    | 'uploaded'
    | 'processing'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'deleted';
  targetPreset: TargetResolutionPreset;
  options: EnhancementOptions;
  engineMode: ProcessingEngineMode;
  targetDimensions: TargetDimensionsResult;
  progress: JobProgressUpdate;
  outputVideoPath: string | null;
  outputMetadata: VideoMediaMetadata | null;
  actualEngineUsed: 'real_esrgan_gpu' | 'ffmpeg_optical_fallback' | null;
  aiModelUsed: string | null;
  processingDurationSec: number | null;
  errorMessage: string | null;
  errorCode: string | null;
  deleteAfterDownload: boolean;
  abortController: AbortController | null;
}

const jobsStore = new Map<string, JobRecord>();
const rateLimitStore = new Map<string, { count: number; resetAtMs: number }>();

let cachedCapabilities: WorkerCapabilities | null = null;

async function getCapabilities(): Promise<WorkerCapabilities> {
  if (!cachedCapabilities) {
    cachedCapabilities = await detectWorkerCapabilities();
  }
  return cachedCapabilities;
}

/**
 * Purges a job's private storage directory and marks the job as deleted.
 */
async function purgeJobFiles(job: JobRecord): Promise<void> {
  if (job.abortController && !job.abortController.signal.aborted) {
    job.abortController.abort();
  }
  job.outputVideoPath = null;
  job.status = 'deleted';
  try {
    await fs.rm(job.jobDir, { recursive: true, force: true });
  } catch {
    // Ignore already removed directory
  }
}

/**
 * Periodic cleanup task to enforce the retention policy (default 30 minutes)
 * and remove abandoned or expired jobs.
 */
async function runRetentionCleanup(): Promise<void> {
  const now = Date.now();
  for (const [jobId, job] of jobsStore.entries()) {
    if (now >= job.expiresAtMs) {
      await purgeJobFiles(job);
      jobsStore.delete(jobId);
    }
  }
}

function getActiveProcessingCount(): number {
  let count = 0;
  for (const job of jobsStore.values()) {
    if (job.status === 'processing') {
      count += 1;
    }
  }
  return count;
}

/**
 * Streams a video file with HTTP Range request support for smooth HTML5 video scrubbing and comparison.
 */
function streamVideoFileWithRange(
  req: Request,
  res: Response,
  filePath: string,
  mimeType: string,
  downloadFilename?: string,
  onStreamFinished?: () => void
): void {
  let stat: fsSync.Stats;
  try {
    stat = fsSync.statSync(filePath);
  } catch {
    res.status(404).json({ error: 'Requested video file is no longer available on disk.' });
    return;
  }

  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType || 'video/mp4');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');

  if (downloadFilename) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizeFilename(downloadFilename)}"`
    );
  }

  if (range && !downloadFilename) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', String(chunkSize));

    const stream = fsSync.createReadStream(filePath, { start, end });
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
  } else {
    res.status(200);
    res.setHeader('Content-Length', String(fileSize));
    const stream = fsSync.createReadStream(filePath);
    if (onStreamFinished) {
      res.on('finish', onStreamFinished);
    }
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
  }
}

async function startServer() {
  await fs.mkdir(PRIVATE_STORAGE_DIR, { recursive: true, mode: 0o700 });
  await getCapabilities();

  // Pre-generate sample low-res 360p video in the background so 1-click testing is instant
  ensureSampleLowResVideo(PRIVATE_STORAGE_DIR).catch(() => {});

  // Run automatic retention cleanup every 60 seconds
  const cleanupTimer = setInterval(() => {
    runRetentionCleanup().catch(() => {});
  }, 60_000);
  cleanupTimer.unref();

  const app = express();
  app.disable('x-powered-by');

  // Security headers middleware
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=()'
    );
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  // Rate limiter middleware for mutating job endpoints
  const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'local';
    const now = Date.now();
    const record = rateLimitStore.get(clientIp);
    if (!record || now > record.resetAtMs) {
      rateLimitStore.set(clientIp, { count: 1, resetAtMs: now + RATE_LIMIT_WINDOW_MS });
      next();
      return;
    }
    if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
      res.status(429).json({
        error: 'Rate limit exceeded. Please wait a few minutes before creating additional video jobs.',
      });
      return;
    }
    record.count += 1;
    next();
  };

  // Configure multer to write uploads directly to a temporary staging directory inside PRIVATE_STORAGE_DIR
  const stagingDir = resolveSafeStoragePath(PRIVATE_STORAGE_DIR, '_staging');
  await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        cb(null, stagingDir);
      },
      filename: (_req, _file, cb) => {
        cb(null, `upload_${crypto.randomBytes(16).toString('hex')}.bin`);
      },
    }),
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
    },
  });

  // 1. System status, worker capabilities, and disclosed hosting/resource limits
  app.get('/api/system-status', async (_req: Request, res: Response) => {
    try {
      const capabilities = await getCapabilities();
      res.json({
        capabilities,
        limits: {
          maxUploadMb: MAX_UPLOAD_MB,
          maxVideoDurationSec: MAX_VIDEO_DURATION_SEC,
          maxConcurrentJobs: MAX_CONCURRENT_JOBS,
          jobTimeoutSec: JOB_TIMEOUT_SEC,
          twoMinuteTargetSec: TWO_MINUTE_TARGET_SEC,
          retentionMinutes: RETENTION_MINUTES,
        },
        activeJobs: getActiveProcessingCount(),
      });
    } catch {
      res.status(500).json({ error: 'Unable to query system capabilities.' });
    }
  });

  // Helper to register a validated video file as a private job
  async function createValidatedJobFromFile(
    tempFilePath: string,
    originalFilename: string,
    keepSourceFile: boolean = false
  ) {
    // Read first 64 bytes for magic-byte signature verification
    const fileHandle = await fs.open(tempFilePath, 'r');
    const headerBuf = Buffer.alloc(64);
    const { bytesRead } = await fileHandle.read(headerBuf, 0, 64, 0);
    await fileHandle.close();

    const sigResult = verifyVideoSignature(headerBuf.subarray(0, bytesRead));
    if (!sigResult.valid || !sigResult.detectedFormat || !sigResult.mimeType) {
      if (!keepSourceFile) await fs.rm(tempFilePath, { force: true }).catch(() => {});
      throw new Error(sigResult.reason || 'Invalid video file signature.');
    }

    const jobId = crypto.randomBytes(16).toString('hex');
    const jobDir = resolveSafeStoragePath(PRIVATE_STORAGE_DIR, jobId);
    await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });

    const sanitizedName = sanitizeFilename(originalFilename);
    const inputVideoPath = resolveSafeStoragePath(
      jobDir,
      `source.${sigResult.detectedFormat}`
    );

    if (keepSourceFile) {
      await fs.copyFile(tempFilePath, inputVideoPath);
    } else {
      await fs.rename(tempFilePath, inputVideoPath);
    }

    // Probe real media streams and metadata using ffprobe
    let metadata: VideoMediaMetadata;
    try {
      metadata = await probeVideoFile(
        inputVideoPath,
        originalFilename,
        sanitizedName,
        sigResult.detectedFormat,
        sigResult.mimeType
      );
    } catch (err) {
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        err instanceof Error
          ? err.message
          : 'Failed to decode video metadata with ffprobe.'
      );
    }

    if (metadata.durationSec > MAX_VIDEO_DURATION_SEC) {
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `Video duration (${metadata.durationSec}s) exceeds the configured free tier limit of ${MAX_VIDEO_DURATION_SEC}s.`
      );
    }

    const defaultPreset: TargetResolutionPreset = '4K';
    const defaultOptions: EnhancementOptions = {
      aiUpscaling: true,
      denoising: true,
      sharpening: true,
      colorCorrection: true,
      aspectHandling: 'fit',
    };

    const capabilities = await getCapabilities();
    const defaultEngineMode: ProcessingEngineMode = capabilities.gpuAiAvailable
      ? 'ai_strict'
      : 'ffmpeg_fallback';

    const targetDimensions = calculateTargetDimensions(
      metadata.width,
      metadata.height,
      defaultPreset,
      defaultOptions.aspectHandling
    );

    const now = Date.now();
    const expiresAtMs = now + RETENTION_MS;
    const authToken = createJobAuthToken(jobId, JOB_TOKEN_SECRET, expiresAtMs);

    const jobRecord: JobRecord = {
      jobId,
      createdAtMs: now,
      expiresAtMs,
      jobDir,
      inputVideoPath,
      inputMetadata: metadata,
      status: 'uploaded',
      targetPreset: defaultPreset,
      options: defaultOptions,
      engineMode: defaultEngineMode,
      targetDimensions,
      progress: {
        stage: 'queued',
        stageDetail: 'Video validated and ready for enhancement.',
        progressPercent: 0,
        processedFrames: 0,
        totalFrames: Math.max(1, Math.ceil(metadata.durationSec * metadata.fps)),
        currentBatch: 0,
        totalBatches: 1,
        estimatedRemainingSec: null,
        elapsedSec: 0,
      },
      outputVideoPath: null,
      outputMetadata: null,
      actualEngineUsed: null,
      aiModelUsed: null,
      processingDurationSec: null,
      errorMessage: null,
      errorCode: null,
      deleteAfterDownload: false,
      abortController: null,
    };

    jobsStore.set(jobId, jobRecord);

    return {
      jobId,
      authToken,
      expiresAtMs,
      inputMetadata: metadata,
      defaultPreset,
      defaultOptions,
      defaultEngineMode,
      targetDimensions,
    };
  }

  // 2. Upload user video file with magic-byte and ffprobe validation
  app.post(
    '/api/jobs/upload',
    rateLimitMiddleware,
    (req: Request, res: Response, next: NextFunction) => {
      upload.single('video')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({
              error: `Uploaded file exceeds the maximum allowed size of ${MAX_UPLOAD_MB} MB.`,
            });
            return;
          }
          res.status(400).json({ error: `Upload error: ${err.message}` });
          return;
        }
        if (err) {
          res.status(400).json({ error: 'Invalid multipart upload request.' });
          return;
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No video file was provided in the upload.' });
        return;
      }

      try {
        const created = await createValidatedJobFromFile(
          file.path,
          file.originalname || 'uploaded_video.mp4',
          false
        );
        res.status(201).json(created);
      } catch (err) {
        await fs.rm(file.path, { force: true }).catch(() => {});
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : 'Video validation failed. Please upload a valid MP4, MOV, WebM, or AVI file.',
        });
      }
    }
  );

  // 3. Load built-in real 360p low-resolution sample MP4 video for instant testing
  app.post('/api/jobs/upload-sample', rateLimitMiddleware, async (_req: Request, res: Response) => {
    try {
      const samplePath = await ensureSampleLowResVideo(PRIVATE_STORAGE_DIR);
      const created = await createValidatedJobFromFile(
        samplePath,
        'sample_360p_observatory.mp4',
        true
      );
      res.status(201).json(created);
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Unable to initialize sample 360p test video.',
      });
    }
  });

  // Middleware to authenticate & authorize job access
  function authenticateJobRequest(req: Request, res: Response): JobRecord | null {
    const rawJobId = String(req.params.jobId || '');
    if (!isSafeJobId(rawJobId)) {
      res.status(400).json({ error: 'Invalid job identifier format.' });
      return null;
    }

    const token =
      (req.headers['x-job-token'] as string) ||
      (req.query.token as string) ||
      '';

    const verification = verifyJobAuthToken(rawJobId, token, JOB_TOKEN_SECRET);
    if (!verification.valid) {
      res.status(403).json({
        error: verification.reason || 'Unauthorized job access token.',
      });
      return null;
    }

    const job = jobsStore.get(rawJobId);
    if (!job || job.status === 'deleted') {
      res.status(404).json({
        error: 'Job not found or temporary video files have already been purged.',
      });
      return null;
    }

    return job;
  }

  // 4. Start enhancement processing job
  app.post('/api/jobs/:jobId/process', rateLimitMiddleware, async (req: Request, res: Response) => {
    const job = authenticateJobRequest(req, res);
    if (!job) return;

    if (job.status === 'processing') {
      res.status(409).json({ error: 'This video job is already currently processing.' });
      return;
    }

    if (getActiveProcessingCount() >= MAX_CONCURRENT_JOBS) {
      res.status(429).json({
        error: `Server is currently running the maximum of ${MAX_CONCURRENT_JOBS} concurrent video enhancement jobs. Please wait for an active job to finish.`,
      });
      return;
    }

    const body = req.body as {
      targetPreset?: TargetResolutionPreset;
      options?: Partial<EnhancementOptions>;
      engineMode?: ProcessingEngineMode;
      deleteAfterDownload?: boolean;
    };

    const allowedPresets: TargetResolutionPreset[] = ['720p', '1080p', '1440p', '4K'];
    const targetPreset: TargetResolutionPreset = allowedPresets.includes(
      body.targetPreset as TargetResolutionPreset
    )
      ? (body.targetPreset as TargetResolutionPreset)
      : '4K';

    const aspectHandling: AspectHandlingMode =
      body.options?.aspectHandling === 'pad' ? 'pad' : 'fit';

    const options: EnhancementOptions = {
      aiUpscaling: body.options?.aiUpscaling !== false,
      denoising: Boolean(body.options?.denoising),
      sharpening: Boolean(body.options?.sharpening),
      colorCorrection: Boolean(body.options?.colorCorrection),
      aspectHandling,
    };

    const engineMode: ProcessingEngineMode =
      body.engineMode === 'ai_strict' ? 'ai_strict' : 'ffmpeg_fallback';

    const capabilities = await getCapabilities();

    // Honest upfront check: if user requests strict GPU AI super-resolution and no GPU worker is configured
    if (engineMode === 'ai_strict' && !capabilities.gpuAiAvailable) {
      job.status = 'failed';
      job.errorCode = 'GPU_WORKER_UNAVAILABLE';
      job.errorMessage =
        'Real-ESRGAN GPU worker is not configured in this environment (REAL_ESRGAN_WORKER_URL / REAL_ESRGAN_BIN_PATH unset). We never fake AI enhancement results. Configure a GPU worker or switch the Engine Mode to "Compatible Local FFmpeg Optical Pipeline" to upscale and enhance using local FFmpeg batch processing.';
      res.status(200).json({
        started: false,
        status: 'failed',
        error: job.errorMessage,
        errorCode: job.errorCode,
        capabilities,
      });
      return;
    }

    const targetDimensions = calculateTargetDimensions(
      job.inputMetadata.width,
      job.inputMetadata.height,
      targetPreset,
      options.aspectHandling
    );

    const timeEstimate = estimateProcessingTime({
      durationSec: job.inputMetadata.durationSec,
      fps: job.inputMetadata.fps,
      targetPreset,
      options,
      engineMode,
      gpuWorkerAvailable: capabilities.gpuAiAvailable,
      twoMinuteTargetSec: TWO_MINUTE_TARGET_SEC,
    });

    const abortController = new AbortController();
    job.targetPreset = targetPreset;
    job.options = options;
    job.engineMode = engineMode;
    job.targetDimensions = targetDimensions;
    job.deleteAfterDownload = Boolean(body.deleteAfterDownload);
    job.status = 'processing';
    job.errorMessage = null;
    job.errorCode = null;
    job.outputVideoPath = null;
    job.outputMetadata = null;
    job.abortController = abortController;
    job.progress = {
      stage: 'extracting_frames',
      stageDetail: 'Initializing private frame extraction pipeline...',
      progressPercent: 2,
      processedFrames: 0,
      totalFrames: timeEstimate.totalFrames,
      currentBatch: 0,
      totalBatches: 1,
      estimatedRemainingSec: timeEstimate.estimatedSeconds,
      elapsedSec: 0,
    };

    // Execute frame-by-frame batch pipeline asynchronously
    runEnhancementPipeline({
      jobDir: job.jobDir,
      inputVideoPath: job.inputVideoPath,
      inputMetadata: job.inputMetadata,
      targetPreset,
      options,
      engineMode,
      capabilities,
      signal: abortController.signal,
      timeoutSec: JOB_TIMEOUT_SEC,
      onProgress: (update) => {
        job.progress = update;
      },
    })
      .then((artifact) => {
        job.status = 'completed';
        job.outputVideoPath = artifact.outputFilePath;
        job.outputMetadata = artifact.outputMetadata;
        job.targetDimensions = artifact.targetDimensions;
        job.actualEngineUsed = artifact.actualEngineUsed;
        job.aiModelUsed = artifact.aiModelUsed;
        job.processingDurationSec = artifact.processingDurationSec;
        job.abortController = null;
      })
      .catch((err) => {
        job.abortController = null;
        if (abortController.signal.aborted) {
          job.status = 'cancelled';
          job.errorCode = 'JOB_CANCELLED';
          job.errorMessage = 'Processing was cancelled by user.';
          job.progress = {
            ...job.progress,
            stage: 'cancelled',
            stageDetail: 'Processing cancelled.',
          };
          return;
        }
        job.status = 'failed';
        const msg =
          err instanceof Error
            ? err.message
            : 'An unexpected error occurred during video processing.';
        job.errorCode = msg.startsWith('GPU_WORKER_UNAVAILABLE')
          ? 'GPU_WORKER_UNAVAILABLE'
          : 'PROCESSING_FAILED';
        job.errorMessage = msg;
        job.progress = {
          ...job.progress,
          stage: 'failed',
          stageDetail: 'Processing failed.',
        };
      });

    res.status(202).json({
      jobId: job.jobId,
      status: job.status,
      targetPreset: job.targetPreset,
      targetDimensions: job.targetDimensions,
      timeEstimate,
      progress: job.progress,
    });
  });

  // 5. Poll live job status, progress, and verified output metadata
  app.get('/api/jobs/:jobId/status', (req: Request, res: Response) => {
    const job = authenticateJobRequest(req, res);
    if (!job) return;

    res.json({
      jobId: job.jobId,
      status: job.status,
      createdAtMs: job.createdAtMs,
      expiresAtMs: job.expiresAtMs,
      inputMetadata: job.inputMetadata,
      targetPreset: job.targetPreset,
      options: job.options,
      engineMode: job.engineMode,
      targetDimensions: job.targetDimensions,
      progress: job.progress,
      outputMetadata: job.outputMetadata,
      actualEngineUsed: job.actualEngineUsed,
      aiModelUsed: job.aiModelUsed,
      processingDurationSec: job.processingDurationSec,
      errorMessage: job.errorMessage,
      errorCode: job.errorCode,
      deleteAfterDownload: job.deleteAfterDownload,
    });
  });

  // 6. Stream original source video for Before/After comparison preview
  app.get('/api/jobs/:jobId/source-video', (req: Request, res: Response) => {
    const job = authenticateJobRequest(req, res);
    if (!job) return;

    streamVideoFileWithRange(
      req,
      res,
      job.inputVideoPath,
      job.inputMetadata.mimeType
    );
  });

  // 7. Stream or download enhanced output video with strict authorization check
  app.get('/api/jobs/:jobId/enhanced-video', (req: Request, res: Response) => {
    const job = authenticateJobRequest(req, res);
    if (!job) return;

    if (job.status !== 'completed' || !job.outputVideoPath || !job.outputMetadata) {
      res.status(409).json({
        error: 'Enhanced video is not yet available. Wait for processing to complete.',
      });
      return;
    }

    const isDownload = req.query.download === '1';
    const downloadFilename = isDownload
      ? job.outputMetadata.sanitizedFilename
      : undefined;

    streamVideoFileWithRange(
      req,
      res,
      job.outputVideoPath,
      'video/mp4',
      downloadFilename,
      () => {
        if (isDownload && job.deleteAfterDownload) {
          purgeJobFiles(job).catch(() => {});
          jobsStore.delete(job.jobId);
        }
      }
    );
  });

  // 8. Cancel an active processing job
  app.post('/api/jobs/:jobId/cancel', async (req: Request, res: Response) => {
    const job = authenticateJobRequest(req, res);
    if (!job) return;

    if (job.abortController && !job.abortController.signal.aborted) {
      job.abortController.abort();
    }
    job.status = 'cancelled';
    job.errorCode = 'JOB_CANCELLED';
    job.errorMessage = 'Processing was cancelled by user.';
    job.progress = {
      ...job.progress,
      stage: 'cancelled',
      stageDetail: 'Processing cancelled by user.',
    };

    res.json({
      jobId: job.jobId,
      status: job.status,
      message: 'Job cancelled and intermediate frames purged.',
    });
  });

  // 9. Immediately delete original and enhanced video files from private server storage
  app.delete('/api/jobs/:jobId', async (req: Request, res: Response) => {
    const job = authenticateJobRequest(req, res);
    if (!job) return;

    await purgeJobFiles(job);
    jobsStore.delete(job.jobId);

    res.json({
      jobId: job.jobId,
      status: 'deleted',
      message: 'Original and enhanced video files have been permanently deleted from server storage.',
    });
  });

  // Vite middleware in development, static assets in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Free 4K Video Enhancer server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
