#!/bin/sh
# Keyboard input through the DevTools protocol (trusted events).
#   scripts/ui-keys.sh text "<text>"          insert text at the focused element
#   scripts/ui-keys.sh key <Key> [modifiers]   press a key; modifiers bitmask: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift
dir="$(cd "$(dirname "$0")" && pwd)"
cdp() { "$dir/obs.sh" dev:cdp method="$1" params="$2" >/dev/null; }
sleep 0.4
cdp Runtime.evaluate '{"expression":"0"}'
case "$1" in
  text) cdp Input.insertText "{\"text\":\"$2\"}" ;;
  key)
    key="$2"; mod="${3:-0}"
    case "$key" in
      Enter) code=13; txt='"text":"\r",' ;;
      Escape) code=27; txt='' ;;
      Tab) code=9; txt='' ;;
      ArrowUp) code=38; txt='' ;;
      ArrowDown) code=40; txt='' ;;
      *) code=0; txt='' ;;
    esac
    [ "$mod" != 0 ] && txt=''
    [ "$key" = Enter ] && [ "$mod" = 8 ] && txt='"text":"\r",'
    cdp Input.dispatchKeyEvent "{\"type\":\"keyDown\",\"key\":\"$key\",\"code\":\"$key\",$txt\"windowsVirtualKeyCode\":$code,\"modifiers\":$mod}"
    cdp Input.dispatchKeyEvent "{\"type\":\"keyUp\",\"key\":\"$key\",\"code\":\"$key\",\"windowsVirtualKeyCode\":$code,\"modifiers\":$mod}"
    ;;
esac
