#!/bin/sh
# Dispatch a real (trusted) mouse click into Obsidian through the DevTools protocol.
#   scripts/ui-click.sh <x> <y> [clickCount]
# Coordinates are CSS pixels relative to the window viewport.
x="$1"; y="$2"; n="${3:-1}"
dir="$(cd "$(dirname "$0")" && pwd)"
# Input events are dropped until the CDP session has handled a Runtime call: warm it up first.
"$dir/obs.sh" dev:cdp method=Runtime.evaluate params='{"expression":"0"}' >/dev/null
"$dir/obs.sh" dev:cdp method=Input.dispatchMouseEvent params="{\"type\":\"mouseMoved\",\"x\":$x,\"y\":$y}" >/dev/null
sleep 0.15
"$dir/obs.sh" dev:cdp method=Input.dispatchMouseEvent params="{\"type\":\"mousePressed\",\"x\":$x,\"y\":$y,\"button\":\"left\",\"buttons\":1,\"clickCount\":$n}" >/dev/null
"$dir/obs.sh" dev:cdp method=Input.dispatchMouseEvent params="{\"type\":\"mouseReleased\",\"x\":$x,\"y\":$y,\"button\":\"left\",\"buttons\":0,\"clickCount\":$n}" >/dev/null
