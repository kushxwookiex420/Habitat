#!/usr/bin/env bash
set -euo pipefail

OUT="${1:-habitat-artifact-001.mp4}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Official Rockstar media. Preserve the complete source image in the foreground;
# use a softened, darkened duplicate as the portrait background instead of
# aggressively cropping/zooming the source image.
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
 req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0 HabitatVideoBuilder/2.0"})
 with urllib.request.urlopen(req,timeout=25) as r:
  data=r.read()
  if len(data)<10000: raise RuntimeError(f"Screenshot {i} too small to be a real image")
  if not r.headers.get("Content-Type","").startswith("image/"):
   raise RuntimeError(f"Screenshot {i} was not an image")
  open(os.path.join(root,f"scene{i}.jpg"),"wb").write(data)
print("Downloaded and validated six official Rockstar image assets.")
PY

# Use a free neural voice instead of the robotic legacy TTS endpoint.
python -m pip install --disable-pip-version-check --quiet edge-tts
python - "$TMP" <<'PY'
import asyncio, os, sys
import edge_tts
root=sys.argv[1]
lines=[
 "Vice City is back in Grand Theft Auto six. Here are the official details worth knowing.",
 "Rockstar has announced November nineteenth, twenty twenty-six as the release date. Release plans can change, so check Rockstar's official updates.",
 "The story follows Jason Duval and Lucia Caminos, two characters Rockstar has introduced in its official materials.",
 "The setting is Leonida, a fictional state inspired by Florida, with Vice City at its center. These official images offer a look at its world.",
 "Rockstar has announced PlayStation five and Xbox Series X and S for launch. Treat other platform claims as unconfirmed unless Rockstar announces them.",
 "That is what we know from official sources, without mixing in rumors. Follow Vice City Files for clear, sourced updates."
]
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

# Each scene gets a dedicated title band above the full, uncropped image and a
# separate footer below it. Only the blurred background gets a barely perceptible drift.
TITLES=(
  "VICE CITY IS BACK|GTA VI • OFFICIAL DETAILS"
  "NOVEMBER 19, 2026|ANNOUNCED RELEASE DATE"
  "JASON + LUCIA|THE MAIN CHARACTERS"
  "WELCOME TO LEONIDA|VICE CITY AND BEYOND"
  "PS5 + XBOX SERIES X AND S|ANNOUNCED LAUNCH PLATFORMS"
  "FACTS, NOT RUMORS|FOLLOW VICE CITY FILES"
)
FILTER=""
for i in 0 1 2 3 4 5; do
  n=$((i+1))
  title="${TITLES[$i]%%|*}"
  subtitle="${TITLES[$i]#*|}"
  # Escape FFmpeg drawtext punctuation that can occur in the title strings.
  title=$(printf '%s' "$title" | sed 's/[\\:]/\\\\&/g')
  subtitle=$(printf '%s' "$subtitle" | sed 's/[\\:]/\\\\&/g')
  FILTER+="[$i:v]split=2[bg$i][fg$i];"
  FILTER+="[bg$i]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(1.02,1+on*0.00012)':d=1:s=1080x1920:fps=15,boxblur=24:12,eq=brightness=-0.18:saturation=0.72[base$i];"
  FILTER+="[fg$i]scale=960:1050:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba[photo$i];"
  FILTER+="[base$i][photo$i]overlay=(W-w)/2:430:shortest=1,"
  FILTER+="drawbox=x=40:y=125:w=1000:h=250:color=black@0.70:t=fill,"
  FILTER+="drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='$title':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=185,"
  FILTER+="drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='$subtitle':fontcolor=white:fontsize=27:x=(w-text_w)/2:y=280,"
  FILTER+="drawbox=x=40:y=1535:w=1000:h=120:color=black@0.60:t=fill,"
  FILTER+="drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='VICE CITY FILES  •  FACT-CHECKED GAMING UPDATES':fontcolor=white:fontsize=23:x=(w-text_w)/2:y=1580,"
  FILTER+="fps=15,setsar=1,format=yuv420p[v$i];"
done
FILTER+="[v0][v1][v2][v3][v4][v5]concat=n=6:v=1:a=0,trim=duration=45,setpts=PTS-STARTPTS[v]"

ffmpeg -hide_banner -loglevel error -y \
  -loop 1 -framerate 15 -t 7.5 -i "$TMP/scene1.jpg" \
  -loop 1 -framerate 15 -t 7.5 -i "$TMP/scene2.jpg" \
  -loop 1 -framerate 15 -t 7.5 -i "$TMP/scene3.jpg" \
  -loop 1 -framerate 15 -t 7.5 -i "$TMP/scene4.jpg" \
  -loop 1 -framerate 15 -t 7.5 -i "$TMP/scene5.jpg" \
  -loop 1 -framerate 15 -t 7.5 -i "$TMP/scene6.jpg" \
  -i "$TMP/voice.mp3" \
  -filter_complex "$FILTER" -map "[v]" -map 6:a:0 \
  -c:v libx264 -preset medium -crf 21 -pix_fmt yuv420p \
  -c:a aac -b:a 160k -ar 48000 -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
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
print(json.dumps({"verified":True,"bytes":size,"durationSeconds":duration,"width":1080,"height":1920,"renderer":"uncropped-images-neural-narration-v3","audio":"neural-narration-present","scenes":6}))
PY
