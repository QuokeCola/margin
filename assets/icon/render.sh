#!/bin/bash
# Re-render every Margin icon PNG from the SVG sources (needs rsvg-convert).
#   assets/margin.svg         master (>=128 px, also the 1024 px build/icon.png)
#   assets/icon/margin-64.svg 48-64 px (slightly heavier strokes)
#   assets/icon/margin-32.svg 24-32 px (pixel-snapped, simplified)
#   assets/icon/margin-16.svg 16 px    (pixel-snapped, simplified)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/../.."
src() { if (( $1 <= 16 )); then echo assets/icon/margin-16.svg; elif (( $1 <= 32 )); then echo assets/icon/margin-32.svg; elif (( $1 <= 64 )); then echo assets/icon/margin-64.svg; else echo assets/margin.svg; fi; }
png() { rsvg-convert -w "$1" -h "$1" "$(src "$1")" -o "$2"; }
png 512 assets/margin-512.png
png 1024 build/icon.png
for s in 16 32 48 128; do png "$s" "extension/icon${s}.png"; done
mkdir -p build/icons
for s in 16 24 32 48 64 128 256 512 1024; do png "$s" "build/icons/${s}x${s}.png"; done
magick build/icons/{16x16,24x24,32x32,48x48,64x64,128x128,256x256}.png build/icon.ico
