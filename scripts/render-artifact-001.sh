#!/usr/bin/env bash
set -euo pipefail

OUT="${1:-habitat-artifact-001.mp4}"
SCRIPT_JSON="${2:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Official Rockstar stills are paired with six distinct real-world video clips.
# The on-screen disclaimer makes clear that the stock clips are not GTA gameplay.
python - "$TMP" "$SCRIPT_JSON" <<'PY'
import json, os, re, sys, urllib.request
root, script_path = sys.argv[1], sys.argv[2]
urls=[
 "https://www.rockstargames.com/VI/_next/static/media/Jason_and_Lucia_08.0.bq0bdrl6g5y.jpg?akim=1&imdensity=1&imwidth=960",
 "https://www.rockstargames.com/VI/_next/static/media/Vice_City_10.0f1q-xa_4q8r2.jpg?akim=1&imdensity=1&imwidth=960",
 "https://www.rockstargames.com/VI/_next/static/media/Jason_Duval_02.1486~7_v40cn..jpg?akim=1&imdensity=1&imwidth=960",
 "https://www.rockstargames.com/VI/_next/static/media/Lucia_Caminos_01.0a7yqvewctkfp.jpg?akim=1&imdensity=1&imwidth=960",
 "https://www.rockstargames.com/VI/_next/static/media/Vice_City_01.135x56yoeu.6t.jpg?akim=1&imdensity=1&imwidth=960",
 "https://www.rockstargames.com/VI/_next/static/media/Ambrosia_06.0j9c7-8nfb_xf.jpg?akim=1&imdensity=1&imwidth=960",
]
for i,url in enumerate(urls,1):
 req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0 HabitatVideoBuilder/3.0"})
 with urllib.request.urlopen(req,timeout=25) as r:
  data=r.read()
  if len(data)<10000: raise RuntimeError(f"Screenshot {i} too small to be a real image")
  if not r.headers.get("Content-Type","").startswith("image/"):
   raise RuntimeError(f"Screenshot {i} was not an image")
  open(os.path.join(root,f"scene{i}.jpg"),"wb").write(data)
broll=[
 ("https://videos.pexels.com/video-files/37461919/15867630_360_640_60fps.mp4","https://www.pexels.com/video/aerial-view-of-miami-skyline-at-dusk-37461919/","paashuu"),
 ("https://videos.pexels.com/video-files/34594007/14659483_360_640_30fps.mp4","https://www.pexels.com/video/cloudy-miami-skyline-across-the-bay-34594007/","Messiedo Xadinho"),
 ("https://videos.pexels.com/video-files/34679320/14699430_360_640_60fps.mp4","https://www.pexels.com/video/nighttime-city-street-with-moving-vehicles-34679320/","Evgenij Mikhailov"),
 ("https://videos.pexels.com/video-files/36905735/15633523_360_640_60fps.mp4","https://www.pexels.com/video/scenic-coastal-road-with-palm-trees-and-traffic-36905735/","Kaushik Mahadevan"),
 ("https://videos.pexels.com/video-files/39402632/16776918_360_640_30fps.mp4","https://www.pexels.com/video/aerial-view-of-miami-s-sunny-waterfront-39402632/","Maryna"),
 ("https://videos.pexels.com/video-files/34679319/14699412_360_640_60fps.mp4","https://www.pexels.com/video/nighttime-city-street-with-passing-car-and-streetlights-34679319/","Evgenij Mikhailov"),
]
for i,(url,page,creator) in enumerate(broll,1):
 req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0 HabitatVideoBuilder/3.0"})
 with urllib.request.urlopen(req,timeout=40) as r:
  data=r.read()
  if len(data)<50000: raise RuntimeError(f"Moving B-roll clip {i} is too small")
  open(os.path.join(root,f"clip{i}.mp4"),"wb").write(data)
with open(os.path.join(root,"broll-attribution.txt"),"w",encoding="utf-8") as f:
 f.write("Real-world B-roll (NOT GTA gameplay) — Pexels\n")
 f.write("Used as illustrative context only; not footage from Grand Theft Auto VI.\n\n")
 for url,page,creator in broll: f.write(f"{creator} — {page}\n")
fallback_voice = [
 "Vice City is back in Grand Theft Auto six. Here are the official details worth knowing.",
 "Rockstar has announced November nineteenth, twenty twenty-six as the release date. Release plans can change, so check Rockstar's official updates.",
 "The story follows Jason Duval and Lucia Caminos, two characters Rockstar has introduced in its official materials.",
 "The setting is Leonida, a fictional state inspired by Florida, with Vice City at its center. These official images offer a look at its world.",
 "Rockstar has announced PlayStation five and Xbox Series X and S for launch. Treat other platform claims as unconfirmed unless Rockstar announces them.",
 "That is what we know from official sources, without mixing in rumors. Follow Vice City Files for clear, sourced updates."
]
script = {}
if script_path and os.path.isfile(script_path):
 try:
  payload=json.load(open(script_path,encoding="utf-8"))
  script=(payload.get("job",{}).get("stages",{}).get("script",{}).get("result") or payload.get("script") or payload)
  if not isinstance(script,dict): script={}
 except Exception as exc:
  print("Script JSON unavailable; using safe fallback narration:",str(exc))
voice=re.sub(r"\s+"," ",str(script.get("voiceover","") or "")).strip()
if len(voice)<80:
 voice=" ".join(fallback_voice)
 print("Script did not contain production-length narration; using canonical fact-safe fallback.")
sentences=[x.strip() for x in re.split(r"(?<=[.!?])\s+",voice) if x.strip()]
if len(sentences)>=6:
 buckets=[[] for _ in range(6)]
 for sentence_index,sentence in enumerate(sentences):
  scene_index=min(5,(sentence_index*6)//len(sentences))
  buckets[scene_index].append(sentence)
 lines=[" ".join(b) for b in buckets]
else:
 words=voice.split()
 lines=[" ".join(words[(i*len(words))//6:((i+1)*len(words))//6]).rstrip(" ,;:") for i in range(6)]
 lines=[x if x.endswith((".","!","?")) else x+"." for x in lines]
 if any(not x for x in lines): lines=fallback_voice
def clean_label(value,limit,fallback):
 value=re.sub(r"[^A-Za-z0-9 +&-]"," ",str(value or ""))
 value=re.sub(r"\s+"," ",value).strip()
 return (value[:limit].rstrip() or fallback)
raw_titles=script.get("onScreenText",[])
if not isinstance(raw_titles,list): raw_titles=[]
shots=script.get("shotList",[])
if not isinstance(shots,list): shots=[]
fallback_titles=["VICE CITY FACTS","OFFICIAL DETAILS","THE STORY","WHAT IS CONFIRMED","LAUNCH PLATFORMS","FACTS NOT RUMORS"]
fallback_subs=["Confirmed details","Official information","Source-checked update","Facts, not rumors","What Rockstar announced","Follow Vice City Files"]
scene_rows=[]
for i,line in enumerate(lines):
 title=raw_titles[i] if len(raw_titles)>=6 else (shots[i] if i<len(shots) else " ".join(line.split()[:4]))
 subtitle=shots[i] if i<len(shots) else " ".join(line.split()[:7])
 title=clean_label(title,25,fallback_titles[i]).upper()
 subtitle=clean_label(subtitle,34,fallback_subs[i])
 if title.lower()==subtitle.lower(): subtitle=clean_label(" ".join(line.split()[:6]),34,fallback_subs[i])
 scene_rows.append({"voiceover":line,"title":title,"subtitle":subtitle})
with open(os.path.join(root,"scene-plan.json"),"w",encoding="utf-8") as f:
 json.dump({"title":script.get("title","Vice City Files"),"scenes":scene_rows},f,ensure_ascii=False,indent=2)
print("Downloaded six official Rockstar stills and six moving B-roll clips; built a six-scene plan from the current content script.")
PY
# Use a free neural voice instead of the robotic legacy TTS endpoint.
python -m pip install --disable-pip-version-check --quiet edge-tts
python - "$TMP" <<'PY'
import asyncio, json, os, sys
import edge_tts
root=sys.argv[1]
plan=json.load(open(os.path.join(root,"scene-plan.json"),encoding="utf-8"))
lines=[str(scene["voiceover"]) for scene in plan["scenes"]]
if len(lines)!=6 or any(len(line.strip())<8 for line in lines):
 raise RuntimeError("Dynamic scene plan must contain six meaningful narration segments")
async def main():
    parts=[]
    for i,line in enumerate(lines,1):
        path=os.path.join(root,f"voice{i}.mp3")
        communicate=edge_tts.Communicate(line, "en-US-AndrewNeural", rate="-5%", volume="+0%", pitch="+0Hz")
        await communicate.save(path)
        if not os.path.exists(path) or os.path.getsize(path)<1000:
            raise RuntimeError(f"Neural narration chunk {i} is missing or too small")
        parts.append(path)
    with open(os.path.join(root,"voice.txt"),"w") as f:
        for p in parts: f.write("file '"+p.replace("'","'\\''")+"\n")
asyncio.run(main())
PY
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$TMP/voice.txt" -ac 2 -ar 48000 "$TMP/voice.mp3"
test -s "$TMP/voice.mp3"

VOICE_DURATION=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$TMP/voice.mp3")
SCENE_DURATION=$(python - "$VOICE_DURATION" <<'PY'
import sys
print(float(sys.argv[1])/6.0)
PY
)
BODY_DURATION=$(python - "$VOICE_DURATION" <<'PY'
import sys
print(float(sys.argv[1])+1.0)
PY
)
echo "Narration source duration: ${VOICE_DURATION}s; body timeline with one-second ending tail: ${BODY_DURATION}s"

# Each scene gets a dedicated title band above the full, uncropped image and a
# separate footer below it. Only the blurred background gets a barely perceptible drift.
FILTER=""
for i in 0 1 2 3 4 5; do
  n=$((i+1))
  title="$(jq -r ".scenes[$i].title" "$TMP/scene-plan.json")"
  subtitle="$(jq -r ".scenes[$i].subtitle" "$TMP/scene-plan.json")"
  # Escape FFmpeg drawtext punctuation that can occur in the title strings.
  title=$(printf '%s' "$title" | sed 's/[\\:]/\\\\&/g')
  subtitle=$(printf '%s' "$subtitle" | sed 's/[\\:]/\\\\&/g')
  still=$((i+6))
  FILTER+="[$i:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,eq=brightness=-0.18:saturation=0.78,fps=30[base$i];"
  FILTER+="[$still:v]scale=760:650:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba[photo$i];"
  FILTER+="[base$i][photo$i]overlay=(W-w)/2:430+(650-h)/2:shortest=1,"
  FILTER+="drawbox=x=40:y=125:w=1000:h=250:color=black@0.70:t=fill,"
  FILTER+="drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='$title':fontcolor=white:fontsize=44:x=(w-text_w)/2:y=185,"
  FILTER+="drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='$subtitle':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=280,"
  FILTER+="drawbox=x=40:y=1535:w=1000:h=120:color=black@0.60:t=fill,"
  FILTER+="drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='REAL-WORLD B-ROLL • NOT GAMEPLAY • VICE CITY FILES':fontcolor=white:fontsize=21:x=(w-text_w)/2:y=1580,"
  FILTER+="drawbox=x=40:y=1655:w=1000:h=80:color=black@0.72:t=fill,"
  FILTER+="drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='PEXELS: PAASHUU • MESSIEDO XADINHO • EVGENIJ MIKHAILOV • KAUSHIK MAHADEVAN • MARYNA':fontcolor=white:fontsize=14:x=(w-text_w)/2:y=1685,"
  FILTER+="fps=30,setsar=1,format=yuv420p[v$i];"
done
FILTER+="[v0][v1][v2][v3][v4][v5]concat=n=6:v=1:a=0,tpad=stop_mode=clone:stop_duration=2,trim=duration=$BODY_DURATION,setpts=PTS-STARTPTS[v]"

ffmpeg -hide_banner -loglevel error -y \
  -i "$TMP/clip1.mp4" \
  -i "$TMP/clip2.mp4" \
  -i "$TMP/clip3.mp4" \
  -i "$TMP/clip4.mp4" \
  -i "$TMP/clip5.mp4" \
  -i "$TMP/clip6.mp4" \
  -loop 1 -framerate 30 -t "$SCENE_DURATION" -i "$TMP/scene1.jpg" \
  -loop 1 -framerate 30 -t "$SCENE_DURATION" -i "$TMP/scene2.jpg" \
  -loop 1 -framerate 30 -t "$SCENE_DURATION" -i "$TMP/scene3.jpg" \
  -loop 1 -framerate 30 -t "$SCENE_DURATION" -i "$TMP/scene4.jpg" \
  -loop 1 -framerate 30 -t "$SCENE_DURATION" -i "$TMP/scene5.jpg" \
  -loop 1 -framerate 30 -t "$SCENE_DURATION" -i "$TMP/scene6.jpg" \
  -i "$TMP/voice.mp3" \
  -filter_complex "$FILTER" -map "[v]" -map 12:a:0 \
  -c:v libx264 -preset medium -crf 21 -pix_fmt yuv420p \
  -c:a aac -b:a 160k -ar 48000 -af "loudnorm=I=-16:TP=-1.5:LRA=11,apad=pad_dur=1" \
  -t "$BODY_DURATION" -movflags +faststart "$OUT"

test -s "$OUT"
cp "$TMP/broll-attribution.txt" "${OUT}.attribution.txt"
ffprobe -v error -show_entries format=duration,size:stream=codec_type,width,height,r_frame_rate -of json "$OUT" > "$TMP/probe.json"
python - "$TMP/probe.json" "$OUT" "$BODY_DURATION" <<'PY'
import json, os, sys
p=json.load(open(sys.argv[1])); size=os.path.getsize(sys.argv[2]); duration=float(p["format"]["duration"])
streams=p["streams"]; video=next(s for s in streams if s["codec_type"]=="video")
audio=next(s for s in streams if s["codec_type"]=="audio")
assert size>100000, f"Artifact unexpectedly small: {size}"
expected=float(sys.argv[3])
assert duration>=expected-0.2, f"Artifact shorter than measured narration plus tail: {duration} < {expected}"
assert int(video["width"])==1080 and int(video["height"])==1920
assert video["r_frame_rate"]=="30/1"
assert audio.get("codec_type")=="audio"
print(json.dumps({"verified":True,"bytes":size,"durationSeconds":duration,"width":1080,"height":1920,"renderer":"source-duration-neural-narration-v7-moving-broll","audio":"complete-narration-plus-one-second-tail","scenes":6,"expectedBodyDurationSeconds":expected}))
PY
