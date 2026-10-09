#!/usr/bin/env bash
set -euo pipefail

OUT="${1:-habitat-artifact-001.mp4}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Use real official Rockstar GTA VI screenshots, not colored placeholder cards.
python - "$TMP" <<'PY'
import os, sys, urllib.request
root=sys.argv[1]
urls=[
 "https://www.rockstargames.com/VI/_next/static/media/Jason_and_Lucia_08.0.bq0bdrl6g5y.jpg?akim=1&imdensity=1&imwidth=960",
 "https://www.rockstargames.com/VI/_next/static/media/Vice_City_10.0f1q-xa_4q8r2.jpg?akim=1&imdensity=1&imwidth=960",
 "https://www.rockstargames.com/VI/_next/static/media/Jason_Duval_02.1486~7_v40cn..jpg?akim=1&imdensity=1&imwidth=960",
 "https://www.rockstargames.com/VI/_next/static/media/Lucia_Caminos_01.0a7yqvewctkfp.jpg?akim=1&imdensity=1&imwidth=960",
 "https://www.rockstargames.com/VI/_next/static/media/Vice_City_01.135x56yoeu.6t.jpg?akim=1&imdensity=1&imwidth=960",
 "https://www.rockstargames.com/VI/_next/static/media/Ambrosia_06.0j9c7-8nfb_xf.jpg?akim=1&imdensity=1&imwidth=960",
]
for i,url in enumerate(urls,1):
 req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0 HabitatVideoBuilder/1.0"})
 with urllib.request.urlopen(req,timeout=20) as r:
  data=r.read()
  if len(data)<10000: raise RuntimeError(f"Screenshot {i} too small to be a real image")
  ctype=r.headers.get("Content-Type","")
  if not ctype.startswith("image/"): raise RuntimeError(f"Screenshot {i} was not an image: {ctype}")
  open(os.path.join(root,f"scene{i}.jpg"),"wb").write(data)
print("Downloaded 6 official Rockstar screenshot assets.")
PY

# Natural-paced voiceover. If the free TTS endpoint fails, fail the build rather than
# shipping a silent video that falsely appears ready.
python - "$TMP" <<'PY'
import json, os, sys, time, urllib.parse, urllib.request
root=sys.argv[1]
lines=[
 "Vice City is back in Grand Theft Auto six, and here are the confirmed details worth knowing.",
 "Rockstar's announced release date is November nineteenth, twenty twenty-six. Dates can change, so always check official updates.",
 "The story follows Jason Duval and Lucia Caminos. Rockstar has introduced both characters in its official materials.",
 "The setting is the fictional state of Leonida, with Vice City at its center. The official screenshots give us a look at its atmosphere.",
 "Rockstar has announced PlayStation five and Xbox Series X and S as launch platforms. Other platform details should be treated as unconfirmed unless Rockstar says otherwise.",
 "That is the difference between facts and rumors. Follow Vice City Files for clear, sourced Grand Theft Auto updates."
]
parts=[]
for i,line in enumerate(lines,1):
 url="https://translate.google.com/translate_tts?"+urllib.parse.urlencode({"ie":"UTF-8","client":"tw-ob","tl":"en-US","q":line})
 req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0"})
 with urllib.request.urlopen(req,timeout=25) as r:
  audio=r.read()
 if len(audio)<1000: raise RuntimeError(f"TTS chunk {i} is empty or too small")
 path=os.path.join(root,f"voice{i}.mp3")
 open(path,"wb").write(audio)
 parts.append(path)
with open(os.path.join(root,"voice.txt"),"w") as f:
 for p in parts: f.write("file '"+p.replace("'","'\\''")+"'\n")
PY
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$TMP/voice.txt" -ac 2 -ar 48000 "$TMP/voice.mp3"
test -s "$TMP/voice.mp3"

# Six real-image scenes with legible phone-first typography and gentle motion.
ffmpeg -hide_banner -loglevel error -y \
  -loop 1 -t 7.5 -i "$TMP/scene1.jpg" \
  -loop 1 -t 7.5 -i "$TMP/scene2.jpg" \
  -loop 1 -t 7.5 -i "$TMP/scene3.jpg" \
  -loop 1 -t 7.5 -i "$TMP/scene4.jpg" \
  -loop 1 -t 7.5 -i "$TMP/scene5.jpg" \
  -loop 1 -t 7.5 -i "$TMP/scene6.jpg" \
  -i "$TMP/voice.mp3" \
  -filter_complex "
[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(1.035,zoom+0.00015)':d=1:s=1080x1920:fps=15,drawbox=x=0:y=220:w=1080:h=370:color=black@0.48:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='VICE CITY IS BACK':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=330,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='GTA VI  |  OFFICIAL DETAILS':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=430,setsar=1[v0];
[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(1.035,zoom+0.00015)':d=1:s=1080x1920:fps=15,drawbox=x=0:y=220:w=1080:h=370:color=black@0.48:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='NOVEMBER 19, 2026':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=330,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='ANNOUNCED RELEASE DATE':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=430,setsar=1[v1];
[2:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(1.035,zoom+0.00015)':d=1:s=1080x1920:fps=15,drawbox=x=0:y=220:w=1080:h=370:color=black@0.48:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='JASON + LUCIA':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=330,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='THE MAIN CHARACTERS':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=430,setsar=1[v2];
[3:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(1.035,zoom+0.00015)':d=1:s=1080x1920:fps=15,drawbox=x=0:y=220:w=1080:h=370:color=black@0.48:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='WELCOME TO LEONIDA':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=330,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='VICE CITY AND BEYOND':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=430,setsar=1[v3];
[4:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(1.035,zoom+0.00015)':d=1:s=1080x1920:fps=15,drawbox=x=0:y=220:w=1080:h=370:color=black@0.48:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='PS5 + XBOX SERIES X|S':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=330,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='ANNOUNCED PLATFORMS':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=430,setsar=1[v4];
[5:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(1.035,zoom+0.00015)':d=1:s=1080x1920:fps=15,drawbox=x=0:y=220:w=1080:h=370:color=black@0.48:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='FACTS, NOT RUMORS':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=330,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='FOLLOW VICE CITY FILES':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=430,setsar=1[v5];
[v0][v1][v2][v3][v4][v5]concat=n=6:v=1:a=0,trim=duration=45,setpts=PTS-STARTPTS,format=yuv420p[v]
" \
  -map "[v]" -map 6:a:0 \
  -c:v libx264 -preset ultrafast -crf 25 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -ar 48000 -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
  -t 45 -shortest -movflags +faststart "$OUT"

test -s "$OUT"
ffprobe -v error -show_entries format=duration,size:stream=codec_type,width,height,r_frame_rate -of json "$OUT" > "$TMP/probe.json"
python - "$TMP/probe.json" "$OUT" <<'PY'
import json, os, sys
p=json.load(open(sys.argv[1])); size=os.path.getsize(sys.argv[2]); duration=float(p["format"]["duration"])
streams=p["streams"]; video=next(s for s in streams if s["codec_type"]=="video")
audio=next(s for s in streams if s["codec_type"]=="audio")
assert size>100000, f"Artifact unexpectedly small: {size}"
assert duration>=44, f"Artifact too short: {duration}"
assert int(video["width"])==1080 and int(video["height"])==1920
assert video["r_frame_rate"]=="15/1"
assert audio.get("codec_type")=="audio"
print(json.dumps({"verified":True,"bytes":size,"durationSeconds":duration,"width":1080,"height":1920,"renderer":"rockstar-images-plus-narration-v2","audio":"narration-present","scenes":6}))
PY
