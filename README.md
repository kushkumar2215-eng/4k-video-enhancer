# Free 4K Video Enhancer

A full-stack, privacy-focused AI video enhancement and 4K UHD (`3840×2160`) super-resolution web application built with React, TypeScript, Express, FFmpeg, and a replaceable `Real-ESRGAN` GPU worker architecture.

---

## 1. Architecture Overview

1. **Frontend (`src/App.tsx`, `src/components/*`)**:
   - Drag-and-drop video uploader supporting `MP4`, `MOV`, `WebM`, and `AVI`, plus a 1-click **Load 360p Sample Video (`640×360` MP4)** option for immediate testing.
   - Real-time media metadata inspector displaying detected resolution, file size, duration, frame rate, container, and audio presence.
   - Output resolution selector (`720p`, `1080p`, `1440p`, `4K UHD 3840×2160`) with orientation and aspect-ratio preservation (`Fit` or `Pad`) for landscape, portrait, and square videos.
   - Enhancement pipeline toggles (`AI Upscaling`, `Denoising`, `Sharpening`, `Color Correction`).
   - Interactive **Before & After Comparison Preview** (synchronized Split Slider, Side-by-Side view, and full-frame output player).
2. **Backend Coordinator (`server.ts`, `src/shared/videoEnhancerLogic.ts`)**:
   - Inspects binary magic-byte signatures (`ftyp`, `EBML`, `RIFF/AVI`) before accepting uploads; never trusts file extensions alone.
   - Probes streams with `ffprobe` (`shell: false`).
   - Signs job status, cancellation, and download URLs using constant-time verified `HMAC-SHA256` tokens (`X-Job-Token` / `token`).
   - Enforces configurable upload size, duration, concurrency, and rate limits, and runs a 60-second background retention cleanup timer.
3. **Isolated Video Processing Worker (`src/server/videoWorker.ts`, `worker/gpu-worker-server.ts`, `Dockerfile.worker`)**:
   - Extracts frames into private per-job directories (`0700` permissions), processes frames in manageable batches, reconstructs the output MP4 (`libx264` `yuv420p` `+faststart`), synchronizes the original audio track, and verifies the resulting output dimensions via `ffprobe`.

---

## 2. Local Development

### Prerequisites
- Node.js 20+
- `ffmpeg` and `ffprobe` installed on `PATH`
- *(Optional for local GPU AI inference)* `realesrgan-ncnn-vulkan` binary on `PATH` or configured via `REAL_ESRGAN_BIN_PATH`

### Commands
```bash
# Install dependencies
npm install

# Run unit and security tests
npm test

# Start full-stack development server on http://localhost:3000
npm run dev

# Build for production
npm run build
```

---

## 3. AI Model Setup, Licenses & GPU Requirements

### Supported Models & Licenses
- **Real-ESRGAN (`realesr-animevideov3`, `realesrgan-x4plus`)**:
  - **License**: BSD 3-Clause License (Copyright Tencent ARC Lab / Xintao Wang).
  - **Runtime**: Executed via `realesrgan-ncnn-vulkan` for portable Vulkan/NVIDIA GPU acceleration without heavy Python runtime overhead.
- **FFmpeg / FFprobe**:
  - **License**: LGPL v2.1+ / GPL v2+.

### Deploying the Dedicated GPU Worker (`Dockerfile.worker`)
Standard serverless CPU containers (including default Cloud Run instances without GPU allocation) do not provide a hardware GPU. To enable hardware-accelerated `Real-ESRGAN` super-resolution in production:

1. Build and deploy `Dockerfile.worker` to a GPU-enabled container platform (e.g., Google Cloud Run with NVIDIA L4 GPU, GKE GPU Node Pool, RunPod, or Modal):
   ```bash
   docker build -f Dockerfile.worker -t free-4k-gpu-worker .
   docker run --gpus all -p 8080:8080 \
     -e WORKER_SHARED_SECRET="your-strong-hmac-secret" \
     free-4k-gpu-worker
   ```
2. Configure the main web application environment variables:
   ```env
   REAL_ESRGAN_WORKER_URL="https://your-gpu-worker.internal:8080"
   WORKER_SHARED_SECRET="your-strong-hmac-secret"
   REAL_ESRGAN_MODEL="realesr-animevideov3"
   ```
3. **Transparent Fallback Behavior**: When no GPU worker is configured, the application never claims fake AI processing. If the user selects `Real-ESRGAN GPU Worker (Strict AI)`, the server honestly reports that no GPU worker is connected and offers the **Compatible Local FFmpeg Batch Pipeline** (Lanczos optical interpolation + HQDN3D 3D temporal-spatial denoising + unsharp contrast recovery + color mastering).

---

## 4. Security Controls, Retention Cleanup & Remaining Risks

- **Binary Signature Verification**: Rejects disguised images (`HEIC`/`AVIF`), scripts, or arbitrary binaries even if renamed with `.mp4`.
- **Command-Injection Prevention**: All `ffmpeg`, `ffprobe`, and `realesrgan-ncnn-vulkan` invocations pass strict argument arrays to `execFile` / `spawn` with `shell: false`.
- **Path Traversal Prevention**: Filenames are sanitized and verified with `path.resolve` prefix checks inside `PRIVATE_STORAGE_DIR`.
- **Automatic Retention Cleanup**: Temporary source files, frame batches, and enhanced outputs are automatically deleted after `RETENTION_MINUTES` (default 30 minutes), on job cancellation, or immediately after download when requested.
- **Remaining Operational Risks**: No system is 100% immune to all vulnerabilities. Security in production depends on keeping OS packages and `ffmpeg` patched against codec CVEs, running the worker under an unprivileged user with cgroup memory/CPU limits, and terminating TLS at a reverse proxy.
