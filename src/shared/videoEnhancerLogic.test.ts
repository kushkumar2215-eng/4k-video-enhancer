import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyVideoSignature,
  sanitizeFilename,
  isSafeJobId,
  resolveSafeStoragePath,
  calculateTargetDimensions,
  buildFilterChain,
  buildReconstructionFfmpegArgs,
  estimateProcessingTime,
  createJobAuthToken,
  verifyJobAuthToken,
} from './videoEnhancerLogic';

test('verifyVideoSignature accepts valid MP4, MOV, WebM, and AVI headers and rejects disguised files', () => {
  const mp4Header = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
  ]);
  const mp4Res = verifyVideoSignature(mp4Header);
  assert.equal(mp4Res.valid, true);
  assert.equal(mp4Res.detectedFormat, 'mp4');

  const movHeader = Buffer.from([
    0x00, 0x00, 0x00, 0x14,
    0x66, 0x74, 0x79, 0x70,
    0x71, 0x74, 0x20, 0x20,
  ]);
  const movRes = verifyVideoSignature(movHeader);
  assert.equal(movRes.valid, true);
  assert.equal(movRes.detectedFormat, 'mov');

  const webmHeader = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3,
    0x9f, 0x42, 0x86, 0x81,
    0x01, 0x42, 0xf7, 0x81,
  ]);
  const webmRes = verifyVideoSignature(webmHeader);
  assert.equal(webmRes.valid, true);
  assert.equal(webmRes.detectedFormat, 'webm');

  const aviHeader = Buffer.from('RIFF\x10\x20\x30\x40AVI LIST', 'binary');
  const aviRes = verifyVideoSignature(aviHeader);
  assert.equal(aviRes.valid, true);
  assert.equal(aviRes.detectedFormat, 'avi');

  const heicHeader = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x68, 0x65, 0x69, 0x63,
  ]);
  const heicRes = verifyVideoSignature(heicHeader);
  assert.equal(heicRes.valid, false);

  const scriptHeader = Buffer.from('#!/bin/bash\nrm -rf /\n', 'utf8');
  const scriptRes = verifyVideoSignature(scriptHeader);
  assert.equal(scriptRes.valid, false);
});

test('sanitizeFilename and resolveSafeStoragePath block path traversal and shell metacharacters', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('..\\..\\Windows\\System32\\cmd.exe'), 'cmd.exe');
  assert.equal(sanitizeFilename('clip; rm -rf * && echo pwned.mp4'), 'clip__rm_-rf______echo_pwned.mp4');
  assert.equal(sanitizeFilename('...hidden.mp4'), 'hidden.mp4');

  assert.equal(isSafeJobId('a1b2c3d4e5f60123456789abcdef0123'), true);
  assert.equal(isSafeJobId('../a1b2c3d4e5f60123456789abcdef0123'), false);
  assert.equal(isSafeJobId('job-123;ls'), false);

  const safePath = resolveSafeStoragePath('/tmp/free-4k-video-enhancer', 'job123', 'input.mp4');
  assert.equal(safePath, '/tmp/free-4k-video-enhancer/job123/input.mp4');

  assert.throws(() => {
    resolveSafeStoragePath('/tmp/free-4k-video-enhancer', '../etc/shadow');
  }, /Path traversal/);
});

test('calculateTargetDimensions outputs exact 3840x2160 for 4K landscape and preserves portrait/square orientation', () => {
  const landscape4K = calculateTargetDimensions(640, 360, '4K', 'fit');
  assert.equal(landscape4K.outputWidth, 3840);
  assert.equal(landscape4K.outputHeight, 2160);
  assert.equal(landscape4K.orientation, 'landscape');

  const portrait4K = calculateTargetDimensions(360, 640, '4K', 'fit');
  assert.equal(portrait4K.outputWidth, 2160);
  assert.equal(portrait4K.outputHeight, 3840);
  assert.equal(portrait4K.orientation, 'portrait');

  const squareFit = calculateTargetDimensions(480, 480, '4K', 'fit');
  assert.equal(squareFit.outputWidth, 2160);
  assert.equal(squareFit.outputHeight, 2160);
  assert.equal(squareFit.orientation, 'square');

  const squarePad = calculateTargetDimensions(480, 480, '4K', 'pad');
  assert.equal(squarePad.outputWidth, 3840);
  assert.equal(squarePad.outputHeight, 2160);
  assert.equal(squarePad.padX, 840);
});

test('buildFilterChain and buildReconstructionFfmpegArgs construct safe argument arrays without shell interpolation', () => {
  const dims = calculateTargetDimensions(640, 360, '4K', 'fit');
  const filterChain = buildFilterChain(
    dims,
    {
      aiUpscaling: true,
      denoising: true,
      sharpening: true,
      colorCorrection: true,
      aspectHandling: 'fit',
    },
    true
  );

  assert.ok(filterChain.includes('hqdn3d='));
  assert.ok(filterChain.includes('scale=3840:2160:flags=lanczos'));
  assert.ok(filterChain.includes('unsharp='));
  assert.ok(filterChain.includes('eq=contrast='));

  const args = buildReconstructionFfmpegArgs({
    framesPatternPath: '/tmp/job/frames_out/frame_%05d.png',
    originalVideoPath: '/tmp/job/input.mp4',
    outputVideoPath: '/tmp/job/output.mp4',
    fps: 24,
    hasAudio: true,
    filterChain,
  });

  assert.ok(Array.isArray(args));
  assert.ok(args.includes('-framerate'));
  assert.ok(args.includes('24'));
  assert.ok(args.includes('1:a:0?'));
  assert.ok(args.includes('+faststart'));
});

test('createJobAuthToken and verifyJobAuthToken enforce HMAC integrity and expiration', () => {
  const secret = 'test-super-secret-hmac-key-2026';
  const jobId = '0123456789abcdef0123456789abcdef';
  const now = 1_700_000_000_000;
  const token = createJobAuthToken(jobId, secret, now + 60_000);

  const ok = verifyJobAuthToken(jobId, token, secret, now + 10_000);
  assert.equal(ok.valid, true);

  const expired = verifyJobAuthToken(jobId, token, secret, now + 61_000);
  assert.equal(expired.valid, false);
  assert.match(expired.reason || '', /expired/i);

  const wrongJob = verifyJobAuthToken('fedcba9876543210fedcba9876543210', token, secret, now + 10_000);
  assert.equal(wrongJob.valid, false);
});

test('estimateProcessingTime calculates frame counts and 2-minute target eligibility accurately', () => {
  const shortClip = estimateProcessingTime({
    durationSec: 4,
    fps: 24,
    targetPreset: '4K',
    options: {
      aiUpscaling: true,
      denoising: true,
      sharpening: true,
      colorCorrection: false,
      aspectHandling: 'fit',
    },
    engineMode: 'ffmpeg_fallback',
    gpuWorkerAvailable: false,
    twoMinuteTargetSec: 120,
  });

  assert.equal(shortClip.totalFrames, 96);
  assert.equal(shortClip.withinTwoMinuteTarget, true);

  const longClip = estimateProcessingTime({
    durationSec: 55,
    fps: 60,
    targetPreset: '4K',
    options: {
      aiUpscaling: true,
      denoising: true,
      sharpening: true,
      colorCorrection: true,
      aspectHandling: 'fit',
    },
    engineMode: 'ai_strict',
    gpuWorkerAvailable: true,
    twoMinuteTargetSec: 120,
  });

  assert.equal(longClip.totalFrames, 3300);
  assert.equal(longClip.withinTwoMinuteTarget, false);
});
