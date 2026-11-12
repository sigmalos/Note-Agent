#!/bin/sh
# Drag with the left mouse button through the DevTools protocol (trusted events).
#   scripts/ui-drag.sh <x1> <y1> <x2> <y2> [steps]
x1="$1"; y1="$2"; x2="$3"; y2="$4"; steps="${5:-8}"
dir="$(cd "$(dirname "$0")" && pwd)"
cdp() { "$dir/obs.sh" dev:cdp method=Input.dispatchMouseEvent params="$1" >/dev/null; }
sleep 0.4  # give the previous CLI call time to settle; back-to-back calls drop input
"$dir/obs.sh" dev:cdp method=Runtime.evaluate params='{"expression":"0"}' >/dev/null
cdp "{\"type\":\"mouseMoved\",\"x\":$x1,\"y\":$y1}"
sleep 0.15
cdp "{\"type\":\"mousePressed\",\"x\":$x1,\"y\":$y1,\"button\":\"left\",\"buttons\":1,\"clickCount\":1}"
i=1
while [ "$i" -le "$steps" ]; do
  x=$(( x1 + (x2 - x1) * i / steps )); y=$(( y1 + (y2 - y1) * i / steps ))
  cdp "{\"type\":\"mouseMoved\",\"x\":$x,\"y\":$y,\"button\":\"left\",\"buttons\":1}"
  i=$(( i + 1 ))
done
cdp "{\"type\":\"mouseReleased\",\"x\":$x2,\"y\":$y2,\"button\":\"left\",\"buttons\":0,\"clickCount\":1}"
