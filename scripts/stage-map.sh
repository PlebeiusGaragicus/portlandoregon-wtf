#!/usr/bin/env bash
set -euo pipefail

# Stage the active map into the client's static assets so the game runs with no
# server at all.
#
# The map is ~30 MB gzipped and deliberately NOT in git (see .gitignore) —
# committing it would add 30 MB to history on every regeneration. It lives as a
# GitHub Release asset instead. This script puts it where Vite will publish it:
#
#   client/src/public/map/buildings.bin.gz   538k footprints, binary store
#   client/src/public/map/map-lite.json.gz   every other layer, still JSON
#   client/src/public/map/heightmap.bin.gz   terrain (optional; flat if absent)
#
# The release asset stays map.json.gz — the split is a local bake step, so a
# re-bake never needs a new upload.
#
# Locally it copies from data/maps/. In CI, where data/maps/ doesn't exist, it
# downloads the release asset instead.
#
# Usage:
#   ./scripts/stage-map.sh              # copy from data/maps, else download
#   ./scripts/stage-map.sh --download   # always download from the release

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_ROOT/data/maps"
DEST_DIR="$REPO_ROOT/client/src/public/map"
RELEASE_TAG="${MAP_RELEASE_TAG:-map-latest}"
MAP_REPO="${MAP_REPO:-PlebeiusGaragicus/battle-juice}"

force_download=false
[ "${1:-}" = "--download" ] && force_download=true

note() { printf '\033[1m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

mkdir -p "$DEST_DIR"

# The extractor writes <name>.json.gz plus <name>-heightmap.bin.gz. Pick the
# map file, ignoring the heightmap that sits beside it.
map_name=""
if [ -d "$SRC_DIR" ]; then
    for f in "$SRC_DIR"/*.json.gz; do
        [ -e "$f" ] || continue
        map_name="$(basename "$f" .json.gz)"
        break
    done
fi

if ! $force_download && [ -n "$map_name" ]; then
    note "Staging $map_name from data/maps/"
    cp "$SRC_DIR/$map_name.json.gz" "$DEST_DIR/map.json.gz"
    if [ -f "$SRC_DIR/$map_name-heightmap.bin.gz" ]; then
        cp "$SRC_DIR/$map_name-heightmap.bin.gz" "$DEST_DIR/heightmap.bin.gz"
    else
        note "no heightmap for $map_name — the client falls back to flat ground"
    fi
else
    command -v gh >/dev/null || fail "gh CLI needed to download the map release"
    note "Downloading map from release $RELEASE_TAG of $MAP_REPO"
    gh release download "$RELEASE_TAG" --repo "$MAP_REPO" \
        --pattern 'map.json.gz' --output "$DEST_DIR/map.json.gz" --clobber \
        || fail "couldn't download map.json.gz from release '$RELEASE_TAG'.
  Refresh it from a machine that has data/maps/ — stage locally first, because
  the asset NAMES are what this script matches on (gh's file#label syntax only
  sets a display label, so uploading data/maps/portland.json.gz directly would
  publish an asset this script can't find):
    ./scripts/stage-map.sh
    gh release upload $RELEASE_TAG --repo $MAP_REPO --clobber \\
      client/src/public/map/map.json.gz \\
      client/src/public/map/heightmap.bin.gz"
    gh release download "$RELEASE_TAG" --repo "$MAP_REPO" \
        --pattern 'heightmap.bin.gz' --output "$DEST_DIR/heightmap.bin.gz" --clobber \
        || note "no heightmap in the release — the client falls back to flat ground"
fi

# Bake: buildings move out of the JSON into a binary store. Parsing them as
# JSON cost ~820 MB of browser heap; the store costs 38 MB. map.json.gz is the
# bake INPUT and is removed afterwards so Vite doesn't publish 32 MB nobody
# downloads — re-run this script to get it back.
note "Baking the binary building store"
( cd "$REPO_ROOT" && npx tsx --max-old-space-size=10240 scripts/bake-map.ts ) \
    || fail "bake failed — map.json.gz left in place so you can retry"
rm -f "$DEST_DIR/map.json.gz"

du -h "$DEST_DIR"/* | sed 's/^/    /'
note "Staged into client/src/public/map/ — the build will publish these"
