'use strict';

/** Kecik Empire AI Factory API v3.5.2
 * Gemini storyboard + asynchronous production job API.
 * Video generation is delegated to a configured Veo/Vertex adapter; this server
 * never reports a fake MP4 as completed.
 */
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const VERSION = '3.5.2';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const VEO_MODEL = process.env.VEO_MODEL || 'veo-3.1-fast-generate-preview';
const MAX_PHOTOS = 4;
const MAX_JOBS = Number(process.env.MAX_JOBS || 50);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 24 * 60 * 60 * 1000);

app.use(cors({ origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()) : true }));
app.use(express.json({ limit: process.env.JSON_LIMIT || '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const jobs = new Map();

function cleanExpiredJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) if (job.createdAt < cutoff) jobs.delete(id);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
}
function publicJob(job) {
  return {
    ok: true, version: VERSION, jobId: job.id, status: job.status, stage: job.stage,
    scenes: job.scenes || 0, completed: job.completed || 0,
    progress: job.progress || 0, message: job.message || '',
    storyboard: job.storyboard || null, videoUrl: job.videoUrl || null,
    error: job.error || null, createdAt: job.createdAt, updatedAt: job.updatedAt
  };
}
function updateJob(job, patch) { Object.assign(job, patch, { updatedAt: new Date().toISOString() }); }
function normalizePhotos(photos) {
  if (!Array.isArray(photos)) return [];
  return photos.slice(0, MAX_PHOTOS).map((p, i) => {
    if (typeof p === 'string') return { name: `photo-${i + 1}`, data: p };
    return { name: p?.name || `photo-${i + 1}`, data: p?.data || p?.base64 || p?.dataUrl || '' };
  }).filter(p => p.data);
}
function stripDataUrl(value) { return String(value).replace(/^data:[^,]*,/, ''); }
function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch (_) {
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error('Gemini returned invalid JSON storyboard.');
  }
}
async function createStoryboard(config = {}, photos = []) {
  if (!ai) throw new Error('GEMINI_API_KEY belum ditetapkan pada Render Environment.');
  const photoParts = normalizePhotos(photos).map(p => ({ inlineData: { mimeType: 'image/jpeg', data: stripDataUrl(p.data) } }));
  const brief = {
    product: config.product || 'Produk', tagline: config.tagline || '',
    brand: config.brand || 'Kecik Empire', cta: config.cta || 'Jom pesan sekarang',
    whatsapp: config.whatsapp || '', duration: config.duration || '15 seconds',
    style: config.style || 'cinematic commercial', language: config.language || 'Bahasa Melayu'
  };
  const prompt = `Create a concise advertising storyboard as VALID JSON only. Use 4 scenes. Schema: {"title":"...","totalDurationSeconds":15,"scenes":[{"scene":1,"durationSeconds":4,"visual":"...","camera":"...","motion":"...","voiceover":"...","onScreenText":"...","veoPrompt":"..."}]}. Keep scene durations totaling 15 seconds, premium commercial visuals, product accurate to supplied photos, no invented claims. Brief: ${JSON.stringify(brief)}`;
  const response = await ai.models.generateContent({ model: GEMINI_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }, ...photoParts] }], config: { temperature: 0.7 } });
  const text = response?.text || response?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const storyboard = extractJson(text);
  if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length < 1) throw new Error('Storyboard JSON tiada senarai scenes.');
  return storyboard;
}

// Health endpoints (both paths kept for compatibility)
app.get('/', (_req, res) => res.json({ ok: true, service: 'kecik-empire-ai-factory', version: VERSION }));
app.get(['/api/health', '/health'], (_req, res) => res.json({ ok: true, service: 'kecik-empire-ai-factory', version: VERSION, geminiModel: GEMINI_MODEL, veoModel: VEO_MODEL, time: new Date().toISOString() }));

// Standalone storyboard endpoint
app.post(['/api/storyboard', '/storyboard'], async (req, res) => {
  try { const storyboard = await createStoryboard(req.body?.config || req.body || {}, req.body?.photos || []); res.json({ ok: true, version: VERSION, storyboard }); }
  catch (e) { res.status(e.message.includes('GEMINI_API_KEY') ? 503 : 502).json({ ok: false, version: VERSION, error: { message: e.message } }); }
});

// Create asynchronous production job. Storyboard is generated first; actual Veo
// rendering requires a separate adapter/configuration and is reported honestly.
async function startProduction(req, res) {
  cleanExpiredJobs();
  const id = crypto.randomUUID();
  const job = { id, status: 'queued', stage: 'queued', progress: 0, scenes: 0, completed: 0, message: 'Job diterima', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  jobs.set(id, job);
  res.status(202).json(publicJob(job));
  (async () => {
    try {
      updateJob(job, { status: 'processing', stage: 'storyboard', progress: 5, message: 'Menjana storyboard dengan Gemini…' });
      const storyboard = await createStoryboard(req.body?.config || {}, req.body?.photos || []);
      updateJob(job, { storyboard, scenes: storyboard.scenes.length, stage: 'storyboard_ready', progress: 20, message: 'Storyboard siap. Render Veo memerlukan konfigurasi adapter.' });
      if (typeof globalThis.renderVeoScenes !== 'function') {
        throw new Error('Storyboard berjaya, tetapi Veo renderer belum dikonfigurasi. Sediakan Vertex AI/Veo adapter; job tidak akan menghasilkan MP4 palsu.');
      }
      updateJob(job, { stage: 'rendering', message: 'Render scene Veo sedang berjalan…' });
      const result = await globalThis.renderVeoScenes({ storyboard, config: req.body?.config || {}, photos: normalizePhotos(req.body?.photos || []) }, (done, total) => {
        updateJob(job, { completed: done, scenes: total, progress: 20 + Math.round(70 * done / Math.max(total, 1)), message: `Render scene ${done}/${total}` });
      });
      if (!result?.videoUrl) throw new Error('Veo renderer tidak memulangkan videoUrl.');
      updateJob(job, { status: 'completed', stage: 'completed', progress: 100, completed: job.scenes, videoUrl: result.videoUrl, message: 'Video siap.' });
    } catch (e) {
      console.error(`[job ${id}]`, e);
      updateJob(job, { status: 'failed', stage: 'failed', message: e.message, error: { message: e.message } });
    }
  })();
}
app.post(['/api/production/start', '/production/start'], startProduction);
app.get(['/api/production/status/:jobId', '/production/status/:jobId'], (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, version: VERSION, error: { message: 'Job tidak dijumpai atau telah tamat tempoh.' } });
  res.json(publicJob(job));
});
app.get(['/api/production/jobs/:jobId', '/production/jobs/:jobId'], (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: { message: 'Job not found' } });
  res.json(publicJob(job));
});

app.use((err, _req, res, _next) => {
  console.error('[Express error]', err);
  res.status(err.status || 500).json({ ok: false, version: VERSION, error: { message: err.message || 'Internal server error' } });
});

app.listen(PORT, () => {
  console.log(`Kecik Empire API V${VERSION} listening on ${PORT}`);
  console.log(`Gemini Model: ${GEMINI_MODEL}`);
  console.log(`Veo Model: ${VEO_MODEL}`);
  console.log(`FFmpeg: ${process.env.FFMPEG_PATH || 'not configured (renderer adapter required)'}`);
});
