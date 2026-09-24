#!/bin/sh
# Masters the synthesised mix to about -14 LUFS integrated, -1 dBTP, with a
# two-pass loudnorm (linear mode, so dynamics are kept), then encodes the AAC
# the composition plays.
#   sh promo/music/master.sh [work-dir]   (default .work/promo/music)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=${1:-"$here/../../.work/promo/music"}
in="$work/mix.wav"
stats=$(ffmpeg -hide_banner -nostats -i "$in" -af "highpass=f=28,loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
get() { echo "$stats" | sed -n "s/.*\"$1\" : \"\\([^\"]*\\)\".*/\\1/p"; }
ffmpeg -hide_banner -loglevel error -y -i "$in" -af "highpass=f=28,loudnorm=I=-14:TP=-1.0:LRA=11:measured_I=$(get input_i):measured_TP=$(get input_tp):measured_LRA=$(get input_lra):measured_thresh=$(get input_thresh):offset=$(get target_offset):linear=true,aresample=48000" -c:a pcm_s16le "$work/master.wav"
mkdir -p "$here/../assets/audio"
ffmpeg -hide_banner -loglevel error -y -i "$work/master.wav" -c:a aac -b:a 256k "$here/../assets/audio/peesuto-bed.m4a"
ffmpeg -hide_banner -nostats -i "$work/master.wav" -af ebur128=peak=true -f null - 2>&1 | grep -A12 Summary
