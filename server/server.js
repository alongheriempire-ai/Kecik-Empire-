/**
 * KECIK EMPIRE AI FACTORY
 * BACKEND V3.5
 * Gemini + Smart Retry + Veo + FFmpeg
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { execFile } = require("child_process");
const { promisify } = require("util");

const { GoogleGenAI } = require("@google/genai");
const { Storage } = require("@google-cloud/storage");

const execFileAsync = promisify(execFile);

const app = express();

const PORT = process.env.PORT || 10000;

// ======================================================
// CONFIGURATION
// ======================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_STORYBOARD_MODEL ||
  "gemini-3.8-flash";

const GEMINI_FALLBACK_MODEL =
  process.env.GEMINI_FALLBACK_MODEL ||
  "gemini-2.5-flash";

const VEO_MODEL =
  process.env.VEO_MODEL ||
  "veo-3.1-fast-generate-001";

const GOOGLE_CLOUD_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT;

const GOOGLE_CLOUD_LOCATION =
  process.env.GOOGLE_CLOUD_LOCATION || "global";

const VEO_GCS_BUCKET =
  process.env.VEO_GCS_BUCKET;

const MAX_RETRIES =
  Number(process.env.SMART_RETRY_MAX || 4);

const JOB_TIMEOUT =
  20 * 60 * 1000;

// ======================================================
// EXPRESS
// ======================================================

app.use(cors({ origin: true }));

app.use(express.json({
  limit: "35mb"
}));

app.use(express.urlencoded({
  extended: true,
  limit: "35mb"
}));

// ======================================================
// GOOGLE CLIENTS
// ======================================================

const gemini = GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    })
  : null;

const veo = GOOGLE_CLOUD_PROJECT
  ? new GoogleGenAI({
      vertexai: true,
      project: GOOGLE_CLOUD_PROJECT,
      location: GOOGLE_CLOUD_LOCATION
    })
  : null;

const storage = new Storage();

// ======================================================
// JOB STORAGE
// ======================================================

const jobs = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return String(
    error?.message ||
    error ||
    "Unknown error"
  );
}

// ======================================================
// SMART RETRY
// ======================================================

function isRetryable(error) {

  const message = errorMessage(error).toLowerCase();

  return (
    message.includes("503") ||
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("504") ||
    message.includes("unavailable") ||
    message.includes("high demand") ||
    message.includes("timeout") ||
    message.includes("temporarily") ||
    message.includes("resource exhausted")
  );
}

async function smartRetry(
  operation,
  label,
  job
) {

  let lastError;

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {

    try {

      if (job) {

        job.message =
          `${label} - Attempt ${attempt}/${MAX_RETRIES}`;

      }

      return await operation(attempt);

    } catch (error) {

      lastError = error;

      console.error(
        `[SMART RETRY] ${label}`,
        errorMessage(error)
      );

      if (
        !isRetryable(error) ||
        attempt === MAX_RETRIES
      ) {

        throw error;

      }

      const delay =
        Math.min(
          60000,
          2000 * Math.pow(2, attempt - 1)
        ) +
        Math.floor(Math.random() * 1000);

      if (job) {

        job.message =
          `Temporary error. Retry in ${Math.ceil(delay / 1000)}s`;

      }

      await sleep(delay);

    }

  }

  throw lastError;
}

// ======================================================
// JOB UPDATE
// ======================================================

function updateJob(job, data) {

  Object.assign(job, data);

  job.updatedAt =
    new Date().toISOString();

}

// ======================================================
// PHOTO PROCESSING
// ======================================================

function getPhotos(photos = []) {

  return photos
    .slice(0, 4)
    .filter(photo => photo && photo.data)
    .map(photo => {

      let data = String(photo.data);

      if (data.includes(",")) {

        data = data.split(",").pop();

      }

      return {
        inlineData: {
          mimeType:
            photo.mimeType ||
            photo.type ||
            "image/jpeg",

          data
        }
      };

    });

}

// ======================================================
// GEMINI STORYBOARD
// ======================================================

function parseJSON(text) {

  const clean =
    String(text)
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");

  if (start === -1 || end === -1) {

    throw new Error(
      "Gemini tidak menghasilkan JSON storyboard."
    );

  }

  return JSON.parse(
    clean.substring(start, end + 1)
  );

}

async function generateStoryboard(
  config,
  photos,
  job
) {

  if (!gemini) {

    throw new Error(
      "GEMINI_API_KEY belum dikonfigurasi."
    );

  }

  const photoParts = getPhotos(photos);

  const prompt = `
You are an expert commercial advertising director.

Create a professional advertising storyboard
for a premium commercial video.

Return ONLY JSON in this format:

{
 "title":"Campaign title",
 "scenes":[
  {
   "number":1,
   "duration":6,
   "visual":"Visual description",
   "camera":"Camera movement",
   "prompt":"Detailed cinematic Veo prompt",
   "voiceover":"Voiceover"
  }
 ]
}

Requirements:
- Exactly 4 scenes.
- Realistic cinematic commercial.
- Product appearance consistent.
- Professional camera movements.
- No text overlays inside generated footage.
- No watermark.
- Each prompt must be standalone.

Product: ${config.product || "Product"}
Tagline: ${config.tagline || ""}
Style: ${config.style || "Premium cinematic"}
Audience: ${config.audience || "General"}
Aspect ratio: ${config.ratio || "16:9"}
`;

  const models = [
    GEMINI_MODEL,
    GEMINI_FALLBACK_MODEL
  ];

  let result;
  let lastError;

  for (const model of models) {

    try {

      result = await smartRetry(
        () => gemini.models.generateContent({

          model,

          contents: [
            ...photoParts,
            prompt
          ],

          config: {
            responseMimeType: "application/json"
          }

        }),

        `Storyboard ${model}`,

        job
      );

      break;

    } catch (error) {

      lastError = error;

      console.warn(
        "Gemini model failed:",
        model,
        errorMessage(error)
      );

    }

  }

  if (!result) {

    throw lastError ||
      new Error("Semua model Gemini gagal.");

  }

  const storyboard =
    parseJSON(result.text);

  if (
    !Array.isArray(storyboard.scenes) ||
    !storyboard.scenes.length
  ) {

    throw new Error(
      "Storyboard tidak mempunyai scene."
    );

  }

  storyboard.scenes =
    storyboard.scenes
      .slice(0, 4)
      .map((scene, index) => ({

        number: index + 1,

        duration:
          Number(scene.duration) || 6,

        visual:
          scene.visual || "",

        camera:
          scene.camera || "",

        prompt:
          scene.prompt ||
          scene.visual ||
          config.product,

        voiceover:
          scene.voiceover || ""

      }));

  return storyboard;

}

// ======================================================
// VEO GENERATION
// ======================================================

async function generateVeoVideo(
  scene,
  index,
  config,
  job
) {

  if (!veo) {

    throw new Error(
      "Google Cloud Vertex AI belum dikonfigurasi."
    );

  }

  if (!VEO_GCS_BUCKET) {

    throw new Error(
      "VEO_GCS_BUCKET belum ditetapkan."
    );

  }

  const prompt = `
${scene.prompt}

Visual: ${scene.visual}
Camera: ${scene.camera}

Product: ${config.product || "Product"}
Tagline: ${config.tagline || ""}

Professional commercial cinematography.
Realistic lighting.
Premium advertising style.
Smooth camera movement.
No subtitles.
No text overlays.
No watermark.
`;

  const outputUri =
    `gs://${VEO_GCS_BUCKET}/kecik-empire/${job.id}/scene-${index + 1}/`;

  let operation = await smartRetry(

    () => veo.models.generateVideos({

      model: VEO_MODEL,

      prompt,

      config: {

        aspectRatio:
          config.ratio || "16:9",

        durationSeconds:
          Math.max(
            5,
            Math.min(
              8,
              Number(scene.duration) || 6
            )
          ),

        numberOfVideos: 1,

        outputGcsUri: outputUri

      }

    }),

    `Veo Scene ${index + 1}`,

    job

  );

  const deadline =
    Date.now() + JOB_TIMEOUT;

  while (!operation.done) {

    if (Date.now() > deadline) {

      throw new Error(
        `Veo scene ${index + 1} timeout.`
      );

    }

    updateJob(job, {

      stage: "veo_render",

      message:
        `Rendering scene ${index + 1}/${job.totalScenes}`

    });

    await sleep(15000);

    operation = await smartRetry(

      () => veo.operations.get({
        operation
      }),

      `Veo polling ${index + 1}`,

      job

    );

  }

  if (operation.error) {

    throw new Error(
      JSON.stringify(operation.error)
    );

  }

  const generated =
    operation.response?.generatedVideos?.[0] ||
    operation.result?.generatedVideos?.[0];

  const uri =
    generated?.video?.uri;

  if (!uri) {

    throw new Error(
      "Veo tidak memulangkan video URI."
    );

  }

  return uri;

}

// ======================================================
// DOWNLOAD VIDEO FROM GOOGLE CLOUD STORAGE
// ======================================================

async function downloadVideo(
  uri,
  destination
) {

  const match =
    uri.match(/^gs:\/\/([^/]+)\/(.+)$/);

  if (match) {

    await storage
      .bucket(match[1])
      .file(match[2])
      .download({
        destination
      });

    return;

  }

  if (uri.startsWith("https://")) {

    const response =
      await fetch(uri);

    if (!response.ok) {

      throw new Error(
        `Video download HTTP ${response.status}`
      );

    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    fs.writeFileSync(
      destination,
      buffer
    );

    return;

  }

  throw new Error(
    "Video URI tidak sah."
  );

}

// ======================================================
// FFMPEG ASSEMBLY
// ======================================================

async function assembleMP4(
  clips,
  output
) {

  if (!clips.length) {

    throw new Error(
      "Tiada klip video untuk assembly."
    );

  }

  const concatFile =
    path.join(
      path.dirname(output),
      "concat.txt"
    );

  const list =
    clips
      .map(file =>
        `file '${file.replace(/'/g, "'\\''")}'`
      )
      .join("\n");

  fs.writeFileSync(
    concatFile,
    list
  );

  await execFileAsync(

    "ffmpeg",

    [

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

      "-pix_fmt",
      "yuv420p",

      "-c:a",
      "aac",

      "-b:a",
      "128k",

      "-movflags",
      "+faststart",

      output

    ],

    {
      timeout: JOB_TIMEOUT
    }

  );

}

// ======================================================
// COMPLETE PRODUCTION JOB
// ======================================================

async function runProduction(
  job,
  config,
  photos
) {

  const temp =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        `kecik-${job.id}-`
      )
    );

  try {

    // STEP 1: STORYBOARD

    updateJob(job, {

      status: "processing",

      stage: "storyboard",

      progress: 5,

      message:
        "Generating storyboard with Gemini..."

    });

    const storyboard =
      await generateStoryboard(
        config,
        photos,
        job
      );

    updateJob(job, {

      storyboard,

      totalScenes:
        storyboard.scenes.length,

      stage: "storyboard_ready",

      progress: 15,

      message:
        "Storyboard completed."

    });

    // STEP 2: VEO RENDER

    const clips = [];

    for (
      let i = 0;
      i < storyboard.scenes.length;
      i++
    ) {

      updateJob(job, {

        stage: "veo_render",

        progress:
          15 +
          Math.round(
            i /
            storyboard.scenes.length *
            70
          ),

        message:
          `Rendering scene ${i + 1}`

      });

      const uri =
        await generateVeoVideo(
          storyboard.scenes[i],
          i,
          config,
          job
        );

      const clip =
        path.join(
          temp,
          `scene-${i + 1}.mp4`
        );

      await downloadVideo(
        uri,
        clip
      );

      clips.push(clip);

      updateJob(job, {

        completedScenes:
          clips.length

      });

    }

    // STEP 3: FFMPEG

    updateJob(job, {

      stage: "assembly",

      progress: 90,

      message:
        "FFmpeg assembling final MP4..."

    });

    const finalVideo =
      path.join(
        temp,
        "final.mp4"
      );

    await assembleMP4(
      clips,
      finalVideo
    );

    // STEP 4: SAVE MP4

    const videoFolder =
      path.join(
        __dirname,
        "public",
        "videos"
      );

    fs.mkdirSync(
      videoFolder,
      { recursive: true }
    );

    const filename =
      `${job.id}.mp4`;

    const savedVideo =
      path.join(
        videoFolder,
        filename
      );

    fs.copyFileSync(
      finalVideo,
      savedVideo
    );

    // STEP 5: COMPLETE

    updateJob(job, {

      status: "completed",

      stage: "completed",

      progress: 100,

      message:
        "Final MP4 completed successfully.",

      videoUrl:
        `/videos/${filename}`,

      completedScenes:
        clips.length,

      finishedAt:
        new Date().toISOString()

    });

  } catch (error) {

    console.error(
      "Production failed:",
      error
    );

    updateJob(job, {

      status: "failed",

      stage: "failed",

      progress: 0,

      error:
        errorMessage(error),

      message:
        errorMessage(error),

      finishedAt:
        new Date().toISOString()

    });

  } finally {

    fs.rmSync(
      temp,
      {
        recursive: true,
        force: true
      }
    );

  }

}

// ======================================================
// VIDEO FILES
// ======================================================

app.use(

  "/videos",

  express.static(
    path.join(
      __dirname,
      "public",
      "videos"
    )
  )

);

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/", (req, res) => {

  res.json({

    ok: true,

    service:
      "kecik-empire-ai-factory",

    version: "3.5"

  });

});

app.get("/api/health", (req, res) => {

  res.json({

    ok: true,

    service:
      "kecik-empire-ai-factory",

    version: "3.5",

    storyboardModel:
      GEMINI_MODEL,

    fallbackModel:
      GEMINI_FALLBACK_MODEL,

    veoModel:
      VEO_MODEL,

    geminiConfigured:
      Boolean(GEMINI_API_KEY),

    veoConfigured:
      Boolean(
        GOOGLE_CLOUD_PROJECT &&
        VEO_GCS_BUCKET
      ),

    time:
      new Date().toISOString()

  });

});

// ======================================================
// STATUS API
// ======================================================

function statusHandler(req, res) {

  const job =
    jobs.get(
      req.params.jobId
    );

  if (!job) {

    return res.status(404).json({

      error:
        "Job ID tidak dijumpai."

    });

  }

  res.json(job);

}

app.get(
  "/production/status/:jobId",
  statusHandler
);

app.get(
  "/api/production/status/:jobId",
  statusHandler
);

// ======================================================
// START PRODUCTION API
// ======================================================

async function startProduction(
  req,
  res
) {

  const config =
    req.body?.config ||
    req.body ||
    {};

  const photos =
    Array.isArray(req.body?.photos)
      ? req.body.photos
      : [];

  if (
    !photos.some(
      photo => photo && photo.data
    )
  ) {

    return res.status(400).json({

      error:
        "Upload sekurang-kurangnya satu foto produk."

    });

  }

  if (!GEMINI_API_KEY) {

    return res.status(500).json({

      error:
        "GEMINI_API_KEY belum dikonfigurasi."

    });

  }

  const id =
    crypto.randomUUID();

  const job = {

    id,

    jobId: id,

    status: "queued",

    stage: "queued",

    progress: 0,

    completedScenes: 0,

    totalScenes: 0,

    message:
      "Job accepted.",

    createdAt:
      new Date().toISOString()

  };

  jobs.set(
    id,
    job
  );

  res.status(202).json({

    id,

    jobId: id,

    status: "queued",

    message:
      "Production job accepted."

  });

  runProduction(
    job,
    config,
    photos
  ).catch(error => {

    updateJob(job, {

      status: "failed",

      stage: "failed",

      error:
        errorMessage(error)

    });

  });

}

app.post(
  "/production/start",
  startProduction
);

app.post(
  "/api/production/start",
  startProduction
);

// ======================================================
// ERROR HANDLER
// ======================================================

app.use((error, req, res, next) => {

  console.error(
    "HTTP ERROR:",
    error
  );

  if (res.headersSent) {

    return next(error);

  }

  res.status(
    error.status || 500
  ).json({

    error:
      errorMessage(error)

  });

});

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  () => {

    console.log(
      `Kecik Empire AI Factory V3.5 listening on ${PORT}`
    );

  }
);
