#!/usr/bin/env bash
#
# COMPOSE THE DEMO
# ================
#
# Splices the original terminal footage onto the freshly recorded dashboard
# footage, burns the captions back on, and writes a web-ready mp4.
#
# Why the terminal half is reused rather than re-shot: it is a real Claude Code
# session driving real MCP tools, and its latencies (494ms, 3290ms, 161ms,
# 187ms, 92ms) are the single strongest signal that the demo is not staged. It
# was also verified unclipped, so it has no defect to fix. Re-creating it would
# mean faking it.
#
# Caption timings below are DASHBOARD-RELATIVE and must be re-checked against
# each take. Playwright records in wall-clock time, so any change to the dwell
# values in record-dashboard.ts shifts every caption after it. Do not trust
# these numbers across takes; run the QA step.
#
# Usage:
#   scripts/video/compose.sh <original.mp4> <dashboard-raw.webm> <out.mp4>

set -euo pipefail

ORIGINAL="${1:?original demo mp4 required}"
DASHBOARD="${2:?raw dashboard recording required}"
OUT="${3:-backenly-demo-v2.mp4}"

# Cut point between the terminal section and the dashboard section in ORIGINAL.
# Verify with: ffmpeg -ss $CUT -i "$ORIGINAL" -frames:v 1 cut.png
CUT="${CUT:-17.5}"

FONT="${FONT:-C\\:/Windows/Fonts/segoeui.ttf}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Terminal section : 0 -> ${CUT}s of $ORIGINAL (reused unmodified)"
echo "Dashboard section: $DASHBOARD (freshly recorded, unclipped)"

# 1. Terminal half, cut on a keyframe-accurate re-encode so the join is exact.
ffmpeg -v error -i "$ORIGINAL" -t "$CUT" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r 60 -an \
  -vf "scale=1920:1080:flags=lanczos,setsar=1" \
  -y "$WORK/a_terminal.mp4"

# 2. Dashboard half, normalised to the same codec/rate/geometry.
ffmpeg -v error -i "$DASHBOARD" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r 60 -an \
  -vf "scale=1920:1080:flags=lanczos,setsar=1" \
  -y "$WORK/b_dash_raw.mp4"

# 3. Captions. One drawtext per line, gated by enable=between(t,in,out).
#    Style matches the source: white Segoe UI, centred, dark box, low in frame.
cap() { # cap <in> <out> <text>
  printf "drawtext=fontfile='%s':text='%s':x=(w-text_w)/2:y=h-118:fontsize=34:fontcolor=white:box=1:boxcolor=black@0.78:boxborderw=18:enable='between(t,%s,%s)'" \
    "$FONT" "$3" "$1" "$2"
}

FILTER="$(cap 1.5 5.5   'A real Postgres database. Your tables, your rows.'),"
FILTER+="$(cap 7.5 11.5 'End-user auth, governed by the same policies.'),"
FILTER+="$(cap 15.5 17.5 'One endpoint for every agent. Scoped keys, revocable.'),"
FILTER+="$(cap 18.5 21.5 'A foreign key goes missing. Nobody is watching.'),"
FILTER+="$(cap 25.5 29.5 'Detected and repaired, then verified against the database.'),"
FILTER+="$(cap 33.5 37.5 'Every repair is logged with the reason it was made.'),"
FILTER+="$(cap 38.5 41.5 'Autopilot repairs what is safe on its own.'),"
FILTER+="$(cap 43.5 48.5 'What it will not do alone, it hands back to you, with the reason.')"

ffmpeg -v error -i "$WORK/b_dash_raw.mp4" -vf "$FILTER" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r 60 -an \
  -y "$WORK/b_dash.mp4"

# 4. Join. Both inputs are already identical in codec, rate, pixel format and
#    SAR, so the concat demuxer joins them without re-encoding again.
printf "file '%s'\nfile '%s'\n" "$WORK/a_terminal.mp4" "$WORK/b_dash.mp4" > "$WORK/list.txt"
ffmpeg -v error -f concat -safe 0 -i "$WORK/list.txt" -c copy -movflags +faststart -y "$OUT"

echo
echo "Wrote $OUT"
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height,r_frame_rate \
  -of default=noprint_wrappers=1 "$OUT"
echo
echo "QA before publishing:"
echo "  1. Confirm no right-edge clipping: ffmpeg -ss N -i $OUT -frames:v 1 -vf crop=700:1080:1220:0 edge.png"
echo "  2. Confirm captions land on the right shots; retune the cap() timings if dwells changed."
echo "  3. View at true render size (1138x640) since the README caps at max-height:640px."
