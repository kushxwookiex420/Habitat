/**
 * Habitat product-demo renderer.
 * Only accepts direct HTTPS media URLs with explicit permission confirmation.
 * Search results are never downloaded implicitly. Output is QA-gated and approval-gated.
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runVisualQA } from "./visual-qa.mjs";

const execFileAsync = promisify(execFile);
const outputs = new Map();
const MAX_CLIPS = 4;
const MAX_BYTES_PER_CLIP = 35 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 30;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") ||
      x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") ||
      x.startsWith("feb") || x.startsWith("::ffff:127.") || x.startsWith("::ffff:10.");
  }
  return true;
}

async function validatePublicHttps(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Each clip needs a valid direct media URL."); }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname) {
    throw new Error("Only public HTTPS direct-media URLs are accepted.");
  }
  if (u.hostname === "localhost" || u.hostname.endsWith(".localhost") || u.hostname.endsWith(".local")) {
    throw new Error("Private/local hosts are not permitted.");
  }
  if (net.isIP(u.hostname)) {
    if (isPrivateIp(u.hostname)) throw new Error("Private IP addresses are not permitted.");
  } else {
    const records = await dns.lookup(u.hostname, { all:true, verbatim:true });
    if (!records.length || records.some(r => isPrivateIp(r.address))) {
      throw new Error("The media host did not resolve exclusively to public IP addresses.");
    }
  }
  return u;
}

function safeText(v, max = 160) {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
function escDrawText(v) {
  return String(v ?? "").replace(/\\/g,"\\\\").replace(/:/g,"\\:").replace(/'/g,"\\'").replace(/%/g,"\\%").replace(/,/g,"\\,").replace(/\[/g,"\\[").replace(/\]/g,"\\]");
}
function sendError(res, status, error) {
  return res.status(status).json({ ok:false, error:String(error?.message || error).slice(0,500) });
}

export function registerProductDemoRenderer(app) {
  app.get("/product-demo/render/status", (_req,res) => res.json({
    ok:true, feature:"product-demo-renderer", ffmpegWorker:true,
    acceptsOnlyDirectHttpsMedia:true, requiresExplicitReusePermission:true,
    maxClips:MAX_CLIPS, maxBytesPerClip:MAX_BYTES_PER_CLIP,
    note:"Rendering runs only after permissionConfirmed=true for every source. Final output must pass machine Visual QA and still requires user approval to publish."
  }));

  app.post("/product-demo/render", async (req,res) => {
    const productName = safeText(req.body?.productName,120);
    const clips = Array.isArray(req.body?.clips) ? req.body.clips : [];
    const voiceover = safeText(req.body?.voiceover,4500);
    const callToAction = safeText(req.body?.callToAction || "See product details at DropPilot AI",100);
    if (!productName) return sendError(res,400,"productName is required.");
    if (!clips.length || clips.length > MAX_CLIPS) return sendError(res,400,"Supply 1 to 4 direct video clips.");
    if (clips.some(c => c?.permissionConfirmed !== true)) return sendError(res,403,"Every source must have confirmed commercial reuse permission.");
    if (voiceover.length < 40) return sendError(res,400,"Provide a fact-checked voiceover of at least 40 characters.");
    let dir;
    try {
      const sources = [];
      for (const clip of clips) {
        const url = await validatePublicHttps(String(clip.url || ""));
        const start = Number(clip.startSeconds ?? 0);
        const end = Number(clip.endSeconds);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end-start > MAX_VIDEO_SECONDS) {
          throw new Error("Each clip needs valid start/end times and may be at most 30 seconds.");
        }
        sources.push({url:url.toString(),start,end});
      }
      dir = await fs.mkdtemp(path.join(os.tmpdir(),"habitat-product-demo-"));
      const sourcePaths = [];
      for (let i=0;i<sources.length;i++) {
        const source = sources[i];
        const response = await fetch(source.url,{redirect:"manual",signal:AbortSignal.timeout(20000),headers:{"User-Agent":"HabitatAx/1.0 product-demo-renderer","Accept":"video/mp4,video/webm,video/quicktime,application/octet-stream"}});
        if (response.status >= 300 && response.status < 400) throw new Error("Redirected media URLs are not accepted; use the final direct media URL after verifying its rights.");
        if (!response.ok) throw new Error("Media download failed with HTTP "+response.status);
        const type = String(response.headers.get("content-type")||"").toLowerCase();
        if (!(type.startsWith("video/") || type.includes("octet-stream"))) throw new Error("Source "+(i+1)+" is not served as a video file.");
        const declared = Number(response.headers.get("content-length")||0);
        if (declared > MAX_BYTES_PER_CLIP) throw new Error("Source "+(i+1)+" exceeds the 35 MB limit.");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Could not read video source "+(i+1)+".");
        const chunks=[]; let bytes=0;
        while (true) {
          const {done,value}=await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES_PER_CLIP) { await reader.cancel(); throw new Error("Source "+(i+1)+" exceeds the 35 MB limit."); }
          chunks.push(Buffer.from(value));
        }
        if (bytes < 4096) throw new Error("Source "+(i+1)+" is too small to be a usable video.");
        const file = path.join(dir,"source-"+i+".mp4");
        await fs.writeFile(file,Buffer.concat(chunks));
        await execFileAsync("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=codec_type","-of","csv=p=0",file],{timeout:15000});
        sourcePaths.push({path:file,start:source.start,end:source.end});
      }

      const inputArgs=[];
      const filters=[];
      sourcePaths.forEach((s,i)=>{
        inputArgs.push("-ss",String(s.start),"-t",String(s.end-s.start),"-i",s.path);
        filters.push("["+i+":v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=25,format=yuv420p,setpts=PTS-STARTPTS[v"+i+"]");
      });
      filters.push(sourcePaths.map((_,i)=>"[v"+i+"]").join("")+"concat=n="+sourcePaths.length+":v=1:a=0,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.28:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='"+escDrawText(productName)+"':fontcolor=white:fontsize=52:box=1:boxcolor=black@0.45:boxborderw=24:x=(w-text_w)/2:y=140,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='"+escDrawText(callToAction)+"':fontcolor=white:fontsize=34:box=1:boxcolor=black@0.55:boxborderw=20:x=(w-text_w)/2:y=h-240[v]");
      const voiceFile=path.join(dir,"voiceover.mp3");
      const words=voiceover.split(/\s+/);
      const chunks=[];let current="";
      for(const word of words){const next=current?current+" "+word:word;if(next.length>170&&current){chunks.push(current);current=word;}else current=next;}
      if(current)chunks.push(current);
      const voiceFiles=[];
      for(let i=0;i<chunks.length;i++){
        const url="https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en-US&q="+encodeURIComponent(chunks[i]);
        const r=await fetch(url,{signal:AbortSignal.timeout(15000),headers:{"User-Agent":"Mozilla/5.0 HabitatAx/1.0","Accept":"audio/mpeg"}});
        if(!r.ok) throw new Error("Narration generation failed with HTTP "+r.status);
        const b=Buffer.from(await r.arrayBuffer()); if(b.length<500) throw new Error("Narration audio was empty.");
        const p=path.join(dir,"voice-"+i+".mp3"); await fs.writeFile(p,b); voiceFiles.push(p);
      }
      const list=path.join(dir,"voice-list.txt");
      await fs.writeFile(list,voiceFiles.map(p=>"file '"+p.replace(/'/g,"'\\''")+"'").join("\n")+"\n");
      await execFileAsync("ffmpeg",["-hide_banner","-loglevel","error","-y","-f","concat","-safe","0","-i",list,"-c","copy",voiceFile],{timeout:30000});
      const voiceProbe=await execFileAsync("ffprobe",["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",voiceFile],{timeout:15000});
      const voiceDuration=Number(String(voiceProbe.stdout||"").trim());
      const clipDuration=sourcePaths.reduce((sum,s)=>sum+s.end-s.start,0);
      if(!Number.isFinite(voiceDuration)||voiceDuration>clipDuration+0.2) throw new Error("Voiceover is longer than the selected demonstration footage. Add longer authorized clips or shorten the narration before rendering.");

      const id=crypto.randomUUID();
      const outputPath=path.join(dir,"droppilot-product-demo.mp4");
      const duration=sourcePaths.reduce((sum,s)=>sum+s.end-s.start,0);
      await execFileAsync("ffmpeg",[
        "-hide_banner","-loglevel","error","-y",...inputArgs,"-i",voiceFile,
        "-filter_complex",filters.join(";"),"-map","[v]","-map",String(sourcePaths.length)+":a:0",
        "-af","apad","-c:v","libx264","-preset","ultrafast","-crf","25","-c:a","aac","-b:a","128k","-ar","48000","-t",String(Math.max(duration,1)),"-movflags","+faststart",outputPath
      ],{timeout:120000});
      const stat=await fs.stat(outputPath);
      if(!stat.size) throw new Error("FFmpeg produced an empty output.");
      const qa=await runVisualQA({
        artifactPath:outputPath,
        renderPlan:{format:"9:16",scenes:sourcePaths.map((s,i)=>({start:sourcePaths.slice(0,i).reduce((n,x)=>n+x.end-x.start,0),end:sourcePaths.slice(0,i+1).reduce((n,x)=>n+x.end-x.start,0),title:"Product demonstration "+(i+1)})),onScreenText:[{text:productName,fontSize:52,bold:true},{text:callToAction,fontSize:34,bold:false}]},
        expectedSceneCount:sourcePaths.length,requireAudio:true
      });
      const probe=await execFileAsync("ffprobe",["-v","error","-show_entries","format=duration,size:stream=codec_type,width,height","-of","json",outputPath]);
      const meta=JSON.parse(probe.stdout);
      const v=(meta.streams||[]).find(s=>s.codec_type==="video")||{};
      const a=(meta.streams||[]).find(s=>s.codec_type==="audio");
      const durationSeconds=Number(meta.format?.duration||0);
      const verified=qa.status==="VISUAL_PASS"&&Number(v.width)===1080&&Number(v.height)===1920&&Boolean(a)&&durationSeconds>=Math.max(1,duration-0.2);
      outputs.set(id,{outputPath,dir,productName,createdAt:new Date().toISOString(),verified,qa,durationSeconds,bytes:stat.size});
      return res.status(verified?200:422).json({
        ok:verified,id,productName,status:verified?"verified":"blocked",verified,approvalRequired:true,
        artifactUrl:"/product-demo/render/"+id+"/artifact",
        artifact:{type:"mp4",durationSeconds,width:Number(v.width),height:Number(v.height),bytes:stat.size},
        visualQA:qa,
        publishStatus:"not_published",
        note:verified?"Rendered and machine-checked. Human approval is still required before publishing.":"QA blocked this output; resolve reported issues before approval."
      });
    } catch(error) {
      if(dir) await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
      return sendError(res,502,error);
    }
  });

  app.get("/product-demo/render/:id/artifact", async (req,res) => {
    const item=outputs.get(String(req.params.id||""));
    if(!item) return res.status(404).json({ok:false,error:"Rendered product demo is not available on this instance. Render again after a restart."});
    if(!item.verified) return res.status(403).json({ok:false,error:"Only Visual-QA-verified product demos can be retrieved."});
    res.type("video/mp4");
    return res.download(item.outputPath,"droppilot-product-demo.mp4");
  });
}
