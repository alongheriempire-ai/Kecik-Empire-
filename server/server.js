'use strict';

const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');

const app = express();

const PORT = Number(process.env.PORT || 10000);
const API_VERSION = '3.4';

const MODEL =
  process.env.GEMINI_STORYBOARD_MODEL ||
  'gemini-3.8-flash';

const MAX_RETRIES =
  Math.max(0, Number(process.env.GEMINI_MAX_RETRIES || 4));

const RETRY_BASE_MS =
  Math.max(250, Number(process.env.GEMINI_RETRY_BASE_MS || 1500));

const JOB_TTL_MS =
  Math.max(600000, Number(process.env.JOB_TTL_MS || 21600000));

app.set('trust proxy', 1);

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

const jobs = new Map();

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    })
  : null;


// ======================================================
// SMART RETRY ENGINE
// ======================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeMessage(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/\s+/g, ' ')
    .slice(0, 1200);
}

function errorStatus(error) {
  return Number(
    error?.status ||
    error?.statusCode ||
    error?.code ||
    error?.error?.code
  ) || 0;
}

function isRetryable(error) {
  const status = errorStatus(error);
  const message = safeMessage(error).toLowerCase();

  return (
    [408, 429, 500, 502, 503, 504].includes(status) ||
    [
      'resource_exhausted',
      'unavailable',
      'internal',
      'deadline_exceeded',
      'temporarily',
      'timeout',
      'econnreset',
      'etimedout',
      'fetch failed'
    ].some(x => message.includes(x))
  );
}

async function withSmartRetry(operation, label = 'Gemini') {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await operation(attempt);

    } catch (error) {
      lastError = error;

      const status = errorStatus(error);

      if (attempt >= MAX_RETRIES || !isRetryable(error)) {
        error.retryAttempts = attempt;
        throw error;
      }

      const exponential = RETRY_BASE_MS * (2 ** attempt);

      const jitter = Math.floor(
        Math.random() * Math.min(1000, RETRY_BASE_MS)
      );

      const waitMs = Math.min(
        30000,
        exponential + jitter
      );

      console.warn(
        `[SmartRetry] ${label} failed. ` +
        `Attempt ${attempt + 1}/${MAX_RETRIES + 1}. ` +
        `Retry in ${waitMs}ms. HTTP ${status}`
      );

      await sleep(waitMs);
    }
  }

  throw lastError;
}


// ======================================================
// JOB MANAGEMENT
// ======================================================

function updateJob(job, patch) {
  Object.assign(job, patch, {
    updatedAt: new Date().toISOString()
  });
}


// ======================================================
// CONFIGURATION
// ======================================================

function cleanConfig(input = {}) {
  const config = input && typeof input === 'object'
    ? input
    : {};

  return {
    product: String(
      config.product || config.productName || 'Produk'
    ).trim().slice(0, 180),

    tagline: String(config.tagline || '')
      .trim().slice(0, 300),

    audience: String(
      config.audience || config.targetAudience || ''
    ).trim().slice(0, 300),

    platform: String(
      config.platform || 'TikTok / Instagram Reels'
    ).trim().slice(0, 120),

    duration: Math.min(
      180,
      Math.max(10, Number(config.duration || 30))
    ),

    ratio: String(
      config.ratio || config.aspectRatio || '9:16'
    ).trim().slice(0, 20),

    style: String(
      config.style || config.visualStyle || 'cinematic commercial'
    ).trim().slice(0, 300),

    language: String(
      config.language || 'Bahasa Melayu'
    ).trim().slice(0, 80),

    callToAction: String(
      config.callToAction || config.cta || 'Tempah sekarang'
    ).trim().slice(0, 250),

    extra: String(
      config.extra || config.notes || ''
    ).trim().slice(0, 1000)
  };
}


// ======================================================
// PHOTO PROCESSING
// ======================================================

function normalizePhotos(input) {
  if (!Array.isArray(input)) return [];

  return input.slice(0, 4).map(photo => {
    if (typeof photo === 'string') {
      return {
        mimeType: 'image/jpeg',
        data: photo.replace(
          /^data:image\/[^;]+;base64,/i,
          ''
        )
      };
    }

    return {
      mimeType: String(
        photo?.mimeType ||
        photo?.mime_type ||
        photo?.type ||
        'image/jpeg'
      ),

      data: String(
        photo?.data ||
        photo?.base64 ||
        photo?.url ||
        ''
      ).replace(
        /^data:image\/[^;]+;base64,/i,
        ''
      )
    };

  }).filter(photo =>
    photo.data &&
    !/^https?:\/\//i.test(photo.data)
  );
}


// ======================================================
// STORYBOARD PROMPT
// ======================================================

function storyboardPrompt(config) {
  return `
Anda ialah pengarah kreatif iklan komersial profesional.

Hasilkan storyboard iklan dalam JSON SAHAJA.
Jangan gunakan markdown atau code fence.

MAKLUMAT KEMPEN:

Produk: ${config.product}
Tagline: ${config.tagline}
Sasaran: ${config.audience}
Platform: ${config.platform}
Durasi: ${config.duration} saat
Nisbah: ${config.ratio}
Gaya: ${config.style}
Bahasa: ${config.language}
CTA: ${config.callToAction}
Nota: ${config.extra}

Gunakan foto produk yang dilampirkan sebagai rujukan visual.

Jangan reka ciri produk yang tidak kelihatan
atau tidak dinyatakan.

Bahagikan durasi kepada 4 hingga 8 scene.

Setiap scene mesti mempunyai:

- scene
- time
- visual
- camera
- lighting
- action
- voiceover
- onScreenText
- sound
- veoPrompt

Sertakan:

- title
- concept
- totalDuration
- aspectRatio
- musicDirection
- finalCTA

Pastikan veoPrompt sesuai untuk penjana video.
Teks/logo boleh ditambah dalam proses editing.
`;
}


// ======================================================
// GEMINI STORYBOARD GENERATION
// ======================================================

async function generateStoryboard(config, photos) {
  if (!ai) {
    throw new Error(
      'GEMINI_API_KEY belum ditetapkan dalam Render Environment Variables.'
    );
  }

  const parts = [
    {
      text: storyboardPrompt(config)
    }
  ];

  for (const photo of photos) {
    if (!photo.data) continue;

    parts.push({
      inlineData: {
        mimeType: photo.mimeType || 'image/jpeg',
        data: photo.data
      }
    });
  }

  const result = await withSmartRetry(
    () => ai.models.generateContent({
      model: MODEL,

      contents: [{
        role: 'user',
        parts
      }],

      config: {
        temperature: 0.7,
        responseMimeType: 'application/json'
      }
    }),

    'Gemini storyboard'
  );

  const text = result?.text || '';

  if (!text.trim()) {
    throw new Error('Gemini memulangkan respons kosong.');
  }

  let storyboard;

  try {
    storyboard = JSON.parse(
      text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim()
    );

  } catch (_) {
    storyboard = {
      raw: text
    };
  }

  return storyboard;
}


// ======================================================
// PRODUCTION JOB
// ======================================================

async function runJob(job, config, photos) {
  try {

    updateJob(job, {
      status: 'processing',
      stage: 'storyboard',
      progress: 8,
      message: 'Menjana storyboard menggunakan Gemini...'
    });

    const storyboard = await generateStoryboard(
      config,
      photos
    );

    const sceneCount =
      Array.isArray(storyboard?.scenes)
        ? storyboard.scenes.length
        : 0;

    updateJob(job, {
      status: 'storyboard_ready',
      stage: 'storyboard_ready',
      progress: 35,

      completedScenes: sceneCount,
      totalScenes: sceneCount,

      storyboard,

      message:
        'Storyboard berjaya dijana. Video rendering belum dikonfigurasi.'
    });

    // MP4 tidak difabrikasi.
    // Video memerlukan Veo adapter + FFmpeg pipeline.

    updateJob(job, {
      status: 'provider_required',
      stage: 'video_render_pending',
      progress: 35,

      message:
        'Storyboard siap. Sambungkan Veo video-generation adapter dan FFmpeg pipeline untuk MP4 sebenar.'
    });

  } catch (error) {

    const status = errorStatus(error);

    updateJob(job, {
      status: 'failed',
      stage: 'failed',
      progress: 0,

      error: safeMessage(error),
      errorCode: status || null,

      retryAttempts: Number(
        error.retryAttempts || 0
      ),

      message:
        status === 404
          ? `Model ${MODEL} tidak ditemui atau tidak tersedia untuk API key ini.`
          : status === 429 || status === 503
            ? 'Gemini sedang sibuk atau kuota terhad. Smart Retry telah mencuba.'
            : safeMessage(error)
    });

    console.error(`Job failed ${job.jobId}`, error);
  }
}


// ======================================================
// START PRODUCTION
// ======================================================

function startProduction(req, res) {
  const body = req.body || {};

  const config = cleanConfig(
    body.config || body
  );

  const photos = normalizePhotos(
    body.photos || body.images || []
  );

  if (!photos.length) {
    return res.status(400).json({
      error: 'Upload sekurang-kurangnya satu foto produk.'
    });
  }

  const jobId = crypto.randomUUID();

  const job = {
    jobId,

    status: 'queued',
    stage: 'queued',
    progress: 0,

    completedScenes: 0,
    totalScenes: 0,

    message: 'Job diterima. Menyediakan storyboard...',

    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  jobs.set(jobId, job);

  setImmediate(() => {
    runJob(job, config, photos);
  });

  return res.status(202).json({
    jobId,
    status: 'queued',
    message: 'Job accepted'
  });
}


// ======================================================
// JOB STATUS
// ======================================================

function getJob(req, res) {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      error: 'Job tidak ditemui.',
      jobId: req.params.jobId
    });
  }

  return res.json(job);
}


// ======================================================
// HEALTH
// ======================================================

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'kecik-empire-ai-factory',
    version: API_VERSION
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'kecik-empire-ai-factory',
    version: API_VERSION,
    model: MODEL,
    geminiConfigured: Boolean(ai),
    time: new Date().toISOString()
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'kecik-empire-ai-factory',
    version: API_VERSION,
    model: MODEL,
    geminiConfigured: Boolean(ai),
    time: new Date().toISOString()
  });
});


// ======================================================
// PRODUCTION ROUTES
// ======================================================

app.post('/api/production/start', startProduction);
app.post('/production/start', startProduction);

app.get('/api/production/status/:jobId', getJob);
app.get('/production/status/:jobId', getJob);


// ======================================================
// ERROR HANDLER
// ======================================================

app.use((err, _req, res, _next) => {
  console.error('[Express error]', err);

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Payload terlalu besar. Kurangkan saiz foto.'
    });
  }

  return res.status(500).json({
    error: safeMessage(err)
  });
});


// ======================================================
// CLEANUP OLD JOBS
// ======================================================

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;

  for (const [id, job] of jobs.entries()) {
    if (
      new Date(job.updatedAt || job.createdAt).getTime()
      < cutoff
    ) {
      jobs.delete(id);
    }
  }

}, 30 * 60 * 1000).unref();


// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Kecik Empire API V${API_VERSION} listening on ${PORT}`
  );

  console.log(
    `Gemini storyboard model: ${MODEL}`
  );

  console.log(
    `Gemini API key configured: ${Boolean(ai)}`
  );
});
