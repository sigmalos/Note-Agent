#!/bin/sh
# Thin wrapper around the Obsidian CLI that drops the installer banner noise.
exec /Applications/Obsidian.app/Contents/MacOS/Obsidian vault="${OBSIDIAN_VAULT_NAME:-Agent-Vault}" "$@" 2>&1 | grep -v -e 'Loading updated app package' -e 'installer is out of date'
