import React from 'react';
import { Shield, Server, Lock, Trash2, AlertTriangle, Cpu } from 'lucide-react';
import { WorkerCapabilities } from '../server/videoWorker';

interface PrivacyAndArchitectureSectionProps {
  capabilities: WorkerCapabilities | null;
  limits: {
    maxUploadMb: number;
    maxVideoDurationSec: number;
    maxConcurrentJobs: number;
    jobTimeoutSec: number;
    twoMinuteTargetSec: number;
    retentionMinutes: number;
  };
  referenceImageUrl: string;
}

export const PrivacyAndArchitectureSection: React.FC<PrivacyAndArchitectureSectionProps> = ({
  capabilities,
  limits,
  referenceImageUrl,
}) => {
  return (
    <div className="space-y-16 mt-16">
      {/* Section 1: Capabilities & Optical Pipeline Reference */}
      <section id="capabilities" className="scroll-mt-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          <div className="lg:col-span-7 rounded-2xl border border-slate-800/90 bg-[#0B1124]/90 p-7 flex flex-col justify-between">
            <div>
              <p className="text-xs font-medium text-indigo-400 tracking-wide">
                01. Multi-Stage Frame Super-Resolution Pipeline
              </p>
              <h2 className="text-2xl font-bold text-slate-100 mt-2 tracking-tight">
                Genuine Frame Extraction, Batch Upscaling &amp; Audio-Synced Reconstruction
              </h2>
              <p className="text-sm text-slate-300 mt-3 leading-relaxed">
                Rather than altering container metadata headers, Free 4K Video Enhancer decodes the input stream into discrete lossless PNG frames, processes them in bounded batches, and encodes a genuine 3840×2160 H.264 video stream with synchronized original audio.
              </p>

              <div className="mt-6 space-y-4 border-t border-slate-800/80 pt-5">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    01. Binary Signature &amp; Stream Inspection
                  </h3>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    Every upload is verified by inspecting its binary magic bytes (ISO Base Media ftyp, Matroska EBML, or RIFF AVI) and probed via <code className="text-indigo-300">ffprobe</code> using safe argument arrays (<code className="text-indigo-300">shell: false</code>).
                  </p>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    02. Replaceable Real-ESRGAN GPU Worker &amp; Local Optical Fallback
                  </h3>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    When connected to a dedicated GPU worker (<code className="text-indigo-300">realesrgan-ncnn-vulkan</code> or PyTorch <code className="text-indigo-300">realesr-animevideov3</code> / <code className="text-indigo-300">realesrgan-x4plus</code>), frames are upscaled via deep convolutional super-resolution. When running on CPU-only hosts without a GPU worker, the app clearly discloses GPU unavailability and offers a multi-stage FFmpeg optical fallback (Lanczos + 3D temporal-spatial denoising + unsharp contrast pass + mastering EQ).
                  </p>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    03. Aspect-Ratio &amp; Orientation Preservation
                  </h3>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    Landscape 16:9 clips upscale to exact 3840×2160 (4K UHD). Portrait 9:16 videos preserve vertical orientation within 2160×3840 bounds without stretching or cropping.
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-slate-800/80 text-xs text-slate-400 tabular-nums">
              Active FFmpeg Engine: {capabilities?.ffmpegVersion || 'FFmpeg 4.4.2'} · Max Upload: {limits.maxUploadMb} MB · Max Duration: {limits.maxVideoDurationSec}s · Short-Video Target: {limits.twoMinuteTargetSec}s
            </div>
          </div>

          <div className="lg:col-span-5 rounded-2xl border border-slate-800/90 bg-[#0B1124]/90 overflow-hidden flex flex-col justify-between">
            <div className="relative h-64 lg:h-full min-h-[260px] bg-slate-950">
              <img
                src={referenceImageUrl}
                alt="4K UHD optical clarity and micro-contrast reference frame showing an alpine observatory under a starry night sky"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#070B19] via-[#070B19]/40 to-transparent" />
              <div className="absolute bottom-4 left-4 right-4">
                <p className="text-xs font-medium text-indigo-300 tabular-nums">
                  Target Output Specification · 3840×2160 UHD (YUV420p)
                </p>
                <p className="text-sm font-semibold text-white mt-0.5">
                  Honest Optical Disclosure
                </p>
                <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                  Upscaling increases output pixel density and edge definition, but cannot guarantee restoration of every missing original detail from severely compressed sources.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: GPU Worker Setup & Hosting Requirements */}
      <section id="gpu-setup" className="scroll-mt-24 rounded-2xl border border-slate-800/90 bg-[#0B1124]/90 p-7">
        <div className="flex flex-wrap items-start justify-between gap-4 pb-5 border-b border-slate-800">
          <div>
            <p className="text-xs font-medium text-indigo-400 tracking-wide">
              02. Production GPU Worker &amp; Model Configuration
            </p>
            <h2 className="text-2xl font-bold text-slate-100 mt-1 tracking-tight">
              Deploying Real-ESRGAN for Hardware-Accelerated 4K AI Super-Resolution
            </h2>
          </div>
          <div className="text-xs text-slate-300 bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 tabular-nums flex items-center gap-2">
            <Cpu className="w-4 h-4 text-indigo-400" />
            <span>
              Worker Status:{' '}
              {capabilities?.gpuAiAvailable
                ? `Connected (${capabilities.gpuWorkerMode})`
                : 'No GPU Worker Configured (Local FFmpeg Fallback Available)'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">
              Why a Dedicated GPU Worker is Required for Real-ESRGAN
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              Standard CPU-only web hosting and default Cloud Run containers do not include a hardware GPU. Running deep convolutional video super-resolution (such as <code className="text-indigo-300">Real-ESRGAN</code>) on 4K frames requires an NVIDIA Tesla T4 / L4 / A10G or Vulkan-capable GPU worker.
            </p>
            <p className="text-xs text-slate-300 leading-relaxed">
              This repository includes <code className="text-indigo-300">Dockerfile.worker</code> and <code className="text-indigo-300">worker/gpu-worker-server.ts</code> so you can deploy the isolated worker on Cloud Run GPU (NVIDIA L4), RunPod, Modal, or a local workstation with Vulkan/CUDA and connect it via environment variables:
            </p>
            <pre className="p-3.5 rounded-lg bg-[#050814] border border-slate-800 text-xs text-indigo-200 overflow-x-auto font-mono">
{`# Option A: Connect a remote GPU worker container over HTTPS
REAL_ESRGAN_WORKER_URL="https://your-gpu-worker.internal:8080"
WORKER_SHARED_SECRET="your-hmac-shared-secret"
REAL_ESRGAN_MODEL="realesr-animevideov3"

# Option B: Local Vulkan GPU binary on the same machine
REAL_ESRGAN_BIN_PATH="/usr/local/bin/realesrgan-ncnn-vulkan"`}
            </pre>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">
              Supported Open-Source Models &amp; Licensing
            </h3>
            <div className="space-y-2.5 text-xs text-slate-300">
              <div className="p-3 rounded-lg bg-slate-900/70 border border-slate-800/80">
                <div className="font-semibold text-slate-100">
                  Real-ESRGAN (realesr-animevideov3 &amp; realesrgan-x4plus)
                </div>
                <p className="text-slate-400 mt-1">
                  License: BSD 3-Clause License (Xintao Wang / Tencent ARC Lab). Actively maintained via <code className="text-indigo-300">realesrgan-ncnn-vulkan</code> for portable Vulkan GPU execution without heavy Python runtime overhead.
                </p>
              </div>
              <div className="p-3 rounded-lg bg-slate-900/70 border border-slate-800/80">
                <div className="font-semibold text-slate-100">
                  FFmpeg &amp; FFprobe Media Pipeline
                </div>
                <p className="text-slate-400 mt-1">
                  License: LGPL v2.1+ / GPL v2+. Used for demuxing, frame extraction, HQDN3D temporal-spatial denoising, Lanczos optical interpolation, unsharp masking, and AAC audio synchronization.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section 3: Privacy Policy & Security Architecture */}
      <section id="privacy-policy" className="scroll-mt-24 rounded-2xl border border-slate-800/90 bg-[#0B1124]/90 p-7">
        <div className="pb-5 border-b border-slate-800">
          <p className="text-xs font-medium text-indigo-400 tracking-wide">
            03. Privacy Policy, Retention &amp; Security Architecture
          </p>
          <h2 className="text-2xl font-bold text-slate-100 mt-1 tracking-tight">
            Privacy-First Processing &amp; Transparent Security Posture
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mt-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Lock className="w-4 h-4 text-indigo-400 shrink-0" />
              <span>Private Isolated Storage</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Uploaded videos and extracted frames are stored exclusively in non-public server directories (<code className="text-slate-300">0700</code> permissions) keyed by 128-bit cryptographic random job IDs.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Trash2 className="w-4 h-4 text-indigo-400 shrink-0" />
              <span>{limits.retentionMinutes}-Minute Auto-Purge</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              All original uploads, intermediate frame batches, and enhanced outputs are automatically deleted after {limits.retentionMinutes} minutes, on job cancellation, or immediately upon download when enabled.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Shield className="w-4 h-4 text-indigo-400 shrink-0" />
              <span>Zero Third-Party AI Uploads</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Your videos are never sent to external third-party LLM APIs or public cloud buckets. Processing occurs strictly inside the local server or your explicitly configured GPU worker.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Server className="w-4 h-4 text-indigo-400 shrink-0" />
              <span>Command &amp; Path Hardening</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              File signatures are verified via binary magic bytes before probing. FFmpeg is invoked exclusively with <code className="text-slate-300">shell: false</code> argument arrays, and download links require HMAC-SHA256 tokens.
            </p>
          </div>
        </div>

        <div className="mt-6 pt-5 border-t border-slate-800 flex items-start gap-3 text-xs text-slate-400">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="leading-relaxed">
            <strong className="text-slate-200">Security &amp; Operational Disclosure:</strong> No web application can guarantee absolute security or that data leakage is impossible under all circumstances. Overall security depends on underlying host isolation, TLS termination, timely OS/FFmpeg patching, and ongoing infrastructure maintenance. Avoid uploading highly classified or regulated personal data to shared public demo instances.
          </p>
        </div>
      </section>
    </div>
  );
};
