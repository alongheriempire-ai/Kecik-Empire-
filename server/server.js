import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 8787);

const MODEL =
  process.env.GEMINI_STORYBOARD_MODEL || "gemini-3.8-flash";

const MAX_RETRIES = Math.max(
  0,
  Number(process.env.GEMINI_MAX_RETRIES ?? 3)
);

const RETRY_BASE_MS = Math.max(
  500,
  Number(process.env.GEMINI_RETRY_BASE_MS ?? 3000)
);

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.use(
  express.json({
    limit: process.env.JSON_BODY_LIMIT || "25mb"
  })
);

// ======================================================
// JOB STORAGE
// ======================================================

const jobs = new Map();

// ======================================================
// GEMINI CLIENT
// ======================================================

const ai = () => {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error(
      "GEMINI_API_KEY belum ditetapkan dalam Render Environment."
    );
  }

  return new GoogleGenAI({
    apiKey: key
  });
};

// ======================================================
// SMART RETRY SYSTEM
// ======================================================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error) {
  const status = Number(
    error?.status ||
    error?.code ||
    error?.error?.code ||
    0
  );

  const message = String(
    error?.message ||
    error?.error?.message ||
    ""
  ).toLowerCase();

  return (
    [408, 429, 500, 502, 503, 504].includes(status) ||
    /temporar|high demand|overloaded|unavailable|rate limit|resource exhausted|internal error/.test(
      message
    )
  );
}

function errorStatus(error) {
  const status = Number(
    error?.status ||
    error?.code ||
    error?.error?.code ||
    0
  );

  return status >= 400 && status <= 599
    ? status
    : 500;
}

async function generateWithRetry(
  model,
  contents,
  config,
  job
) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      job.retryAttempt = attempt;

      job.message = attempt
        ? `Gemini sibuk. Percubaan semula ${attempt}/${MAX_RETRIES}...`
        : "Menghubungi Gemini...";

      job.updatedAt = new Date().toISOString();

      return await ai().models.generateContent({
        model,
        contents,
        config
      });

    } catch (error) {
      lastError = error;

      if (
        attempt >= MAX_RETRIES ||
        !isRetryable(error)
      ) {
        throw error;
      }

      const waitMs =
        RETRY_BASE_MS * (2 ** attempt) +
        Math.floor(Math.random() * 500);

      job.message =
        `Gemini sementara tidak tersedia (${errorStatus(error)}). ` +
        `Cuba semula ${attempt + 1}/${MAX_RETRIES} ` +
        `dalam ${Math.ceil(waitMs / 1000)} saat.`;

      job.updatedAt = new Date().toISOString();

      console.warn(
        `Gemini retry ${attempt + 1}/${MAX_RETRIES}:`,
        error.message
      );

      await sleep(waitMs);
    }
  }

  throw lastError;
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "kecik-empire-ai-factory",
    version: "3.4"
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "kecik-empire-ai-factory",
    version: "3.4",
    model: MODEL
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: "3.4",
    model: MODEL
  });
});

// ======================================================
// START PRODUCTION
// ======================================================

app.post(
  [
    "/production/start",
    "/api/production/start"
  ],
  (req, res) => {
    const {
      config = {},
      photos = []
    } = req.body || {};

    if (
      !Array.isArray(photos) ||
      photos.length === 0
    ) {
      return res.status(400).json({
        error: "Muat naik sekurang-kurangnya satu gambar produk."
      });
    }

    const jobId = randomUUID();

    const job = {
      jobId,

      status: "queued",
      stage: "queued",
      progress: 0,

      completedScenes: 0,
      totalScenes: 0,

      message:
        "Job diterima. Menyediakan storyboard...",

      storyboard: null,
      videoUrl: null,
      error: null,

      retryAttempt: 0,

      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    jobs.set(jobId, job);

    res.status(202).json({
      jobId,
      status: job.status,
      message: job.message
    });

    runJob(jobId, config, photos)
      .catch((error) => {
        const currentJob = jobs.get(jobId);

        if (currentJob) {
          currentJob.status = "failed";
          currentJob.stage = "failed";

          currentJob.error =
            error.message || "Unknown error";

          currentJob.message =
            currentJob.error;

          currentJob.updatedAt =
            new Date().toISOString();
        }

        console.error(
          `Job failed ${jobId}:`,
          error
        );
      });
  }
);

// ======================================================
// JOB STATUS
// ======================================================

app.get(
  [
    "/production/status/:jobId",
    "/api/production/status/:jobId"
  ],
  (req, res) => {
    const job = jobs.get(
      req.params.jobId
    );

    if (!job) {
      return res.status(404).json({
        error: "Job tidak dijumpai."
      });
    }

    return res.json({
      ...job
    });
  }
);

// ======================================================
// RUN STORYBOARD JOB
// ======================================================

async function runJob(
  jobId,
  config,
  photos
) {
  const job = jobs.get(jobId);

  if (!job) return;

  job.status = "processing";
  job.stage = "storyboard";
  job.progress = 5;

  job.message =
    "Menghasilkan storyboard menggunakan Gemini...";

  job.updatedAt =
    new Date().toISOString();

  const product =
    config.product ||
    config.productName ||
    "produk";

  const duration =
    Number(config.duration || 30);

  const ratio =
    config.ratio ||
    config.aspectRatio ||
    "9:16";

  const language =
    config.language ||
    "Bahasa Melayu";

  // ----------------------------------------------------
  // PROMPT
  // ----------------------------------------------------

  const prompt =
    `Create a professional commercial video storyboard as STRICT JSON only.\n` +

    `Product: ${product}.\n` +

    `Campaign details: ${JSON.stringify(config)}.\n` +

    `Target duration: ${duration} seconds.\n` +

    `Aspect ratio: ${ratio}.\n` +

    `Output language: ${language}.\n` +

    `Return JSON object:\n` +

    `{"title":"...","concept":"...","scenes":[{"scene":1,"duration":5,"visual":"...","camera":"...","action":"...","voiceover":"...","onScreenText":"...","sound":"...","imagePrompt":"..."}],"finalCta":"..."}.\n` +

    `Make scenes add up approximately to ${duration} seconds.\n` +

    `Include product close-ups, clear CTA, cinematic lighting and realistic production directions.\n` +

    `No markdown fences.`;

  // ----------------------------------------------------
  // PRODUCT IMAGES
  // ----------------------------------------------------

  const imageParts = photos
    .slice(0, 4)
    .map((photo) => {
      const raw =
        typeof photo === "string"
          ? photo
          : (
              photo?.data ||
              photo?.base64 ||
              photo?.url ||
              ""
            );

      const mime =
        (
          typeof photo === "object" &&
          photo?.mimeType
        ) ||
        "image/jpeg";

      const match = String(raw).match(
        /^data:(image\/[\w.+-]+);base64,(.+)$/
      );

      return {
        inlineData: {
          mimeType:
            match?.[1] || mime,

          data:
            match?.[2] ||
            String(raw).replace(
              /^data:[^,]+,/,
              ""
            )
        }
      };
    })
    .filter(
      (part) =>
        part.inlineData.data
    );

  // ----------------------------------------------------
  // GEMINI GENERATION
  // ----------------------------------------------------

  const response =
    await generateWithRetry(
      MODEL,

      [
        {
          role: "user",

          parts: [
            {
              text: prompt
            },

            ...imageParts
          ]
        }
      ],

      {
        responseMimeType:
          "application/json",

        temperature: 0.7
      },

      job
    );

  // ----------------------------------------------------
  // PARSE JSON
  // ----------------------------------------------------

  const text =
    response.text || "";

  let storyboard;

  try {
    storyboard = JSON.parse(
      text
        .replace(
          /^```(?:json)?\s*/i,
          ""
        )
        .replace(
          /\s*```$/,
          ""
        )
    );

  } catch {
    throw new Error(
      "Gemini memberi output bukan JSON. Cuba jalankan semula."
    );
  }

  // ----------------------------------------------------
  // JOB RESULT
  // ----------------------------------------------------

  job.storyboard =
    storyboard;

  job.totalScenes =
    Array.isArray(storyboard.scenes)
      ? storyboard.scenes.length
      : 0;

  job.completedScenes =
    job.totalScenes;

  job.progress = 35;

  job.stage =
    "storyboard_ready";

  job.status =
    "awaiting_video_provider";

  job.message =
    "Storyboard berjaya. Renderer video (Veo/FFmpeg) belum disambungkan; MP4 belum dijana.";

  job.updatedAt =
    new Date().toISOString();
}

// ======================================================
// ERROR HANDLER
// ======================================================

app.use(
  (err, _req, res, _next) => {
    console.error(
      "Request error:",
      err
    );

    if (
      err?.type === "entity.too.large"
    ) {
      return res.status(413).json({
        error:
          "Payload gambar terlalu besar. Kurangkan saiz gambar."
      });
    }

    return res.status(500).json({
      error:
        err.message ||
        "Ralat server."
    });
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  () => {
    console.log(
      `Kecik Empire API V3.4 listening on ${PORT} | model=${MODEL}`
    );
  }
);
