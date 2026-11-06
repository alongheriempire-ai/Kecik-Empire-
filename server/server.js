import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
dotenv.config();

const app=express();
const PORT=process.env.PORT||8787;
const FRONTEND_ORIGINS=(process.env.FRONTEND_ORIGINS||"*").split(",").map(x=>x.trim());
app.use(cors({origin:(origin,cb)=>{if(!origin||FRONTEND_ORIGINS.includes("*")||FRONTEND_ORIGINS.includes(origin))return cb(null,true);cb(new Error("Origin not allowed by FRONTEND_ORIGINS"));}}));
app.use(express.json({limit:"30mb"}));
const jobs=new Map();
const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
const root=path.dirname(fileURLToPath(import.meta.url));
const outDir=path.resolve(root,process.env.OUTPUT_DIR||"outputs");
fs.mkdirSync(outDir,{recursive:true});

app.get("/",(_,res)=>res.json({service:"Kecik Empire AI Factory API",version:"3.3",health:"/api/health"}));
app.get("/api/health",(_,res)=>res.json({ok:true,service:"kecik-empire-ai-factory",version:"3.3",time:new Date().toISOString()}));
app.get("/api/production/status/:id",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job ID not found"});res.json(j);});
app.post("/api/production/start",async(req,res)=>{
  try{
    const {config={},photos=[],geminiApiKey}=req.body||{};
    if(!photos.length)return res.status(400).json({error:"Upload at least one product photo."});
    const jobId=randomUUID();const job={jobId,status:"queued",stage:"queued",progress:0,completedScenes:0,totalScenes:0,message:"Job accepted. Creating storyboard…",createdAt:new Date().toISOString(),storyboard:null,finalVideoUrl:null};
    jobs.set(jobId,job);res.status(202).json({jobId,status:"queued",message:"Job accepted"});
    runJob(jobId,config,photos,geminiApiKey).catch(e=>{const j=jobs.get(jobId);if(j){j.status="failed";j.stage="failed";j.error=e.message;j.message=e.message;}console.error("Job failed",jobId,e);});
  }catch(e){res.status(500).json({error:e.message});}
});

async function runJob(id,cfg,photos,keyOverride){
 const j=jobs.get(id);j.status="processing";j.stage="storyboard";j.message="Generating storyboard with Gemini";j.progress=5;
 const client=keyOverride?new GoogleGenAI({apiKey:keyOverride}):ai;
 const prompt=`Create a ${cfg.duration||30}-second ${cfg.ratio||"9:16"} commercial storyboard in JSON. Product: ${cfg.product||"product"}. Tagline: ${cfg.tagline||""}. CTA: ${cfg.cta||""}. Style: ${cfg.style||""}. Music: ${cfg.music||""}. Voice: ${cfg.voice||""}. Direction: ${cfg.extra||""}. Preserve exact product appearance from supplied reference photos; do not invent ingredients or alter packaging. Output {"title":"...","scenes":[{"time":"0-5s","title":"...","visual":"...","veoPrompt":"..."}]}. Return only JSON.`;
 const parts=[{text:prompt},...photos.slice(0,4).map(p=>({inlineData:{mimeType:p.mimeType||"image/jpeg",data:p.data}}))];
 const response=await client.models.generateContent({model:process.env.GEMINI_STORYBOARD_MODEL||"Update Gemini 3.8 Flash model",contents:[{role:"user",parts}],config:{responseMimeType:"application/json"}});
 let story=JSON.parse(response.text);j.storyboard=story;j.totalScenes=story.scenes?.length||0;j.stage="storyboard_ready";j.message="Storyboard ready. Video rendering requires configured Veo workflow.";j.progress=15;
 // Deployment-safe honest state: no fabricated completed MP4.
 j.status="awaiting_video_provider";j.stage="provider_required";j.message="Storyboard generated. Configure Veo rendering adapter and FFmpeg pipeline to create MP4.";
 j.updatedAt=new Date().toISOString();
}
app.listen(PORT,()=>console.log(`Kecik Empire API V3.3 listening on ${PORT}`));
