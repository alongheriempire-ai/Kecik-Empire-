import "dotenv/config";

import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const app = express();

const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_STORYBOARD_MODEL || "gemini-3.8-flash";

const VEO_MODEL =
  process.env.VEO_MODEL || "veo-3.1-fast-generate-preview";

const MAX_RETRIES = 4;

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;

const jobs = new Map();

app.use(cors());

app.use(express.json({ limit: "30mb" }));

// =====================================================
// UTILITIES
// =====================================================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function getErrorMessage(error) {
  return error?.message || String(error);
}

function isRetryable(error) {
  const status = Number(error?.status || error?.code || 0);

  const message = getErrorMessage(error).toLowerCase();

  return (
    [408, 429, 500, 502, 503, 504].includes(status) ||
    message.includes("timeout") ||
    message.includes("unavailable") ||
    message.includes("high demand") ||
    message.includes("fetch failed") ||
    message.includes("headers timeout")
  );
}

// =====================================================
// SMART RETRY
// =====================================================

async function smartRetry(label, fn, job = null) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (job) {
        job.logs.push(
          `${label}: Attempt ${attempt + 1}/${MAX_RETRIES + 1}`
        );
      }

      return await fn();

    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === MAX_RETRIES) {
        throw error;
      }

      const delay = Math.min(
        30000,
        2000 * Math.pow(2, attempt)
      );

      if (job) {
        job.logs.push(
          `${label} failed. Retry in ${delay / 1000}s`
        );
      }

      console.warn(
        `[RETRY] ${label}: ${getErrorMessage(error)}`
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

// =====================================================
// FFmpeg
// =====================================================

let FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

try {
  const ffmpegStatic = await import("ffmpeg-static");

  if (ffmpegStatic.default) {
    FFMPEG_PATH = ffmpegStatic.default;
  }
} catch {
  console.warn(
    "ffmpeg-static unavailable. Using system ffmpeg."
  );
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(FFMPEG_PATH, args);

    let stderr = "";

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("error", reject);

    process.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg failed: ${stderr.slice(-2000)}`
          )
        );
      }
    });
  });
}

// =====================================================
// GEMINI STORYBOARD
// =====================================================

function extractText(response) {
  return response?.text || "";
}

function parseStoryboard(text) {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start < 0 || end < 0) {
    throw new Error("Invalid storyboard JSON");
  }

  const data = JSON.parse(
    cleaned.substring(start, end + 1)
  );

  const scenes = data.scenes || [];

  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("Storyboard has no scenes");
  }

  return scenes.slice(0, 4).map((scene, index) => ({
    scene: index + 1,
    prompt: String(
      scene.prompt || scene.description || ""
    ),
    duration: 8
  }));
}

async function generateStoryboard(config, job) {
  const prompt = `
You are a professional cinematic advertising director.

Create a commercial video storyboard.

Return JSON only:
{
  "scenes": [
    {
      "prompt": "Detailed cinematic video prompt"
    }
  ]
}

Create 1 to 4 scenes.

Product: ${config.product || "Product"}
Tagline: ${config.tagline || ""}
Style: ${config.style || "Premium cinematic commercial"}
Description: ${config.description || ""}
Campaign: ${config.brief || ""}

Each scene must be visually detailed.
Use realistic camera movement.
Keep the product visually consistent.
`;

  const response = await smartRetry(
    "Gemini Storyboard",
    () =>
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          temperature: 0.7,
          responseMimeType: "application/json"
        }
      }),
    job
  );

  return parseStoryboard(extractText(response));
}

// =====================================================
// VEO VIDEO GENERATION
// =====================================================

async function generateVeoScene(scene, job, index) {
  job.logs.push(
    `Veo generating scene ${index + 1}`
  );

  let operation = await smartRetry(
    `Veo Scene ${index + 1}`,
    () =>
      ai.models.generateVideos({
        model: VEO_MODEL,
        prompt: scene.prompt,
        config: {
          numberOfVideos: 1,
          durationSeconds: 8,
          aspectRatio: "16:9"
        }
      }),
    job
  );

  const deadline = Date.now() + 15 * 60 * 1000;

  while (!operation.done) {
    if (Date.now() > deadline) {
      throw new Error("Veo generation timeout");
    }

    await sleep(10000);

    operation = await smartRetry(
      "Veo Operation Poll",
      () =>
        ai.operations.getVideosOperation({
          operation
        }),
      job
    );
  }

  const generatedVideo =
    operation.response?.generatedVideos?.[0]?.video;

  if (!generatedVideo) {
    throw new Error(
      `Veo returned no video for scene ${index + 1}`
    );
  }

  const scenePath = path.join(
    job.workDir,
    `scene-${index + 1}.mp4`
  );

  await ai.files.download({
    file: generatedVideo,
    downloadPath: scenePath
  });

  job.logs.push(
    `Scene ${index + 1} completed`
  );

  return scenePath;
}

// =====================================================
// FFmpeg VIDEO ASSEMBLY
// =====================================================

async function assembleVideo(sceneFiles, output, job) {
  if (sceneFiles.length === 1) {
    await fs.copyFile(sceneFiles[0], output);
    return;
  }

  const concatFile = path.join(
    job.workDir,
    "concat.txt"
  );

  const content = sceneFiles
    .map((file) => `file '${file}'`)
    .join("\n");

  await fs.writeFile(concatFile, content);

  await runFFmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    output
  ]);

  job.logs.push("FFmpeg assembly completed");
}

// =====================================================
// PRODUCTION ENGINE
// =====================================================

async function processProduction(job) {
  try {
    job.status = "storyboard";
    job.progress = 5;

    const scenes = await generateStoryboard(
      job.config,
      job
    );

    job.scenes = scenes;
    job.totalScenes = scenes.length;

    job.logs.push(
      `Storyboard created: ${scenes.length} scenes`
    );

    job.status = "rendering";
    job.progress = 15;

    const sceneFiles = [];

    for (let i = 0; i < scenes.length; i++) {
      const file = await generateVeoScene(
        scenes[i],
        job,
        i
      );

      sceneFiles.push(file);

      job.completedScenes = i + 1;

      job.progress =
        20 +
        Math.round(
          ((i + 1) / scenes.length) * 65
        );
    }

    job.status = "assembling";
    job.progress = 90;

    const output = path.join(
      job.workDir,
      "final.mp4"
    );

    await assembleVideo(
      sceneFiles,
      output,
      job
    );

    const stats = await fs.stat(output);

    if (!stats.size) {
      throw new Error("MP4 output is empty");
    }

    job.videoPath = output;

    job.videoUrl =
      `/api/production/video/${job.id}`;

    job.fileSize = stats.size;

    job.status = "completed";
    job.progress = 100;

    job.logs.push(
      "PRODUCTION COMPLETE: MP4 READY"
    );

  } catch (error) {
    console.error(
      `[JOB ${job.id}]`,
      error
    );

    job.status = "failed";

    job.error = {
      message: getErrorMessage(error),
      status: error?.status || error?.code || null
    };

    job.logs.push(
      `FAILED: ${getErrorMessage(error)}`
    );
  }

  job.updatedAt = new Date().toISOString();
}

// =====================================================
// HEALTH
// =====================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "kecik-empire-ai-factory",
    version: "3.5.0"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "kecik-empire-ai-factory",
    version: "3.5.0",
    models: {
      storyboard: GEMINI_MODEL,
      video: VEO_MODEL
    },
    time: new Date().toISOString()
  });
});

// =====================================================
// START PRODUCTION
// =====================================================

async function startProduction(req, res) {
  if (!ai) {
    return res.status(500).json({
      error: "GEMINI_API_KEY missing"
    });
  }

  const body = req.body || {};

  const config = body.config || body;

  const id = randomUUID();

  const workDir = path.join(
    os.tmpdir(),
    `kecik-${id}`
  );

  await fs.mkdir(workDir, {
    recursive: true
  });

  const job = {
    id,
    status: "queued",
    progress: 0,
    completedScenes: 0,
    totalScenes: 0,
    config,
    photos: body.photos || [],
    scenes: [],
    logs: ["Production job accepted"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workDir
  };

  jobs.set(id, job);

  res.status(202).json({
    ok: true,
    jobId: id,
    id,
    status: "queued",
    message: "Production started"
  });

  setImmediate(() => {
    processProduction(job);
  });
}

app.post(
  [
    "/api/production/start",
    "/production/start"
  ],
  startProduction
);

// =====================================================
// JOB STATUS
// =====================================================

app.get(
  [
    "/api/production/status/:jobId",
    "/production/status/:jobId"
  ],
  (req, res) => {
    const job = jobs.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        error: "Job not found"
      });
    }

    res.json({
      id: job.id,
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      completedScenes: job.completedScenes,
      totalScenes: job.totalScenes,
      scenes: job.scenes,
      videoUrl: job.videoUrl || null,
      fileSize: job.fileSize || null,
      error: job.error || null,
      logs: job.logs,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    });
  }
);

// =====================================================
// DOWNLOAD VIDEO
// =====================================================

app.get(
  "/api/production/video/:jobId",
  (req, res) => {
    const job = jobs.get(req.params.jobId);

    if (!job || !job.videoPath) {
      return res.status(404).json({
        error: "Video not ready"
      });
    }

    res.type("mp4");

    res.sendFile(job.videoPath);
  }
);

// =====================================================
// JOB LIST
// =====================================================

app.get("/api/production/jobs", (req, res) => {
  const list = [...jobs.values()]
    .slice(-50)
    .reverse()
    .map((job) => ({
      id: job.id,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt
    }));

  res.json(list);
});

// =====================================================
// ERROR HANDLER
// =====================================================

app.use((error, req, res, next) => {
  console.error("Express Error:", error);

  res.status(error.status || 500).json({
    error: error.message || "Internal server error"
  });
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Kecik Empire API V3.5 listening on ${PORT}`
  );

  console.log(
    `Gemini Model: ${GEMINI_MODEL}`
  );

  console.log(
    `Veo Model: ${VEO_MODEL}`
  );

  console.log(
    `FFmpeg: ${FFMPEG_PATH}`
  );
});
