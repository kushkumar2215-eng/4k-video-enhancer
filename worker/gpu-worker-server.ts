import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import express, { Request, Response } from 'express';

const execFileAsync = promisify(execFile);

const WORKER_PORT = Number(process.env.WORKER_PORT || 8080);
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET || '';
const REAL_ESRGAN_BIN_PATH =
  process.env.REAL_ESRGAN_BIN_PATH || '/opt/realesrgan/realesrgan-ncnn-vulkan';
const WORKER_TEMP_ROOT = '/tmp/gpu-worker-batches';

const ALLOWED_MODELS = new Set([
  'realesr-animevideov3',
  'realesrgan-x4plus',
  'realesrgan-x4plus-anime',
]);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));

function verifyHmacSignature(req: Request, rawBody: string): boolean {
  if (!WORKER_SHARED_SECRET) return false;
  const timestamp = String(req.headers['x-worker-timestamp'] || '');
  const signature = String(req.headers['x-worker-signature'] || '');
  if (!timestamp || !signature) return false;

  const ageMs = Math.abs(Date.now() - Number(timestamp));
  if (!Number.isFinite(ageMs) || ageMs > 5 * 60 * 1000) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', WORKER_SHARED_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok', engine: 'realesrgan-ncnn-vulkan' });
});

app.post('/v1/upscale-batch', async (req: Request, res: Response) => {
  const rawBody = JSON.stringify(req.body);
  if (!verifyHmacSignature(req, rawBody)) {
    res.status(403).json({ error: 'Invalid or missing worker HMAC signature.' });
    return;
  }

  const { model, scale, frames } = req.body as {
    model?: string;
    scale?: number;
    frames?: Array<{ filename: string; dataBase64: string }>;
  };

  const safeModel = ALLOWED_MODELS.has(String(model))
    ? String(model)
    : 'realesr-animevideov3';
  const safeScale = scale === 2 || scale === 3 || scale === 4 ? scale : 4;

  if (!Array.isArray(frames) || frames.length === 0 || frames.length > 32) {
    res.status(400).json({ error: 'Invalid frame batch size (must be 1..32 frames).' });
    return;
  }

  const batchId = crypto.randomBytes(12).toString('hex');
  const batchDir = path.join(WORKER_TEMP_ROOT, batchId);
  const inDir = path.join(batchDir, 'in');
  const outDir = path.join(batchDir, 'out');

  try {
    await fs.mkdir(inDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(outDir, { recursive: true, mode: 0o700 });

    await Promise.all(
      frames.map(async (f) => {
        const cleanName = path.basename(f.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
        await fs.writeFile(
          path.join(inDir, cleanName),
          Buffer.from(f.dataBase64, 'base64')
        );
      })
    );

    // Invoke realesrgan-ncnn-vulkan on the batch directory with shell: false
    await execFileAsync(
      REAL_ESRGAN_BIN_PATH,
      [
        '-i',
        inDir,
        '-o',
        outDir,
        '-n',
        safeModel,
        '-s',
        String(safeScale),
        '-f',
        'png',
      ],
      { timeout: 120_000 }
    );

    const outputFrames = await Promise.all(
      frames.map(async (f) => {
        const cleanName = path.basename(f.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
        const buf = await fs.readFile(path.join(outDir, cleanName));
        return {
          filename: cleanName,
          dataBase64: buf.toString('base64'),
        };
      })
    );

    res.json({ frames: outputFrames });
  } catch {
    res.status(500).json({ error: 'GPU batch super-resolution execution failed.' });
  } finally {
    await fs.rm(batchDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(WORKER_PORT, '0.0.0.0', () => {
  console.log(`Isolated Real-ESRGAN GPU worker listening on port ${WORKER_PORT}`);
});
