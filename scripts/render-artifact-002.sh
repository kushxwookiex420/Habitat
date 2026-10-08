#!/usr/bin/env bash
set -euo pipefail
OUT="${1:-habitat-artifact-002.mp4}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
B=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
R=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf

# Real local voiceover: deterministic offline TTS, one timed narration segment per scene.
# This replaces the proof-only silence track while keeping the render self-contained.
declare -a DURS=(4 7 8 8 9 9)
declare -a VO=(
"Vice City is coming back — and GTA 6 just got a lot more real."
"Rockstar has GTA 6 scheduled to launch November 19, 2026, and pre-orders are already open."
"The game follows Jason and Lucia after a score goes wrong, pulling them into a criminal conspiracy across Leonida."
"Vice City is back at the center of the story, with Rockstar promising its biggest evolution of the series yet."
"The officially announced launch platforms are PlayStation 5 and Xbox Series X and S."
"So forget the rumors. These are the facts Rockstar has confirmed — and the next leap is almost here."
)

for i in 0 1 2 3 4 5; do
  espeak-ng -q -v en-us -s 145 -p 48 -a 100 -w "$TMP/vo-$i.wav" "${VO[$i]}"
  # Fit each narration clip inside its scene without dropping the voice track.
  dur="${DURS[$i]}"
  ffmpeg -hide_banner -loglevel error -y -i "$TMP/vo-$i.wav"     -af "apad,atrim=0:$dur,asetpts=N/SR/TB" -ar 48000 -ac 2 "$TMP/vo-$i-fit.wav"
done

# Build the six animated 9:16 visual scenes.
scene(){
  local n=$1 d=$2 bg=$3 accent=$4 title=$5 sub=$6
  ffmpeg -hide_banner -loglevel error -y     -f lavfi -i "color=c=$bg:s=540x960:r=15:d=$d"     -vf "drawgrid=width=50:height=50:thickness=1:color=${accent}@0.10,drawbox=x=0:y=610:w=540:h=350:color=0x03040a@0.84:t=fill,drawbox=x=45:y=500:w=80:h=460:color=${accent}@0.16:t=fill,drawbox=x=155:y=455:w=95:h=505:color=${accent}@0.12:t=fill,drawbox=x=285:y=535:w=85:h=425:color=${accent}@0.15:t=fill,drawbox=x=405:y=480:w=90:h=480:color=${accent}@0.12:t=fill,drawbox=x='mod(t*85,700)-100':y=0:w=100:h=960:color=${accent}@0.10:t=fill,drawbox=x=0:y='mod(t*70,960)':w=540:h=3:color=${accent}@0.40:t=fill,drawtext=fontfile=$B:text='AX / VICE CITY FILES':fontcolor=white@0.72:fontsize=16:x=39:y=105,drawtext=fontfile=$B:text='$title':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=275,drawtext=fontfile=$R:text='$sub':fontcolor=white@0.88:fontsize=18:x=(w-text_w)/2:y=340,drawtext=fontfile=$R:text='FACT-CHECKED - NO RUMORS':fontcolor=white@0.62:fontsize=13:x=(w-text_w)/2:y=855,drawtext=fontfile=$R:text='VICE CITY FILES - AX':fontcolor=white@0.58:fontsize=13:x=39:y=905,format=yuv420p"     -c:v libx264 -preset ultrafast -crf 30 -an "$TMP/$n.mp4"
}

scene 01 4 101020 39d9ff "VICE CITY IS BACK" "GTA 6 - THE NEXT BIG LEAP"
scene 02 7 15101f ff3aa7 "NOV. 19, 2026" "OFFICIAL RELEASE DATE"
scene 03 8 0b1419 4cffd0 "JASON + LUCIA" "VICE CITY - LEONIDA"
scene 04 8 160c18 ff4aa8 "VICE CITY - LEONIDA" "THE NEXT EVOLUTION"
scene 05 9 0c1615 45ffb0 "PS5 + XBOX SERIES X/S" "OFFICIALLY ANNOUNCED PLATFORMS"
scene 06 9 130b18 ff4cf0 "FACTS, NOT RUMORS" "HABITAT - AX - VICECITYFILES"

for f in "$TMP"/0*.mp4; do printf "file '%s'\n" "$f"; done > "$TMP/list.txt"

# Concatenate visuals to 45 seconds and concatenate the six real voiceover clips.
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$TMP/list.txt"   -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000:d=45"   -map 0:v:0 -map 1:a:0 -vf scale=1080:1920:flags=fast_bilinear   -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -c:a aac -b:a 96k -ar 48000 -t 45 -shortest "$TMP/video-base.mp4"

printf "file '%s'\n" "$TMP/vo-0-fit.wav" > "$TMP/audio-list.txt"
for i in 1 2 3 4 5; do printf "file '%s'\n" "$TMP/vo-$i-fit.wav" >> "$TMP/audio-list.txt"; done
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$TMP/audio-list.txt" -ar 48000 -ac 2 -c:a pcm_s16le "$TMP/voice.wav"

ffmpeg -hide_banner -loglevel error -y -i "$TMP/video-base.mp4" -i "$TMP/voice.wav"   -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 96k -ar 48000 -t 45 -movflags +faststart "$OUT"

test -s "$OUT"
ffprobe -v error -show_entries format=duration,size:stream=codec_type,width,height,r_frame_rate,codec_name,channels   -of json "$OUT" > "$TMP/probe.json"

python - "$TMP/probe.json" "$OUT" <<'PY'
import json, os, sys
p=json.load(open(sys.argv[1]))
size=os.path.getsize(sys.argv[2])
duration=float(p["format"]["duration"])
video=next(s for s in p["streams"] if s["codec_type"]=="video")
audio=next(s for s in p["streams"] if s["codec_type"]=="audio")
assert size > 0
assert duration >= 44
assert int(video["width"]) == 1080 and int(video["height"]) == 1920
assert video["r_frame_rate"] == "15/1"
assert audio["codec_name"] == "aac"
assert int(audio.get("channels", 0)) == 2
print(json.dumps({
  "verified": True,
  "bytes": size,
  "durationSeconds": duration,
  "width": 1080,
  "height": 1920,
  "renderer": "github-actions-ffmpeg-cinematic-engine-v2",
  "audio": "real-local-espeak-ng-voiceover",
  "audioCodec": audio["codec_name"],
  "scenes": 6,
  "motion": "animated-neon-city"
}))
PY
