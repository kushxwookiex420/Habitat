#!/usr/bin/env bash
set -euo pipefail

OUT="${1:-dist/dropilot-hoto-first-look.mp4}"
mkdir -p "$(dirname "$OUT")" work
IMAGE_URL="${PRODUCT_IMAGE_URL:-https://cdn.shopify.com/s/files/1/0973/7784/5535/files/HOTO-Autocare_Air-Duster-Vacuum-Main-New.png?v=1791518851}"
curl -fL --retry 3 --connect-timeout 15 "$IMAGE_URL" -o work/product.png
file work/product.png | grep -E 'PNG image|JPEG image|Web/P image' >/dev/null || { echo "Product image download is not a recognizable image"; exit 1; }

# Original informational ad: product hero + captions. No simulated demonstration,
# fabricated customer claims, or unverified performance promises.
say1='Crumbs hiding in your car interior? Take a look at the HOTO AutoCare Air Duster and Vacuum.'
say2='The listing describes a compact cleanup tool for car interiors and everyday dusty surfaces.'
say3='Check the product page for the current price, specifications, attachments, availability, and shipping.'
say4='Want the details? Tap the product link to check the HOTO AutoCare listing.'

tts() {
  local text="$1" output="$2"
  curl -fL --retry 2 --get 'https://translate.google.com/translate_tts' \
    -H 'User-Agent: Mozilla/5.0' --data-urlencode 'ie=UTF-8' --data-urlencode 'client=tw-ob' \
    --data-urlencode 'tl=en-US' --data-urlencode "q=$text" -o "$output"
  test "$(stat -c%s "$output")" -gt 1000
}
tts "$say1" work/v1.mp3
tts "$say2" work/v2.mp3
tts "$say3" work/v3.mp3
tts "$say4" work/v4.mp3
printf "file '%s'\nfile '%s'\nfile '%s'\nfile '%s'\n" "$PWD/work/v1.mp3" "$PWD/work/v2.mp3" "$PWD/work/v3.mp3" "$PWD/work/v4.mp3" > work/voice.txt
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i work/voice.txt -c:a libmp3lame -q:a 4 work/voice.mp3
VOICE_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 work/voice.mp3)
DURATION=$(awk -v d="$VOICE_DURATION" 'BEGIN { v=d+1.8; if(v<22) v=22; if(v>30) v=30; printf "%.2f",v }')

# Stable, legible layout: background is a softened, darkened fill; no promotional logo or brand watermark is burned into the video, and the actual product
# image stays centered and unobstructed, with copy in a fixed safe area.
ffmpeg -hide_banner -loglevel error -y \
  -loop 1 -i work/product.png -i work/voice.mp3 \
  -filter_complex "
[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=22:2,eq=brightness=-0.25[bg];
[0:v]scale=860:1040:force_original_aspect_ratio=decrease[product];
[bg][product]overlay=(W-w)/2:360:shortest=1,
drawbox=x=44:y=72:w=992:h=250:color=black@0.60:t=fill,
drawbox=x=44:y=1470:w=992:h=340:color=black@0.68:t=fill,
drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='CRUMBS IN HARD-TO-REACH SPOTS?':fontcolor=white:fontsize=48:line_spacing=8:x=(w-text_w)/2:y=116:enable='between(t,0,5)',
drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='A CLOSER LOOK AT HOTO AUTOCARE':fontcolor=white:fontsize=43:x=(w-text_w)/2:y=166:enable='between(t,5,11)',
drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='CHECK THE SPECS + ATTACHMENTS':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=166:enable='between(t,11,18)',
drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='CHECK PRICE + DETAILS':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=1550:enable='between(t,18,30)',
drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Price and availability may change':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=1630,
drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Tap the product link to learn more':fontcolor=white:fontsize=30:x=(w-text_w)/2:y=1690,
fps=30,format=yuv420p[v]" \
  -map '[v]' -map 1:a -af "apad,atrim=duration=$DURATION" -t "$DURATION" \
  -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart "$OUT"

# Release gate: real MP4, vertical resolution, duration, audio track, and non-empty file.
test -s "$OUT"
ffprobe -v error -show_entries stream=codec_type,width,height -show_entries format=duration,size -of json "$OUT" > "${OUT%.mp4}-probe.json"
node --input-type=module - "$OUT" "${OUT%.mp4}-probe.json" <<'JS'
import fs from 'node:fs';
const [file, probeFile] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(probeFile,'utf8'));
const v = p.streams.find(s=>s.codec_type==='video');
const a = p.streams.find(s=>s.codec_type==='audio');
const duration = Number(p.format.duration);
if (!v || !a || Number(v.width)!==1080 || Number(v.height)!==1920 || duration<20 || duration>31 || Number(p.format.size)<100000) {
  console.error('BLOCKED: product video failed media release gate', p);
  process.exit(1);
}
console.log(JSON.stringify({status:'MEDIA_PASS',file,width:v.width,height:v.height,durationSeconds:duration,bytes:p.format.size,audio:true}));
JS
