/**
 * KECIK EMPIRE AI FACTORY — BACKEND V3.5
 * Gemini Storyboard + Google Veo + FFmpeg
 * Smart Retry + Job Polling + MP4 Output
 *
 * Requirements:
 * Node.js 20+
 * GEMINI_API_KEY
 * FFmpeg installed
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { GoogleGenAI } = require("@google/genai");

const execFileAsync = promisify(execFile);

const app = express();

const PORT = process.env.PORT || 10000;

const API_KEY = process.env.GEMINI_API_KEY;

const STORYBOARD_MODEL =
  process.env.GEMINI_STORYBOARD_MODEL || "gemini-3.8-flash";

const VEO_MODEL =
  process.env.VEO_MODEL || "veo-3.1-fast-generate-preview";

const MAX_SCENES = Math.min(
  Number(process.env.MAX_SCENES || 6),
  8
);

const JOB_TTL_HOURS =
  Number(process.env.JOB_TTL_HOURS || 12);

const ai = API_KEY
  ? new GoogleGenAI({ apiKey: API_KEY })
  : null;

const jobs = new Map();

app.use(cors({ origin: true }));

app.use(express.json({ limit: "30mb" }));

app.use(
  "/outputs",
  express.static(path.join(__dirname, "outputs"))
);

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const now = () =>
  new Date().toISOString();

const safeError = error =>
  error?.message || String(error);


/* =========================================
   SMART RETRY
========================================= */

function retryable(error) {
  const status = Number(
    error?.status || error?.code || 0
  );

  const message =
    safeError(error).toLowerCase();

  return (
    [408, 429, 500, 502, 503, 504].includes(status) ||
    [
      "timeout",
      "temporarily unavailable",
      "high demand",
      "overloaded",
      "fetch failed",
      "socket hang up"
    ].some(text => message.includes(text))
  );
}

async function smartRetry(
  fn,
  {
    attempts = 5,
    base = 2000,
    cap = 30000
  } = {}
) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (
        attempt === attempts ||
        !retryable(error)
      ) {
        throw error;
      }

      const wait =
        Math.min(
          cap,
          base * Math.pow(2, attempt - 1)
        ) +
        Math.floor(Math.random() * 1000);

      console.warn(
        `[SmartRetry] ${attempt}/${attempts}`,
        `retry after ${wait}ms`,
        safeError(error)
      );

      await sleep(wait);
    }
  }

  throw lastError;
}


/* =========================================
   JOB MANAGEMENT
========================================= */

function patch(job, changes) {
  Object.assign(job, changes, {
    updatedAt: now()
  });
}

function view(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,

    completedScenes:
      job.completedScenes || 0,

    totalScenes:
      job.totalScenes || 0,

    message: job.message,

    storyboard:
      job.storyboard || null,

    videoUrl:
      job.videoUrl || null,

    error:
      job.error || null,

    updatedAt:
      job.updatedAt
  };
}


/* =========================================
   IMAGE PROCESSING
========================================= */

function imagePart(photo) {
  const raw = String(
    photo?.data || ""
  ).replace(
    /^data:image\/[^;]+;base64,/,
    ""
  );

  if (!raw) return null;

  return {
    inlineData: {
      mimeType:
        photo.mimeType ||
        photo.type ||
        "image/jpeg",

      data: raw
    }
  };
}

function imagePartRaw(photo) {
  return {
    mimeType:
      photo.mimeType ||
      photo.type ||
      "image/jpeg",

    data: String(
      photo.data || ""
    ).replace(
      /^data:image\/[^;]+;base64,/,
      ""
    )
  };
}


/* =========================================
   JSON EXTRACTION
========================================= */

function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch (_) {}

  const match =
    String(text).match(/\{[\s\S]*\}/);

  if (!match) {
    throw new Error(
      "Gemini storyboard response bukan JSON."
    );
  }

  return JSON.parse(match[0]);
}


/* =========================================
   GEMINI STORYBOARD
========================================= */

async function makeStoryboard(config, photos) {
  if (!ai) {
    throw new Error(
      "GEMINI_API_KEY tiada dalam Render Environment."
    );
  }

  const prompt = `
Create a professional commercial storyboard.
Return VALID JSON ONLY. No markdown.

Language: Bahasa Melayu.

Product:
${config.product || "Product"}

Brand:
${config.brand || "Kecik Empire"}

Tagline:
${config.tagline || ""}

CTA:
${config.cta || ""}

Duration:
${config.duration || 30} seconds

Aspect ratio:
${config.ratio || "9:16"}

Style:
${config.style || "cinematic premium"}

Music:
${config.music || ""}

Voice:
${config.voice || ""}

Creative direction:
${config.extra || config.prompt || ""}

Create ${MAX_SCENES} scenes.

Return JSON:
{
  "title": "...",
  "product_consistency": "...",
  "global_negative_prompt": "...",
  "scenes": [
    {
      "scene_number": 1,
      "duration_seconds": 8,
      "title": "...",
      "visual": "...",
      "camera": "...",
      "lighting": "...",
      "action": "...",
      "voiceover": "...",
      "on_screen_text": "...",
      "sound_design": "...",
      "veo_prompt": "..."
    }
  ]
}

Each veo_prompt must be detailed and standalone.
Maintain product appearance based on attached photos.
`;

  const parts = [
    ...photos
      .slice(0, 4)
      .map(imagePart)
      .filter(Boolean),

    { text: prompt }
  ];

  const response = await smartRetry(
    () =>
      ai.models.generateContent({
        model: STORYBOARD_MODEL,

        contents: [
          {
            role: "user",
            parts
          }
        ],

        config: {
          responseMimeType: "application/json",
          temperature: 0.65
        }
      })
  );

  const storyboard =
    extractJSON(response.text || "");

  if (
    !Array.isArray(storyboard.scenes) ||
    !storyboard.scenes.length
  ) {
    throw new Error(
      "Storyboard tidak mengandungi scenes."
    );
  }

  storyboard.scenes =
    storyboard.scenes.slice(
      0,
      MAX_SCENES
    );

  return storyboard;
}


/* =========================================
   GOOGLE VEO VIDEO GENERATION
========================================= */

async function generateVeoClip(
  prompt,
  image,
  destination,
  ratio,
  job
) {
  if (!ai) {
    throw new Error(
      "Gemini API belum dikonfigurasi."
    );
  }

  console.log(
    "[VEO] Starting video generation..."
  );

  let operation = await smartRetry(
    () =>
      ai.models.generateVideos({
        model: VEO_MODEL,

        prompt,

        ...(image
          ? {
              image: {
                mimeType: image.mimeType,

                imageBytes:
                  Buffer.from(
                    image.data,
                    "base64"
                  )
              }
            }
          : {}),

        config: {
          numberOfVideos: 1,
          durationSeconds: 8,

          aspectRatio:
            ratio === "16:9"
              ? "16:9"
              : "9:16",

          resolution: "720p"
        }
      }),
    {
      attempts: 4,
      base: 5000,
      cap: 45000
    }
  );

  let polls = 0;

  while (!operation.done) {
    polls++;

    if (polls > 180) {
      throw new Error(
        "Veo timeout selepas 30 minit."
      );
    }

    patch(job, {
      message:
        `Veo sedang render video... (${polls})`
    });

    await sleep(10000);

    operation = await smartRetry(
      () =>
        ai.operations.getVideosOperation({
          operation
        }),
      {
        attempts: 4,
        base: 2500
      }
    );
  }

  if (operation.error) {
    throw new Error(
      operation.error.message ||
      JSON.stringify(operation.error)
    );
  }

  const generatedVideo =
    operation.response
      ?.generatedVideos?.[0]?.video;

  if (!generatedVideo) {
    throw new Error(
      "Veo selesai tetapi video tidak ditemui."
    );
  }

  console.log(
    "[VEO] Downloading generated video..."
  );

  await smartRetry(
    () =>
      ai.files.download({
        file: generatedVideo,
        downloadPath: destination
      }),
    {
      attempts: 4,
      base: 3000
    }
  );

  const stat =
    await fs.stat(destination);

  if (stat.size < 10000) {
    throw new Error(
      "Fail video terlalu kecil atau tidak sah."
    );
  }

  return destination;
}


/* =========================================
   FFMPEG ASSEMBLY
========================================= */

async function ffmpegAssemble(
  clips,
  output,
  ratio
) {
  const folder =
    path.dirname(output);

  const concatFile =
    path.join(folder, "concat.txt");

  const normalizedFile =
    path.join(folder, "normalized.mp4");

  const listContent =
    clips.map(
      file =>
        `file '${file.replace(/'/g, "'\\''")}'`
    ).join("\n");

  await fs.writeFile(
    concatFile,
    listContent
  );

  const filter =
    ratio === "16:9"
      ? "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2"
      : "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2";

  console.log(
    "[FFMPEG] Combining video clips..."
  );

  await execFileAsync(
    "ffmpeg",
    [
      "-y",

      "-f", "concat",
      "-safe", "0",

      "-i", concatFile,

      "-vf", filter,

      "-r", "30",

      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "21",

      "-c:a", "aac",
      "-b:a", "128k",

      "-movflags", "+faststart",

      normalizedFile
    ],
    {
      timeout: 30 * 60 * 1000
    }
  );

  await fs.rename(
    normalizedFile,
    output
  );

  await fs.rm(
    concatFile,
    { force: true }
  );

  return output;
}


/* =========================================
   PRODUCTION JOB
========================================= */

async function runJob(
  job,
  config,
  photos
) {
  const workDirectory =
    path.join(
      os.tmpdir(),
      "kecik-" + job.jobId
    );

  try {
    await fs.mkdir(
      workDirectory,
      { recursive: true }
    );

    patch(job, {
      status: "processing",
      stage: "storyboard",
      progress: 5,
      message:
        "Membina storyboard Gemini..."
    });

    const storyboard =
      await makeStoryboard(
        config,
        photos
      );

    patch(job, {
      storyboard,
      totalScenes:
        storyboard.scenes.length,

      status: "processing",
      stage: "veo_render",
      progress: 10,

      message:
        "Storyboard siap. Menjana video Veo..."
    });

    const clips = [];

    for (
      let index = 0;
      index < storyboard.scenes.length;
      index++
    ) {
      const scene =
        storyboard.scenes[index];

      const scenePrompt =
        scene.veo_prompt ||
        scene.veoPrompt ||
        scene.visual ||
        scene.description ||
        scene.title;

      const prompt = `
${scenePrompt}

Commercial product:
${config.product || ""}

Brand:
${config.brand || "Kecik Empire"}

Maintain identical product appearance.
Premium commercial cinematography.
Clean composition.
Avoid text/logo artifacts.

Product consistency:
${storyboard.product_consistency || ""}

Negative prompt:
${storyboard.global_negative_prompt || ""}
`;

      const clipPath =
        path.join(
          workDirectory,
          `scene-${String(index + 1).padStart(2, "0")}.mp4`
        );

      patch(job, {
        stage: "veo_render",

        progress:
          10 +
          Math.round(
            (index / storyboard.scenes.length) * 65
          ),

        completedScenes: index,

        message:
          `Render scene ${index + 1}/${storyboard.scenes.length}...`
      });

      await generateVeoClip(
        prompt,

        photos[0]
          ? imagePartRaw(photos[0])
          : null,

        clipPath,

        config.ratio,

        job
      );

      clips.push(clipPath);

      patch(job, {
        completedScenes: index + 1,

        progress:
          10 +
          Math.round(
            ((index + 1) / storyboard.scenes.length) * 65
          ),

        message:
          `Scene ${index + 1}/${storyboard.scenes.length} selesai.`
      });
    }

    patch(job, {
      stage: "ffmpeg",
      progress: 80,
      message:
        "FFmpeg sedang menyatukan video..."
    });

    const outputDirectory =
      path.join(__dirname, "outputs");

    await fs.mkdir(
      outputDirectory,
      { recursive: true }
    );

    const finalName =
      `${job.jobId}.mp4`;

    const finalPath =
      path.join(
        outputDirectory,
        finalName
      );

    await ffmpegAssemble(
      clips,
      finalPath,
      config.ratio
    );

    patch(job, {
      status: "completed",
      stage: "completed",
      progress: 100,

      completedScenes:
        clips.length,

      videoUrl:
        `/outputs/${finalName}`,

      message:
        "MP4 sebenar siap dijana!"
    });

  } catch (error) {
    console.error(
      "Production job failed:",
      job.jobId,
      error
    );

    patch(job, {
      status: "failed",
      stage: "failed",

      error:
        safeError(error),

      message:
        safeError(error)
    });

  } finally {
    await fs.rm(
      workDirectory,
      {
        recursive: true,
        force: true
      }
    ).catch(() => {});
  }
}


/* =========================================
   HEALTH CHECK
========================================= */

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Kecik Empire AI Factory",
    version: "3.5"
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,

    service:
      "kecik-empire-ai-factory",

    version: "3.5",

    storyboardModel:
      STORYBOARD_MODEL,

    veoModel:
      VEO_MODEL,

    geminiConfigured:
      Boolean(API_KEY),

    time: now()
  });
});


/* =========================================
   START PRODUCTION
========================================= */

app.post(
  "/api/production/start",
  (req, res) => {
    const body =
      req.body || {};

    const config =
      body.config || body;

    const photos =
      Array.isArray(body.photos)
        ? body.photos
        : [];

    if (!API_KEY) {
      return res.status(500).json({
        error:
          "GEMINI_API_KEY belum ditetapkan di Render."
      });
    }

    if (
      !config.product &&
      !config.prompt &&
      !config.extra
    ) {
      return res.status(400).json({
        error:
          "Sila isi nama produk atau brief."
      });
    }

    if (!photos.length) {
      return res.status(400).json({
        error:
          "Muat naik sekurang-kurangnya satu foto produk."
      });
    }

    const jobId =
      crypto.randomUUID();

    const job = {
      jobId,

      status: "queued",
      stage: "queued",

      progress: 0,

      completedScenes: 0,
      totalScenes: 0,

      message:
        "Job diterima.",

      createdAt: now(),
      updatedAt: now()
    };

    jobs.set(jobId, job);

    res.status(202).json({
      jobId,
      status: "queued",
      message: "Job accepted"
    });

    runJob(
      job,
      config,
      photos
    ).catch(error => {
      patch(job, {
        status: "failed",
        stage: "failed",
        error: safeError(error),
        message: safeError(error)
      });
    });
  }
);


/* =========================================
   JOB STATUS
========================================= */

app.get(
  "/api/production/status/:jobId",
  (req, res) => {
    const job =
      jobs.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        error:
          "Job ID tidak ditemui. Server mungkin restart atau job telah tamat."
      });
    }

    res.json(view(job));
  }
);


/* =========================================
   JOB CLEANUP
========================================= */

setInterval(() => {
  const cutoff =
    Date.now() -
    JOB_TTL_HOURS * 3600000;

  for (const [id, job] of jobs.entries()) {
    if (
      Date.parse(job.updatedAt) < cutoff
    ) {
      jobs.delete(id);
    }
  }
}, 30 * 60 * 1000).unref();


/* =========================================
   SERVER START
========================================= */

app.listen(PORT, () => {
  console.log(
    `Kecik Empire API V3.5 running on ${PORT}`
  );

  console.log(
    `Gemini Model: ${STORYBOARD_MODEL}`
  );

  console.log(
    `Veo Model: ${VEO_MODEL}`
  );
});
