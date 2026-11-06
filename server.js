import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const app = express();
const PORT = Number(process.env.PORT || 10000);
const VERSION = '3.5.1';
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const STORYBOARD_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const VEO_MODEL = process.env.VEO_MODEL || 'veo-3.1-fast-generate-001';
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 15 * 60 * 1000);
const POLL_MS = Number(process.env.VEO_POLL_MS || 10000);
const MAX_PHOTOS = 4;
const jobs = new Map();

app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;
const now = () => new Date().toISOString();
const safeErr = (e) => String(e?.message || e || 'Unknown error').slice(0, 1200);

app.get('/', (_req, res) => res.json({ ok: true, service: 'kecik-empire-ai-factory', version: VERSION, endpoints: ['/api/health','/api/storyboard','/api/production/start','/api/production/status/:jobId'] }));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'kecik-empire-ai-factory', version: VERSION, time: now(), geminiConfigured: Boolean(API_KEY), storyboardModel: STORYBOARD_MODEL, veoModel: VEO_MODEL, ffmpeg: 'checked on demand' }));

function normalizePhotos(photos) {
  if (!Array.isArray(photos)) return [];
  return photos.slice(0, MAX_PHOTOS).map((p) => {
    if (typeof p === 'string') return { data: p.replace(/^data:image\/[^;]+;base64,/, ''), mimeType: 'image/jpeg' };
    return { data: String(p?.data || p?.base64 || '').replace(/^data:image\/[^;]+;base64,/, ''), mimeType: p?.mimeType || p?.type || 'image/jpeg' };
  }).filter(p => p.data && /^image\/(jpeg|jpg|png|webp)$/i.test(p.mimeType));
}
function campaignPrompt(c = {}) {
  return `Create a premium short commercial storyboard. Product: ${c.product || 'Product'}. Tagline: ${c.tagline || ''}. CTA: ${c.cta || 'Order now'}. Brand: Kecik Empire. WhatsApp: ${c.whatsapp || ''}. Style: cinematic, appetizing, polished Malaysian advertising, realistic product, no misspelled text rendered inside images. Return JSON only with keys title, durationSeconds, scenes (array of 4 to 6 objects with scene, seconds, visual, camera, voiceover, onScreenText, veoPrompt), musicDirection, finalCTA. Each veoPrompt must be a standalone detailed video prompt.`;
}
async function createStoryboard(config, photos = []) {
  if (!ai) throw new Error('GEMINI_API_KEY belum ditetapkan di Render Environment.');
  const parts = [{ text: campaignPrompt(config) }];
  for (const photo of photos) parts.push({ inlineData: { mimeType: photo.mimeType, data: photo.data } });
  const response = await ai.models.generateContent({ model: STORYBOARD_MODEL, contents: [{ role: 'user', parts }], config: { responseMimeType: 'application/json', temperature: 0.7 } });
  const text = response.text || '';
  try { return JSON.parse(text); }
  catch { const match = text.match(/\{[\s\S]*\}/); if (match) return JSON.parse(match[0]); throw new Error('Gemini storyboard returned invalid JSON.'); }
}
app.post('/api/storyboard', async (req, res) => {
  try { const config = req.body?.config || req.body || {}; const photos = normalizePhotos(req.body?.photos); const storyboard = await createStoryboard(config, photos); res.json({ ok: true, version: VERSION, storyboard }); }
  catch (e) { res.status(502).json({ ok: false, error: safeErr(e) }); }
});

// Veo 3.1 Gemini API preview was retired (22 Oct 2026). Video generation below uses
// Vertex AI REST and requires a Google Cloud OAuth access token + project/location.
async function startVeoVertex(prompt, photo, config = {}) {
  const project = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_LOCATION || 'us-central1';
  const token = process.env.GCP_ACCESS_TOKEN;
  if (!project || !token) throw new Error('Veo memerlukan GCP_PROJECT_ID dan GCP_ACCESS_TOKEN (OAuth Vertex AI). Gemini API key sahaja tidak mencukupi untuk Veo GA.');
  const model = process.env.VEO_MODEL || 'veo-3.1-fast-generate-001';
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predictLongRunning`;
  const instance = { prompt };
  if (photo?.data) instance.image = { bytesBase64Encoded: photo.data, mimeType: photo.mimeType };
  const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ instances: [instance], parameters: { aspectRatio: config.aspectRatio || '9:16', durationSeconds: 8, sampleCount: 1 } }), signal: AbortSignal.timeout(60000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Vertex Veo start ${r.status}: ${JSON.stringify(body).slice(0,700)}`);
  if (!body.name) throw new Error('Vertex Veo tidak mengembalikan operation name.');
  return { name: body.name, location, project, token };
}
async function pollVeo(operation) {
  const url = `https://${operation.location}-aiplatform.googleapis.com/v1/${operation.name}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${operation.token}` }, signal: AbortSignal.timeout(60000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Vertex Veo poll ${r.status}: ${JSON.stringify(body).slice(0,700)}`);
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  if (!body.done) return null;
  const uri = body.response?.videos?.[0]?.gcsUri || body.response?.generatedVideos?.[0]?.video?.uri || body.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (!uri) throw new Error('Veo selesai tetapi tiada video URI dalam response.');
  return uri;
}
async function downloadVideo(uri, destination, token) {
  // GCS output is usually gs://; fetch via authenticated storage API.
  if (uri.startsWith('gs://')) {
    const m = uri.match(/^gs:\/\/([^/]+)\/(.+)$/); if (!m) throw new Error('Invalid GCS URI');
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(m[1])}/o/${encodeURIComponent(m[2])}?alt=media`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`GCS download failed: ${r.status}`);
    await fs.writeFile(destination, Buffer.from(await r.arrayBuffer())); return;
  }
  const r = await fetch(uri, { headers: token ? { 'x-goog-api-key': token } : {}, signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`Video download failed: ${r.status}`);
  await fs.writeFile(destination, Buffer.from(await r.arrayBuffer()));
}
async function assemble(files, output) {
  if (!files.length) throw new Error('Tiada scene video untuk assembly.');
  try { await execFileAsync(ffmpegPath || 'ffmpeg', ['-version']); } catch { throw new Error('FFmpeg tidak tersedia pada runtime.'); }
  const listPath = path.join(path.dirname(output), 'concat.txt');
  await fs.writeFile(listPath, files.map(f => `file '${f.replaceAll("'", "'\\''")}'`).join('\n'));
  await execFileAsync(ffmpegPath || 'ffmpeg', ['-y','-f','concat','-safe','0','-i',listPath,'-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-movflags','+faststart',output], { timeout: 300000 });
  return output;
}
async function runJob(job) {
  const started = Date.now();
  job.status = 'running'; job.stage = 'storyboard'; job.updatedAt = now();
  try {
    job.storyboard = await createStoryboard(job.config, job.photos);
    const scenes = job.storyboard.scenes || [];
    if (!scenes.length) throw new Error('Storyboard tidak mengandungi scenes.');
    job.totalScenes = scenes.length; job.stage = 'veo-render';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kecik-'));
    const sceneFiles = [];
    for (let i=0; i<scenes.length; i++) {
      if (Date.now() - started > JOB_TIMEOUT_MS) throw new Error('Job timeout.');
      job.stage = `render-scene-${i+1}/${scenes.length}`; job.currentScene = i+1; job.updatedAt = now();
      const prompt = scenes[i].veoPrompt || scenes[i].visual || scenes[i].prompt || JSON.stringify(scenes[i]);
      const operation = await startVeoVertex(prompt, job.photos[i % Math.max(job.photos.length,1)], job.config);
      let uri = null; const deadline = Date.now() + JOB_TIMEOUT_MS;
      while (!uri && Date.now() < deadline) { await new Promise(r => setTimeout(r, POLL_MS)); uri = await pollVeo(operation); }
      if (!uri) throw new Error('Veo scene timeout.');
      const scenePath = path.join(dir, `scene-${String(i+1).padStart(2,'0')}.mp4`);
      await downloadVideo(uri, scenePath, operation.token); sceneFiles.push(scenePath); job.completedScenes=i+1; job.updatedAt=now();
    }
    job.stage = 'assembling';
    const finalPath = path.join(dir, 'final.mp4'); await assemble(sceneFiles, finalPath);
    job.videoBase64 = (await fs.readFile(finalPath)).toString('base64');
    job.status = 'completed'; job.stage = 'done'; job.completedAt=now(); job.updatedAt=now();
  } catch (e) { job.status='failed'; job.stage='failed'; job.error=safeErr(e); job.updatedAt=now(); console.error(`[job ${job.id}]`, e); }
}
app.post('/api/production/start', (req, res) => {
  const config = req.body?.config || {};
  const photos = normalizePhotos(req.body?.photos);
  if (!config.product && !config.prompt) return res.status(400).json({ ok:false, error:'Product atau prompt diperlukan.' });
  const id = randomUUID();
  const job = { id, status:'queued', stage:'queued', config, photos, storyboard:null, totalScenes:0, completedScenes:0, currentScene:0, createdAt:now(), updatedAt:now(), videoBase64:null, error:null };
  jobs.set(id, job); res.status(202).json({ ok:true, version:VERSION, jobId:id, status:job.status });
  setImmediate(() => runJob(job));
});
app.get('/api/production/status/:jobId', (req,res) => {
  const j=jobs.get(req.params.jobId); if(!j) return res.status(404).json({ok:false,error:'Job ID tidak ditemui.'});
  const response={ ok:true, version:VERSION, jobId:j.id, status:j.status, stage:j.stage, scenes:j.totalScenes, completed:j.completedScenes, currentScene:j.currentScene, storyboard:j.storyboard, error:j.error, createdAt:j.createdAt, updatedAt:j.updatedAt };
  if(j.status==='completed') response.videoUrl=`/api/production/video/${j.id}`;
  res.json(response);
});
app.get('/api/production/video/:jobId', (req,res) => { const j=jobs.get(req.params.jobId); if(!j?.videoBase64) return res.status(404).json({ok:false,error:'Video belum siap.'}); res.type('mp4').send(Buffer.from(j.videoBase64,'base64')); });
app.use((err,_req,res,_next)=>{ console.error(err); res.status(500).json({ok:false,error:safeErr(err)}); });
app.listen(PORT,'0.0.0.0',()=>console.log(`Kecik Empire API V${VERSION} listening on ${PORT}\nGemini Model: ${STORYBOARD_MODEL}\nVeo Model: ${VEO_MODEL}\nFFmpeg: ffmpeg-static (PATH required)`));
