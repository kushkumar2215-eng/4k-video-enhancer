import React, { useRef, useState } from 'react';
import { Play, Pause, RotateCcw, Columns, Maximize2, SlidersHorizontal } from 'lucide-react';
import { TargetDimensionsResult, VideoMediaMetadata } from '../shared/videoEnhancerLogic';

interface BeforeAfterVideoComparisonProps {
  sourceVideoUrl: string;
  enhancedVideoUrl: string | null;
  inputMetadata: VideoMediaMetadata;
  outputMetadata: VideoMediaMetadata | null;
  targetDimensions: TargetDimensionsResult;
  actualEngineUsed: 'real_esrgan_gpu' | 'ffmpeg_optical_fallback' | null;
  aiModelUsed: string | null;
}

export const BeforeAfterVideoComparison: React.FC<BeforeAfterVideoComparisonProps> = ({
  sourceVideoUrl,
  enhancedVideoUrl,
  inputMetadata,
  outputMetadata,
  targetDimensions,
  actualEngineUsed,
  aiModelUsed,
}) => {
  const beforeVideoRef = useRef<HTMLVideoElement | null>(null);
  const afterVideoRef = useRef<HTMLVideoElement | null>(null);

  const [splitPercent, setSplitPercent] = useState<number>(50);
  const [viewMode, setViewMode] = useState<'split' | 'side_by_side' | 'enhanced_only'>('split');
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const togglePlayBoth = async () => {
    const vBefore = beforeVideoRef.current;
    const vAfter = afterVideoRef.current;

    if (!vBefore) return;

    if (vBefore.paused) {
      if (vAfter) {
        vAfter.currentTime = vBefore.currentTime;
        vAfter.play().catch(() => {});
      }
      await vBefore.play().catch(() => {});
      setIsPlaying(true);
    } else {
      vBefore.pause();
      if (vAfter) vAfter.pause();
      setIsPlaying(false);
    }
  };

  const restartBoth = () => {
    const vBefore = beforeVideoRef.current;
    const vAfter = afterVideoRef.current;
    if (vBefore) {
      vBefore.currentTime = 0;
    }
    if (vAfter) {
      vAfter.currentTime = 0;
    }
  };

  const handleBeforeTimeUpdate = () => {
    const vBefore = beforeVideoRef.current;
    const vAfter = afterVideoRef.current;
    if (vBefore && vAfter && Math.abs(vBefore.currentTime - vAfter.currentTime) > 0.25) {
      vAfter.currentTime = vBefore.currentTime;
    }
  };

  // If enhanced video is not ready yet, show Original Source Preview with target dimension overlay
  if (!enhancedVideoUrl || !outputMetadata) {
    return (
      <div className="rounded-xl border border-slate-800/90 bg-[#0B1124]/90 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
          <div>
            <h3 className="text-base font-semibold text-slate-100">
              Source Video Preview &amp; Target Frame Geometry
            </h3>
            <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
              Detected Input: {inputMetadata.width}×{inputMetadata.height} ({inputMetadata.orientation}) · {inputMetadata.fps} fps · Target Output: {targetDimensions.outputWidth}×{targetDimensions.outputHeight} ({targetDimensions.targetPreset === '4K' ? '4K UHD' : targetDimensions.targetPreset})
            </p>
          </div>
          <div className="text-xs text-slate-400 tabular-nums">
            Scale Factor: {targetDimensions.scaleFactor}×
          </div>
        </div>

        <div className="mt-4 relative overflow-hidden rounded-lg bg-black border border-slate-800/70 flex items-center justify-center max-h-[420px]">
          <video
            src={sourceVideoUrl}
            controls
            playsInline
            preload="metadata"
            className="max-h-[400px] w-auto max-w-full object-contain"
            aria-label="Original uploaded source video preview"
          />
        </div>
      </div>
    );
  }

  const engineLabel =
    actualEngineUsed === 'real_esrgan_gpu'
      ? `Real-ESRGAN AI (${aiModelUsed || 'realesr-animevideov3'})`
      : 'FFmpeg Optical Pipeline (Lanczos + Filter Pass)';

  return (
    <div
      className="rounded-xl border border-indigo-500/30 bg-[#0B1124]/95 p-5"
      data-testid="before-after-comparison"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <h3 className="text-base font-semibold text-slate-100">
            Before &amp; After Interactive Comparison Preview
          </h3>
          <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
            Original: {inputMetadata.width}×{inputMetadata.height} ({(inputMetadata.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB) · Enhanced: {outputMetadata.width}×{outputMetadata.height} ({(outputMetadata.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB) · {engineLabel}
          </p>
        </div>

        {/* Interactive View Mode Segmented Control */}
        <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-slate-900 border border-slate-800 max-w-full">
          <button
            type="button"
            onClick={() => setViewMode('split')}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
              viewMode === 'split'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Split Slider
          </button>
          <button
            type="button"
            onClick={() => setViewMode('side_by_side')}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
              viewMode === 'side_by_side'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <Columns className="w-3.5 h-3.5" />
            Side by Side
          </button>
          <button
            type="button"
            onClick={() => setViewMode('enhanced_only')}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
              viewMode === 'enhanced_only'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <Maximize2 className="w-3.5 h-3.5" />
            Enhanced Full
          </button>
        </div>
      </div>

      {/* Comparison Stage */}
      {viewMode === 'split' && (
        <div className="mt-4 space-y-4">
          <div className="relative overflow-hidden rounded-lg bg-black border border-slate-800 aspect-video max-h-[460px] w-full mx-auto select-none">
            {/* Underlying Layer: Enhanced 4K/Output Video */}
            <video
              ref={afterVideoRef}
              src={enhancedVideoUrl}
              playsInline
              muted
              loop
              onEnded={() => setIsPlaying(false)}
              className="absolute inset-0 w-full h-full object-contain"
              aria-label="Enhanced output video layer"
            />

            {/* Clipped Foreground Layer: Original Source Video */}
            <div
              className="absolute inset-0 overflow-hidden"
              style={{ clipPath: `inset(0 ${100 - splitPercent}% 0 0)` }}
            >
              <video
                ref={beforeVideoRef}
                src={sourceVideoUrl}
                playsInline
                loop
                onTimeUpdate={handleBeforeTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                className="w-full h-full object-contain"
                aria-label="Original before video layer"
              />
            </div>

            {/* Vertical Split Divider Line */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-indigo-400 pointer-events-none"
              style={{ left: `${splitPercent}%` }}
            >
              <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-8 h-8 rounded-full bg-indigo-600 border-2 border-white flex items-center justify-center shadow-md">
                <SlidersHorizontal className="w-4 h-4 text-white" />
              </div>
            </div>

            {/* Measured contrast scrim overlays for labels */}
            <div className="absolute top-3 left-3 px-2.5 py-1 rounded bg-black/75 text-xs font-medium text-slate-200 pointer-events-none tabular-nums">
              Original ({inputMetadata.width}×{inputMetadata.height})
            </div>
            <div className="absolute top-3 right-3 px-2.5 py-1 rounded bg-black/75 text-xs font-medium text-indigo-200 pointer-events-none tabular-nums">
              Enhanced ({outputMetadata.width}×{outputMetadata.height})
            </div>
          </div>

          {/* Synchronized Playback Controls & Accessible Range Slider */}
          <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-900/80 border border-slate-800/90 rounded-lg px-4 py-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={togglePlayBoth}
                className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {isPlaying ? 'Pause Comparison' : 'Play Synchronized'}
              </button>
              <button
                type="button"
                onClick={restartBoth}
                className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Restart
              </button>
            </div>

            <div className="flex items-center gap-3 flex-1 min-w-[220px] max-w-md">
              <label
                htmlFor="comparison-split-slider"
                className="text-xs font-medium text-slate-300 whitespace-nowrap shrink-0 tabular-nums"
              >
                Split Position ({splitPercent}%)
              </label>
              <input
                id="comparison-split-slider"
                type="range"
                min={0}
                max={100}
                value={splitPercent}
                onChange={(e) => setSplitPercent(Number(e.target.value))}
                className="w-full accent-indigo-500 cursor-pointer"
              />
            </div>
          </div>
        </div>
      )}

      {viewMode === 'side_by_side' && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-lg bg-black border border-slate-800 p-3">
            <div className="text-xs font-medium text-slate-300 mb-2 tabular-nums">
              Before: Original ({inputMetadata.width}×{inputMetadata.height} · {inputMetadata.fps} fps)
            </div>
            <video
              src={sourceVideoUrl}
              controls
              playsInline
              className="w-full max-h-[320px] object-contain rounded"
              aria-label="Original video side by side player"
            />
          </div>
          <div className="rounded-lg bg-black border border-indigo-500/40 p-3">
            <div className="text-xs font-medium text-indigo-300 mb-2 tabular-nums">
              After: Enhanced ({outputMetadata.width}×{outputMetadata.height} · {outputMetadata.fps} fps)
            </div>
            <video
              src={enhancedVideoUrl}
              controls
              playsInline
              className="w-full max-h-[320px] object-contain rounded"
              aria-label="Enhanced video side by side player"
            />
          </div>
        </div>
      )}

      {viewMode === 'enhanced_only' && (
        <div className="mt-4 rounded-lg bg-black border border-indigo-500/40 p-3">
          <div className="text-xs font-medium text-indigo-300 mb-2 tabular-nums">
            Enhanced Output Stream ({outputMetadata.width}×{outputMetadata.height} · Codec: {outputMetadata.videoCodec.toUpperCase()} · Audio: {outputMetadata.hasAudio ? 'Synchronized AAC' : 'Muted/None'})
          </div>
          <video
            src={enhancedVideoUrl}
            controls
            playsInline
            className="w-full max-h-[460px] object-contain rounded"
            aria-label="Enhanced output video full player"
          />
        </div>
      )}
    </div>
  );
};
