#!/usr/bin/env bash
set -euo pipefail

OUT="${1:-habitat-artifact-001.mp4}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x10131a:s=540x960:r=15:d=4" \
  -f lavfi -i "color=c=0x17151f:s=540x960:r=15:d=7" \
  -f lavfi -i "color=c=0x121b20:s=540x960:r=15:d=8" \
  -f lavfi -i "color=c=0x20161a:s=540x960:r=15:d=8" \
  -f lavfi -i "color=c=0x151d18:s=540x960:r=15:d=9" \
  -f lavfi -i "color=c=0x1b1622:s=540x960:r=15:d=9" \
  -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000" \
  -filter_complex "
[0:v]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='AX / VICE CITY FILES':fontcolor=white@0.72:fontsize=16:x=39:y=150,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='VICE CITY IS BACK':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=280,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='GTA 6 - THE NEXT BIG LEAP':fontcolor=white@0.88:fontsize=18:x=(w-text_w)/2:y=345,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='FACT-CHECKED - NO RUMORS':fontcolor=white@0.62:fontsize=13:x=(w-text_w)/2:y=858,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='VICE CITY FILES - AX':fontcolor=white@0.58:fontsize=13:x=39:y=905,setsar=1[v0];
[1:v]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='AX / VICE CITY FILES':fontcolor=white@0.72:fontsize=16:x=39:y=150,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='NOV. 19, 2026':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=280,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='OFFICIAL RELEASE DATE':fontcolor=white@0.88:fontsize=18:x=(w-text_w)/2:y=345,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='FACT-CHECKED - NO RUMORS':fontcolor=white@0.62:fontsize=13:x=(w-text_w)/2:y=858,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='VICE CITY FILES - AX':fontcolor=white@0.58:fontsize=13:x=39:y=905,setsar=1[v1];
[2:v]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='AX / VICE CITY FILES':fontcolor=white@0.72:fontsize=16:x=39:y=150,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='JASON + LUCIA':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=280,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='VICE CITY - LEONIDA':fontcolor=white@0.88:fontsize=18:x=(w-text_w)/2:y=345,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='FACT-CHECKED - NO RUMORS':fontcolor=white@0.62:fontsize=13:x=(w-text_w)/2:y=858,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='VICE CITY FILES - AX':fontcolor=white@0.58:fontsize=13:x=39:y=905,setsar=1[v2];
[3:v]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='AX / VICE CITY FILES':fontcolor=white@0.72:fontsize=16:x=39:y=150,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='VICE CITY - LEONIDA':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=280,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='THE NEXT EVOLUTION':fontcolor=white@0.88:fontsize=18:x=(w-text_w)/2:y=345,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='FACT-CHECKED - NO RUMORS':fontcolor=white@0.62:fontsize=13:x=(w-text_w)/2:y=858,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='VICE CITY FILES - AX':fontcolor=white@0.58:fontsize=13:x=39:y=905,setsar=1[v3];
[4:v]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='AX / VICE CITY FILES':fontcolor=white@0.72:fontsize=16:x=39:y=150,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='PS5 - XBOX SERIES X|S':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=280,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='OFFICIALLY ANNOUNCED PLATFORMS':fontcolor=white@0.88:fontsize=18:x=(w-text_w)/2:y=345,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='FACT-CHECKED - NO RUMORS':fontcolor=white@0.62:fontsize=13:x=(w-text_w)/2:y=858,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='VICE CITY FILES - AX':fontcolor=white@0.58:fontsize=13:x=39:y=905,setsar=1[v4];
[5:v]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='AX / VICE CITY FILES':fontcolor=white@0.72:fontsize=16:x=39:y=150,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='FACTS, NOT RUMORS':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=280,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='HABITAT - AX - VICECITYFILES':fontcolor=white@0.88:fontsize=18:x=(w-text_w)/2:y=345,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='FACT-CHECKED - NO RUMORS':fontcolor=white@0.62:fontsize=13:x=(w-text_w)/2:y=858,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='VICE CITY FILES - AX':fontcolor=white@0.58:fontsize=13:x=39:y=905,setsar=1[v5];
[v0][v1][v2][v3][v4][v5]concat=n=6:v=1:a=0,scale=1080:1920:flags=fast_bilinear,format=yuv420p[v]
" \
  -map "[v]" -map 6:a:0 \
  -c:v libx264 -preset ultrafast -crf 32 -pix_fmt yuv420p \
  -c:a aac -b:a 64k -ar 48000 -t 45 -shortest -movflags +faststart "$OUT"

test -s "$OUT"

ffprobe -v error -show_entries format=duration,size:stream=codec_type,width,height,r_frame_rate -of json "$OUT" > "$TMP/probe.json"

python - "$TMP/probe.json" "$OUT" <<'PY'
import json, os, sys
p=json.load(open(sys.argv[1]))
size=os.path.getsize(sys.argv[2])
duration=float(p["format"]["duration"])
video=next(s for s in p["streams"] if s["codec_type"]=="video")
assert size > 0
assert duration >= 44
assert int(video["width"]) == 1080 and int(video["height"]) == 1920
assert video["r_frame_rate"] == "15/1"
print(json.dumps({"verified":True,"bytes":size,"durationSeconds":duration,"width":1080,"height":1920,"renderer":"github-actions-ffmpeg-scene-engine-v1","audio":"placeholder-silence","scenes":6}))
PY
