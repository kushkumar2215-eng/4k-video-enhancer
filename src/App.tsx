/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Upload,
  Film,
  Download,
  XCircle,
  RefreshCw,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Lock,
  Cpu,
  Sliders,
} from 'lucide-react';
import {
  AspectHandlingMode,
  EnhancementOptions,
  ProcessingEngineMode,
  TargetDimensionsResult,
  TargetResolutionPreset,
  VideoMediaMetadata,
  calculateTargetDimensions,
  estimateProcessingTime,
} from './shared/videoEnhancerLogic';
import { JobProgressUpdate, WorkerCapabilities } from './server/videoWorker';
import { BeforeAfterVideoComparison } from './components/BeforeAfterVideoComparison';
import { PrivacyAndArchitectureSection } from './components/PrivacyAndArchitectureSection';

const REFERENCE_IMAGE_URL =
  '/src/assets/images/reference_4k_cinema_frame_1793266052322.jpg';

interface SystemLimits {
  maxUploadMb: number;
  maxVideoDurationSec: number;
  maxConcurrentJobs: number;
  jobTimeoutSec: number;
  twoMinuteTargetSec: number;
  retentionMinutes: number;
}

interface ActiveJobState {
  jobId: string;
  authToken: string;
  expiresAtMs: number;
  status: 'uploaded' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'deleted';
  inputMetadata: VideoMediaMetadata;
  outputMetadata: VideoMediaMetadata | null;
  progress: JobProgressUpdate;
  actualEngineUsed: 'real_esrgan_gpu' | 'ffmpeg_optical_fallback' | null;
  aiModelUsed: string | null;
  processingDurationSec: number | null;
  errorMessage: string | null;
  errorCode: string | null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [capabilities, setCapabilities] = useState<WorkerCapabilities | null>(null);
  const [limits, setLimits] = useState<SystemLimits>({
    maxUploadMb: 80,
    maxVideoDurationSec: 60,
    maxConcurrentJobs: 2,
    jobTimeoutSec: 300,
    twoMinuteTargetSec: 120,
    retentionMinutes: 30,
  });

  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const [job, setJob] = useState<ActiveJobState | null>(null);
  const [targetPreset, setTargetPreset] = useState<TargetResolutionPreset>('4K');
  const [options, setOptions] = useState<EnhancementOptions>({
    aiUpscaling: true,
    denoising: true,
    sharpening: true,
    colorCorrection: true,
    aspectHandling: 'fit',
  });
  const [engineMode, setEngineMode] = useState<ProcessingEngineMode>('ffmpeg_fallback');
  const [deleteAfterDownload, setDeleteAfterDownload] = useState<boolean>(false);

  // Fetch system capabilities and limits on mount
  useEffect(() => {
    fetch('/api/system-status')
      .then((res) => res.json())
      .then((data) => {
        if (data.capabilities) {
          setCapabilities(data.capabilities);
          setEngineMode(data.capabilities.gpuAiAvailable ? 'ai_strict' : 'ffmpeg_fallback');
        }
        if (data.limits) {
          setLimits(data.limits);
        }
      })
      .catch(() => {});
  }, []);

  // Poll job status while processing
  useEffect(() => {
    if (!job || job.status !== 'processing') return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/jobs/${job.jobId}/status?token=${encodeURIComponent(job.authToken)}`
        );
        if (!res.ok) return;
        const data = await res.json();
        setJob((prev) =>
          prev
            ? {
                ...prev,
                status: data.status,
                progress: data.progress || prev.progress,
                outputMetadata: data.outputMetadata ?? prev.outputMetadata,
                actualEngineUsed: data.actualEngineUsed ?? prev.actualEngineUsed,
                aiModelUsed: data.aiModelUsed ?? prev.aiModelUsed,
                processingDurationSec:
                  data.processingDurationSec ?? prev.processingDurationSec,
                errorMessage: data.errorMessage ?? null,
                errorCode: data.errorCode ?? null,
              }
            : null
        );
      } catch {
        // Ignore transient network hiccup during polling
      }
    }, 650);

    return () => clearInterval(interval);
  }, [job?.jobId, job?.status, job?.authToken]);

  const handleFileUpload = async (file: File) => {
    setUploadError(null);
    setStatusNotice(null);

    if (file.size > limits.maxUploadMb * 1024 * 1024) {
      setUploadError(
        `Selected file (${formatBytes(file.size)}) exceeds the maximum upload limit of ${limits.maxUploadMb} MB.`
      );
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('video', file);

      const res = await fetch('/api/jobs/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Video validation failed.');
      }

      initializeJobFromResponse(data);
    } catch (err) {
      setUploadError(
        err instanceof Error
          ? err.message
          : 'Unable to validate and upload the selected video file.'
      );
    } finally {
      setIsUploading(false);
    }
  };

  const handleLoadSampleVideo = async () => {
    setUploadError(null);
    setStatusNotice(null);
    setIsUploading(true);
    try {
      const res = await fetch('/api/jobs/upload-sample', {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load sample 360p video.');
      }
      initializeJobFromResponse(data);
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Unable to load sample 360p video.'
      );
    } finally {
      setIsUploading(false);
    }
  };

  const initializeJobFromResponse = (data: {
    jobId: string;
    authToken: string;
    expiresAtMs: number;
    inputMetadata: VideoMediaMetadata;
    defaultPreset?: TargetResolutionPreset;
    defaultOptions?: EnhancementOptions;
    defaultEngineMode?: ProcessingEngineMode;
  }) => {
    const preset = data.defaultPreset || '4K';
    setTargetPreset(preset);
    if (data.defaultOptions) {
      setOptions(data.defaultOptions);
    }
    if (data.defaultEngineMode) {
      setEngineMode(data.defaultEngineMode);
    }
    setJob({
      jobId: data.jobId,
      authToken: data.authToken,
      expiresAtMs: data.expiresAtMs,
      status: 'uploaded',
      inputMetadata: data.inputMetadata,
      outputMetadata: null,
      progress: {
        stage: 'queued',
        stageDetail: 'Validated and ready for enhancement.',
        progressPercent: 0,
        processedFrames: 0,
        totalFrames: Math.max(
          1,
          Math.ceil(data.inputMetadata.durationSec * data.inputMetadata.fps)
        ),
        currentBatch: 0,
        totalBatches: 1,
        estimatedRemainingSec: null,
        elapsedSec: 0,
      },
      actualEngineUsed: null,
      aiModelUsed: null,
      processingDurationSec: null,
      errorMessage: null,
      errorCode: null,
    });
  };

  const handleStartProcessing = async (overrideEngineMode?: ProcessingEngineMode) => {
    if (!job) return;
    setUploadError(null);
    setStatusNotice(null);

    const modeToUse = overrideEngineMode || engineMode;
    if (overrideEngineMode) {
      setEngineMode(overrideEngineMode);
    }

    try {
      const res = await fetch(`/api/jobs/${job.jobId}/process`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Job-Token': job.authToken,
        },
        body: JSON.stringify({
          targetPreset,
          options,
          engineMode: modeToUse,
          deleteAfterDownload,
        }),
      });

      const data = await res.json();
      if (!res.ok || data.started === false || data.status === 'failed') {
        setJob((prev) =>
          prev
            ? {
                ...prev,
                status: 'failed',
                errorMessage: data.error || 'Unable to start enhancement job.',
                errorCode: data.errorCode || 'START_FAILED',
              }
            : null
        );
        return;
      }

      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: 'processing',
              outputMetadata: null,
              errorMessage: null,
              errorCode: null,
              progress: data.progress || prev.progress,
            }
          : null
      );
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Network error starting processing job.'
      );
    }
  };

  const handleCancelProcessing = async () => {
    if (!job) return;
    try {
      const res = await fetch(`/api/jobs/${job.jobId}/cancel`, {
        method: 'POST',
        headers: {
          'X-Job-Token': job.authToken,
        },
      });
      const data = await res.json();
      if (res.ok) {
        setJob((prev) =>
          prev
            ? {
                ...prev,
                status: 'cancelled',
                errorMessage: 'Processing cancelled by user.',
                errorCode: 'JOB_CANCELLED',
              }
            : null
        );
        setStatusNotice(data.message || 'Processing cancelled.');
      }
    } catch {
      // Ignore error
    }
  };

  const handleDeleteJobFiles = async () => {
    if (!job) return;
    try {
      await fetch(`/api/jobs/${job.jobId}`, {
        method: 'DELETE',
        headers: {
          'X-Job-Token': job.authToken,
        },
      });
      setJob(null);
      setStatusNotice(
        'Original and enhanced video files have been permanently deleted from server storage.'
      );
    } catch {
      setJob(null);
    }
  };

  const computedTargetDimensions: TargetDimensionsResult | null = job
    ? calculateTargetDimensions(
        job.inputMetadata.width,
        job.inputMetadata.height,
        targetPreset,
        options.aspectHandling
      )
    : null;

  const computedEstimate = job
    ? estimateProcessingTime({
        durationSec: job.inputMetadata.durationSec,
        fps: job.inputMetadata.fps,
        targetPreset,
        options,
        engineMode,
        gpuWorkerAvailable: Boolean(capabilities?.gpuAiAvailable),
        twoMinuteTargetSec: limits.twoMinuteTargetSec,
      })
    : null;

  const sourceVideoUrl = job
    ? `/api/jobs/${job.jobId}/source-video?token=${encodeURIComponent(job.authToken)}`
    : '';

  const enhancedVideoPreviewUrl =
    job && job.status === 'completed'
      ? `/api/jobs/${job.jobId}/enhanced-video?token=${encodeURIComponent(job.authToken)}`
      : null;

  const enhancedVideoDownloadUrl =
    job && job.status === 'completed'
      ? `/api/jobs/${job.jobId}/enhanced-video?token=${encodeURIComponent(job.authToken)}&download=1`
      : null;

  return (
    <div className="min-h-screen bg-[#070B19] text-slate-100 flex flex-col">
      {/* Top Bar Contract: 3 Zones separated by gap-8 */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-[#070B19]/90 backdrop-blur-md">
        <div className="max-w-[1280px] mx-auto px-6 py-4 flex items-center justify-between gap-8">
          {/* Zone 1: Brand Title (single text element) */}
          <a
            href="#studio"
            className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            Free 4K Video Enhancer
          </a>

          {/* Zone 2: 4 concise single-line navigation links */}
          <nav
            aria-label="Primary Navigation"
            className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-300"
          >
            <a
              href="#studio"
              className="hover:text-white hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Enhancement Studio
            </a>
            <a
              href="#capabilities"
              className="hover:text-white hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Pipeline Architecture
            </a>
            <a
              href="#gpu-setup"
              className="hover:text-white hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              GPU Worker Setup
            </a>
            <a
              href="#privacy-policy"
              className="hover:text-white hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Privacy Policy
            </a>
          </nav>

          {/* Zone 3: 1 primary action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 text-xs font-semibold text-white bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer"
            >
              Select Video File
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main id="studio" className="flex-1 max-w-[1280px] w-full mx-auto px-6 py-10">
        {/* Hero Header */}
        <div className="max-w-3xl">
          <p className="text-xs font-medium text-indigo-400 tracking-wide tabular-nums">
            Open-Source FFmpeg &amp; Real-ESRGAN Super-Resolution Pipeline · Up to 3840×2160 UHD
          </p>
          <h1
            className="mt-2 font-bold tracking-tight text-white"
            style={{
              fontSize: 'clamp(2.25rem, 4vw, 3.5rem)',
              lineHeight: 1.12,
              textWrap: 'balance',
            }}
          >
            Transform Low-Quality Videos into Stunning 4K
          </h1>
          <p className="mt-3 text-base text-slate-300 leading-relaxed max-w-2xl">
            AI-powered video enhancement with privacy-focused processing.
          </p>
          <p className="mt-2 text-xs text-slate-400 tabular-nums">
            No subscription required · No mandatory sign-up · Max upload {limits.maxUploadMb} MB · Max duration {limits.maxVideoDurationSec}s · Automatic {limits.retentionMinutes}-minute file purge
          </p>
        </div>

        {/* Status / Deletion Notice Banner */}
        {statusNotice && (
          <div
            role="status"
            className="mt-6 rounded-xl border border-indigo-500/40 bg-indigo-950/30 px-4 py-3 flex items-center justify-between gap-4 text-xs text-indigo-200"
          >
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0" />
              <span>{statusNotice}</span>
            </div>
            <button
              type="button"
              onClick={() => setStatusNotice(null)}
              className="text-indigo-300 hover:text-white font-medium whitespace-nowrap shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Error Alert */}
        {uploadError && (
          <div
            role="alert"
            className="mt-6 rounded-xl border border-red-500/40 bg-red-950/30 px-4 py-3.5 flex items-start justify-between gap-4 text-xs text-red-200"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-red-100">Validation or Upload Error</div>
                <p className="mt-0.5 text-red-200/90">{uploadError}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setUploadError(null)}
              className="text-red-300 hover:text-white font-medium whitespace-nowrap shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Hidden Native File Input */}
        <input
          ref={fileInputRef}
          id="video-upload-input"
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-msvideo,.mp4,.mov,.webm,.avi"
          className="sr-only"
          aria-label="Upload video file (MP4, MOV, WebM, AVI)"
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (selected) {
              handleFileUpload(selected);
              e.target.value = '';
            }
          }}
        />

        {/* Workspace Grid: Upload / Inspector on Left, Controls & Output on Right */}
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left Column (7 cols): Upload Dropzone, Video Metadata, and Before/After Preview */}
          <div className="lg:col-span-7 space-y-6">
            {/* Large Drag-and-Drop Video Upload Area */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const droppedFile = e.dataTransfer.files?.[0];
                if (droppedFile) {
                  handleFileUpload(droppedFile);
                }
              }}
              className={`rounded-2xl border-2 border-dashed transition-colors p-7 text-center ${
                isDragging
                  ? 'border-indigo-400 bg-indigo-950/30'
                  : 'border-slate-700/80 bg-[#0B1124]/85 hover:border-indigo-500/60'
              }`}
            >
              <div className="mx-auto w-12 h-12 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                <Upload className="w-6 h-6" />
              </div>

              <h2 className="mt-4 text-lg font-semibold text-white">
                Drag and drop your video here, or browse from your device
              </h2>
              <p className="mt-1 text-xs text-slate-400 tabular-nums">
                Supported formats: MP4, MOV, WebM, AVI · Verified via binary file signature &amp; ffprobe · Max {limits.maxUploadMb} MB ({limits.maxVideoDurationSec}s)
              </p>

              <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={isUploading || job?.status === 'processing'}
                  onClick={() => fileInputRef.current?.click()}
                  className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 disabled:opacity-50 text-xs font-semibold text-white transition-all whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {isUploading ? 'Validating Video Stream...' : 'Choose Video File'}
                </button>

                <button
                  type="button"
                  disabled={isUploading || job?.status === 'processing'}
                  onClick={handleLoadSampleVideo}
                  className="px-4 py-2.5 rounded-lg bg-slate-800/90 hover:bg-slate-700/90 border border-slate-700 disabled:opacity-50 text-xs font-medium text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Load 360p Sample Video (640×360 MP4)
                </button>
              </div>

              {/* Privacy Notice Near Upload Button */}
              <div className="mt-5 pt-4 border-t border-slate-800/80 flex items-center justify-center gap-2 text-xs text-slate-400">
                <Lock className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span>
                  Privacy Notice: Videos are processed in isolated private storage, never shared with third-party AI APIs, and automatically deleted within {limits.retentionMinutes} minutes.
                </span>
              </div>
            </div>

            {/* Uploaded Video Metadata Inspector */}
            {job && (
              <div
                className="rounded-2xl border border-slate-800/90 bg-[#0B1124]/90 p-6"
                data-testid="video-metadata-card"
              >
                <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
                  <div className="flex items-center gap-3 min-w-0">
                    <Film className="w-5 h-5 text-indigo-400 shrink-0" />
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-white truncate">
                        {job.inputMetadata.originalFilename}
                      </h3>
                      <p className="text-xs text-slate-400 tabular-nums">
                        Container: {job.inputMetadata.detectedContainer.toUpperCase()} · Codec: {job.inputMetadata.videoCodec.toUpperCase()} · Audio: {job.inputMetadata.hasAudio ? `Yes (${job.inputMetadata.audioCodec?.toUpperCase()})` : 'None'}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleDeleteJobFiles}
                    className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-red-950/50 border border-slate-800 hover:border-red-500/40 text-xs font-medium text-slate-300 hover:text-red-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Files Now
                  </button>
                </div>

                {/* Metadata Grid with Tabular Numerals & Clean Hairline Dividers */}
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4 pt-1 tabular-nums">
                  <div>
                    <div className="text-xs text-slate-400">Original Resolution</div>
                    <div
                      className="text-sm font-semibold text-white mt-0.5"
                      data-testid="detected-input-resolution"
                    >
                      {job.inputMetadata.width}×{job.inputMetadata.height}
                    </div>
                  </div>
                  <div className="sm:border-l sm:border-slate-800/80 sm:pl-4">
                    <div className="text-xs text-slate-400">File Size</div>
                    <div className="text-sm font-semibold text-white mt-0.5">
                      {formatBytes(job.inputMetadata.fileSizeBytes)}
                    </div>
                  </div>
                  <div className="sm:border-l sm:border-slate-800/80 sm:pl-4">
                    <div className="text-xs text-slate-400">Duration</div>
                    <div className="text-sm font-semibold text-white mt-0.5">
                      {job.inputMetadata.durationSec}s
                    </div>
                  </div>
                  <div className="sm:border-l sm:border-slate-800/80 sm:pl-4">
                    <div className="text-xs text-slate-400">Frame Rate</div>
                    <div className="text-sm font-semibold text-white mt-0.5">
                      {job.inputMetadata.fps} fps
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Before & After Comparison Preview or Original Video Preview */}
            {job && computedTargetDimensions && (
              <BeforeAfterVideoComparison
                sourceVideoUrl={sourceVideoUrl}
                enhancedVideoUrl={enhancedVideoPreviewUrl}
                inputMetadata={job.inputMetadata}
                outputMetadata={job.outputMetadata}
                targetDimensions={computedTargetDimensions}
                actualEngineUsed={job.actualEngineUsed}
                aiModelUsed={job.aiModelUsed}
              />
            )}
          </div>

          {/* Right Column (5 cols): Resolution Selector, Enhancement Options, Processing Progress & Download */}
          <div className="lg:col-span-5 space-y-6">
            <div className="rounded-2xl border border-slate-800/90 bg-[#0B1124]/90 p-6 space-y-6">
              <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-800">
                <div className="flex items-center gap-2.5">
                  <Sliders className="w-4 h-4 text-indigo-400" />
                  <h2 className="text-base font-semibold text-white">
                    Enhancement &amp; Output Configuration
                  </h2>
                </div>
                {computedTargetDimensions && (
                  <span
                    className="text-xs font-mono text-indigo-300 tabular-nums"
                    data-testid="target-output-dimensions"
                  >
                    Output: {computedTargetDimensions.outputWidth}×{computedTargetDimensions.outputHeight}
                  </span>
                )}
              </div>

              {/* 1. Output Resolution Selector: 720p, 1080p, 1440p, 4K UHD */}
              <div>
                <label className="block text-xs font-semibold text-slate-200 mb-2.5">
                  Output Resolution Target
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {(
                    [
                      { id: '720p', label: '720p', sub: '1280×720' },
                      { id: '1080p', label: '1080p', sub: '1920×1080' },
                      { id: '1440p', label: '1440p', sub: '2560×1440' },
                      { id: '4K', label: '4K UHD', sub: '3840×2160' },
                    ] as const
                  ).map((preset) => {
                    const active = targetPreset === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        disabled={job?.status === 'processing'}
                        onClick={() => setTargetPreset(preset.id)}
                        className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                          active
                            ? 'border-indigo-500 bg-indigo-600/20 text-white'
                            : 'border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <div className="text-xs font-bold whitespace-nowrap">
                          {preset.label}
                        </div>
                        <div className="text-[11px] text-slate-400 tabular-nums mt-0.5">
                          {preset.sub}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 2. Enhancement Options: AI Upscaling, Denoising, Sharpening, Color Correction */}
              <div>
                <label className="block text-xs font-semibold text-slate-200 mb-2.5">
                  Enhancement Pipeline Stages
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {(
                    [
                      {
                        key: 'aiUpscaling',
                        label: 'AI Upscaling',
                        desc: 'Super-resolution frame pass',
                      },
                      {
                        key: 'denoising',
                        label: 'Denoising',
                        desc: 'Temporal-spatial 3D luma/chroma filter',
                      },
                      {
                        key: 'sharpening',
                        label: 'Sharpening',
                        desc: 'Unsharp optical edge recovery',
                      },
                      {
                        key: 'colorCorrection',
                        label: 'Color Correction',
                        desc: 'Balanced contrast & gamma lift',
                      },
                    ] as const
                  ).map((item) => {
                    const checked = options[item.key];
                    return (
                      <label
                        key={item.key}
                        className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer transition-colors ${
                          checked
                            ? 'border-indigo-500/60 bg-indigo-950/25 text-white'
                            : 'border-slate-800 bg-slate-900/50 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={job?.status === 'processing'}
                          onChange={(e) =>
                            setOptions((prev) => ({
                              ...prev,
                              [item.key]: e.target.checked,
                            }))
                          }
                          className="mt-0.5 accent-indigo-500 rounded"
                        />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold">{item.label}</div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            {item.desc}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* 3. Aspect Ratio & Orientation Handling */}
              <div>
                <label
                  htmlFor="aspect-handling-select"
                  className="block text-xs font-semibold text-slate-200 mb-1.5"
                >
                  Aspect Ratio &amp; Orientation Preservation
                </label>
                <select
                  id="aspect-handling-select"
                  value={options.aspectHandling}
                  disabled={job?.status === 'processing'}
                  onChange={(e) =>
                    setOptions((prev) => ({
                      ...prev,
                      aspectHandling: e.target.value as AspectHandlingMode,
                    }))
                  }
                  className="w-full rounded-lg bg-slate-900 border border-slate-800 px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="fit">
                    Preserve Exact Aspect Ratio &amp; Orientation (No Cropping or Bars)
                  </option>
                  <option value="pad">
                    Pad with Letterbox/Pillarbox to Exact Standard Frame Container
                  </option>
                </select>
              </div>

              {/* 4. Processing Engine Selection & Transparent GPU Disclosure */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                    <Cpu className="w-4 h-4 text-indigo-400" />
                    <span>Inference &amp; Processing Engine</span>
                  </div>
                  <span className="text-[11px] text-slate-400 tabular-nums">
                    {capabilities?.gpuAiAvailable
                      ? 'GPU Worker Connected'
                      : 'CPU Host (No GPU Attached)'}
                  </span>
                </div>

                <div className="space-y-2">
                  <label className="flex items-start gap-2.5 text-xs cursor-pointer">
                    <input
                      type="radio"
                      name="engineMode"
                      value="ai_strict"
                      checked={engineMode === 'ai_strict'}
                      disabled={job?.status === 'processing'}
                      onChange={() => setEngineMode('ai_strict')}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <span className="font-semibold text-slate-100">
                        Real-ESRGAN GPU Worker (Strict AI Super-Resolution)
                      </span>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        Requires a configured GPU worker (<code className="text-indigo-300">realesrgan-ncnn-vulkan</code>). Never fakes AI enhancement if unavailable.
                      </p>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 text-xs cursor-pointer">
                    <input
                      type="radio"
                      name="engineMode"
                      value="ffmpeg_fallback"
                      checked={engineMode === 'ffmpeg_fallback'}
                      disabled={job?.status === 'processing'}
                      onChange={() => setEngineMode('ffmpeg_fallback')}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <span className="font-semibold text-slate-100">
                        Compatible Local FFmpeg Batch Pipeline (Available Now)
                      </span>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        Extracts video frames and runs multi-stage Lanczos optical upscaling, 3D denoising, and unsharp edge recovery on the local server.
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Optional Auto-Delete After Download Checkbox */}
              <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={deleteAfterDownload}
                  disabled={job?.status === 'processing'}
                  onChange={(e) => setDeleteAfterDownload(e.target.checked)}
                  className="accent-indigo-500 rounded"
                />
                <span>
                  Immediately delete original and enhanced files from server after first download
                </span>
              </label>

              {/* Two-Minute Target & Honest ETA Preview */}
              {job && computedEstimate && job.status === 'uploaded' && (
                <div className="rounded-lg bg-slate-900/90 border border-slate-800 px-3.5 py-2.5 text-xs text-slate-300 tabular-nums">
                  <div className="font-medium text-indigo-300">
                    Estimated Processing Time: ~{computedEstimate.estimatedSeconds}s ({computedEstimate.totalFrames} frames)
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {computedEstimate.note}
                  </p>
                </div>
              )}

              {/* Primary Start Enhancement Action Button */}
              {job && job.status !== 'processing' && (
                <button
                  type="button"
                  onClick={() => handleStartProcessing()}
                  className="w-full py-3 px-5 rounded-xl bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-sm font-semibold text-white shadow-lg shadow-indigo-950/50 transition-all cursor-pointer whitespace-nowrap"
                >
                  {job.status === 'completed'
                    ? `Re-Process Video to ${targetPreset === '4K' ? '4K UHD' : targetPreset}`
                    : `Enhance Video to ${targetPreset === '4K' ? '4K UHD (3840×2160)' : targetPreset}`}
                </button>
              )}

              {!job && (
                <div className="rounded-xl border border-slate-800/80 bg-slate-900/40 p-4 text-xs text-slate-400 text-center">
                  Select a video file or click <strong className="text-slate-200">Load 360p Sample Video</strong> to unlock 4K UHD processing controls.
                </div>
              )}
            </div>

            {/* Live Processing Progress Card */}
            {job && job.status === 'processing' && (
              <div
                className="rounded-2xl border border-indigo-500/40 bg-[#0B1124]/95 p-6 space-y-4"
                data-testid="processing-progress-card"
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-white">
                      Enhancing Video Stream ({targetPreset === '4K' ? '4K UHD' : targetPreset})
                    </h3>
                    <p className="text-xs text-indigo-300 mt-0.5">
                      {job.progress.stageDetail}
                    </p>
                  </div>
                  <span className="text-lg font-bold font-mono text-white tabular-nums">
                    {job.progress.progressPercent}%
                  </span>
                </div>

                {/* Progress Bar */}
                <div
                  className="w-full h-2.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800"
                  role="progressbar"
                  aria-valuenow={job.progress.progressPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-blue-400 transition-all duration-300"
                    style={{ width: `${job.progress.progressPercent}%` }}
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 tabular-nums">
                  <span>
                    Frames: {job.progress.processedFrames} / {job.progress.totalFrames} (Batch {job.progress.currentBatch}/{job.progress.totalBatches})
                  </span>
                  <span>
                    Elapsed: {job.progress.elapsedSec}s
                    {job.progress.estimatedRemainingSec !== null
                      ? ` · Est. remaining: ~${job.progress.estimatedRemainingSec}s`
                      : ''}
                  </span>
                </div>

                <div className="pt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={handleCancelProcessing}
                    className="px-4 py-2 rounded-lg bg-red-950/60 hover:bg-red-900/70 border border-red-500/40 text-xs font-semibold text-red-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <XCircle className="w-4 h-4" />
                    Cancel Processing
                  </button>
                </div>
              </div>
            )}

            {/* Failure / Honest GPU Unavailability State with Retry Options */}
            {job && (job.status === 'failed' || job.status === 'cancelled') && (
              <div
                role="alert"
                className="rounded-2xl border border-amber-500/40 bg-amber-950/20 p-6 space-y-4"
                data-testid="job-error-card"
              >
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-sm font-semibold text-amber-100">
                      {job.status === 'cancelled'
                        ? 'Processing Cancelled'
                        : job.errorCode === 'GPU_WORKER_UNAVAILABLE'
                          ? 'Dedicated GPU AI Worker Not Configured'
                          : 'Video Processing Error'}
                    </h3>
                    <p className="text-xs text-amber-200/90 mt-1 leading-relaxed">
                      {job.errorMessage}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  {job.errorCode === 'GPU_WORKER_UNAVAILABLE' && (
                    <button
                      type="button"
                      onClick={() => handleStartProcessing('ffmpeg_fallback')}
                      className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Run with Compatible Local FFmpeg Pipeline
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => handleStartProcessing()}
                    className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry Processing
                  </button>
                </div>
              </div>
            )}

            {/* Completed & Verified Output Card + Prominent Download Button */}
            {job &&
              job.status === 'completed' &&
              job.outputMetadata &&
              enhancedVideoDownloadUrl && (
                <div
                  className="rounded-2xl border border-emerald-500/40 bg-emerald-950/20 p-6 space-y-5"
                  data-testid="completed-download-card"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                      <div>
                        <h3 className="text-base font-bold text-white">
                          Enhancement Complete &amp; Verified
                        </h3>
                        <p className="text-xs text-emerald-200/90 mt-0.5 tabular-nums">
                          Processed in {job.processingDurationSec}s · Engine:{' '}
                          {job.actualEngineUsed === 'real_esrgan_gpu'
                            ? `Real-ESRGAN GPU (${job.aiModelUsed})`
                            : 'Compatible Local FFmpeg Batch Pipeline'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Input vs Output Comparison Metrics with Hairline Divider */}
                  <div className="grid grid-cols-2 gap-4 pt-3 border-t border-emerald-500/25 tabular-nums">
                    <div>
                      <div className="text-[11px] text-slate-400">Original Input</div>
                      <div className="text-sm font-semibold text-slate-200 mt-0.5">
                        {job.inputMetadata.width}×{job.inputMetadata.height}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {formatBytes(job.inputMetadata.fileSizeBytes)}
                      </div>
                    </div>

                    <div className="border-l border-emerald-500/25 pl-4">
                      <div className="text-[11px] text-emerald-300">
                        Verified Output ({targetPreset === '4K' ? '4K UHD' : targetPreset})
                      </div>
                      <div
                        className="text-sm font-bold text-white mt-0.5"
                        data-testid="verified-output-resolution"
                      >
                        {job.outputMetadata.width}×{job.outputMetadata.height}
                      </div>
                      <div className="text-xs text-emerald-300/90 mt-0.5">
                        {formatBytes(job.outputMetadata.fileSizeBytes)}
                      </div>
                    </div>
                  </div>

                  {/* Prominent Download Enhanced Video Button */}
                  <a
                    href={enhancedVideoDownloadUrl}
                    download={job.outputMetadata.sanitizedFilename}
                    data-testid="download-enhanced-video-btn"
                    className="w-full py-3.5 px-5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-sm font-bold text-white flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/50 transition-all whitespace-nowrap"
                  >
                    <Download className="w-4 h-4" />
                    Download Enhanced Video ({job.outputMetadata.width}×{job.outputMetadata.height} MP4)
                  </a>
                </div>
              )}
          </div>
        </div>

        {/* Capabilities, GPU Worker Deployment Guide, and Privacy Policy Sections */}
        <PrivacyAndArchitectureSection
          capabilities={capabilities}
          limits={limits}
          referenceImageUrl={REFERENCE_IMAGE_URL}
        />
      </main>

      {/* Quiet Footer */}
      <footer className="mt-20 border-t border-slate-800/80 bg-[#050814] py-8">
        <div className="max-w-[1280px] mx-auto px-6 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400">
          <div>
            <span className="font-semibold text-slate-200">Free 4K Video Enhancer</span> · Open-Source FFmpeg &amp; Real-ESRGAN Architecture
          </div>
          <div className="flex items-center gap-6">
            <a href="#studio" className="hover:text-slate-200 transition-colors">
              Studio
            </a>
            <a href="#capabilities" className="hover:text-slate-200 transition-colors">
              Pipeline
            </a>
            <a href="#gpu-setup" className="hover:text-slate-200 transition-colors">
              GPU Worker Setup
            </a>
            <a href="#privacy-policy" className="hover:text-slate-200 transition-colors">
              Privacy Policy
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
