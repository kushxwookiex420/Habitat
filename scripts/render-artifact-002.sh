#!/usr/bin/env bash
set -euo pipefail
OUT="${1:-habitat-artifact-002.mp4}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
B=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
R=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
scene(){ local n=$1 d=$2 bg=$3 accent=$4 title=$5 sub=$6; ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=$bg:s=540x960:r=15:d=$d" -vf "drawgrid=width=50:height=50:thickness=1:color=${accent}@0.10,drawbox=x=0:y=610:w=540:h=350:color=0x03040a@0.84:t=fill,drawbox=x=45:y=500:w=80:h=460:color=${accent}@0.16:t=fill,drawbox=x=155:y=455:w=95:h=505:color=${accent}@0.12:t=fill,drawbox=x=285:y=535:w=85:h=425:color=${accent}@0.15:t=fill,drawbox=x=405:y=480:w=90:h=480:color=${accent}@0.12:t=fill,drawbox=x='mod(t*85,700)-100':y=0:w=100:h=960:color=${accent}@0.10:t=fill,drawbox=x=0:y='mod(t*70,960)':w=540:h=3:color=${accent}@0.40:t=fill,drawtext=fontfile=$B:text='AX / VICE CITY FILES':fontcolor=white@0.72:fontsize=16:x=39:y=105,drawtext=fontfile=$B:text='$title':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=275,drawtext=fontfile=$R:text='$sub':fontcolor=white@0.88:fontsize=18:x=(w-text_w)/2:y=340,drawtext=fontfile=$R:text='FACT-CHECKED - NO RUMORS':fontcolor=white@0.62:fontsize=13:x=(w-text_w)/2:y=855,drawtext=fontfile=$R:text='VICE CITY FILES - AX':fontcolor=white@0.58:fontsize=13:x=39:y=905,format=yuv420p" -c:v libx264 -preset ultrafast -crf 30 -an "$TMP/$n.mp4"; }
scene 01 5 101020 39d9ff "VICE CITY IS BACK" "GTA 6 - THE NEXT BIG LEAP"
scene 02 7 15101f ff3aa7 "NOV. 19, 2026" "OFFICIAL RELEASE DATE"
scene 03 8 0b1419 4cffd0 "JASON + LUCIA" "VICE CITY - LEONIDA"
scene 04 8 160c18 ff4aa8 "VICE CITY - LEONIDA" "THE NEXT EVOLUTION"
scene 05 8 0c1615 45ffb0 "PS5 + XBOX SERIES X/S" "OFFICIALLY ANNOUNCED PLATFORMS"
scene 06 9 130b18 ff4cf0 "FACTS, NOT RUMORS" "HABITAT - AX - VICECITYFILES"
for f in "$TMP"/*.mp4; do printf "file '%s'\n" "$f"; done > "$TMP/list.txt"
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$TMP/list.txt" -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000" -map 0:v:0 -map 1:a:0 -vf scale=1080:1920:flags=fast_bilinear -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -c:a aac -b:a 64k -ar 48000 -t 45 -shortest -movflags +faststart "$OUT"
ffprobe -v error -show_entries format=duration,size:stream=codec_type,width,height,r_frame_rate -of json "$OUT" > "$TMP/probe.json"
python - "$TMP/probe.json" "$OUT" <<'PY'
import json,os,sys
p=json.load(open(sys.argv[1])); v=next(s for s in p['streams'] if s['codec_type']=='video'); d=float(p['format']['duration']); b=os.path.getsize(sys.argv[2])
assert b>0 and d>=44 and int(v['width'])==1080 and int(v['height'])==1920 and v['r_frame_rate']=='15/1'
print(json.dumps({'verified':True,'bytes':b,'durationSeconds':d,'width':1080,'height':1920,'renderer':'github-actions-ffmpeg-cinematic-engine-v1','audio':'placeholder-silence','scenes':6,'motion':'animated-neon-city'}))
PY
