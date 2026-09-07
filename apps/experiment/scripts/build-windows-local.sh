#!/usr/bin/env bash
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$APP/../.." && pwd)"
BUILD="$APP/build"
WINDOWS_ROOT="$BUILD/windows-x64"
STAGE="$WINDOWS_ROOT/Reconnect Experiment"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCHIVE="$BUILD/Reconnect-Experiment-$VERSION-windows-x64.zip"
RUNTIME_VERSION="151.0.4129.93"
RUNTIME_URL="https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/1424552f-1033-46d3-a1ea-26c879f4262b/Microsoft.WebView2.FixedVersionRuntime.${RUNTIME_VERSION}.x64.cab"
CACHE="${XDG_CACHE_HOME:-$HOME/Library/Caches}/reconnect-experiment"
CAB="$CACHE/Microsoft.WebView2.FixedVersionRuntime.${RUNTIME_VERSION}.x64.cab"
EXTRACT="$CACHE/webview2-$RUNTIME_VERSION"

for formula in llvm ninja cabextract; do
  if ! brew list "$formula" >/dev/null 2>&1; then
    brew install "$formula"
  fi
done
export PATH="$(brew --prefix llvm)/bin:$PATH"

if ! cargo xwin --version >/dev/null 2>&1; then
  cargo install cargo-xwin
fi
rustup target add x86_64-pc-windows-msvc

VITE_EXPERIMENT_PROFILE=development npm run build --workspace @gamespace/showcase -- --mode experiment
XWIN_ARCH=x86_64 cargo xwin build \
  --manifest-path "$APP/src-tauri/Cargo.toml" \
  --target x86_64-pc-windows-msvc \
  --features custom-protocol \
  --release

EXE="$APP/src-tauri/target/x86_64-pc-windows-msvc/release/reconnect-experiment.exe"
test -f "$EXE"

rm -rf "$WINDOWS_ROOT" "$ARCHIVE"
mkdir -p "$STAGE/protocols" "$STAGE/data" "$STAGE/webview2" "$CACHE"
cp "$EXE" "$STAGE/Reconnect Experiment.exe"
cp "$ROOT/packages/protocol/examples/reconnect-pilot.json" "$STAGE/protocols/reconnect-pilot.json"
cp "$APP/README.txt" "$STAGE/README.txt"

if [[ ! -f "$CAB" ]]; then
  curl --fail --location "$RUNTIME_URL" --output "$CAB"
fi
rm -rf "$EXTRACT"
mkdir -p "$EXTRACT"
cabextract -q -d "$EXTRACT" "$CAB"
RUNTIME_EXE="$(/usr/bin/find "$EXTRACT" -name msedgewebview2.exe -print -quit)"
test -n "$RUNTIME_EXE"
RUNTIME_ROOT="$(dirname "$RUNTIME_EXE")"
cp -R "$RUNTIME_ROOT/." "$STAGE/webview2/"
shasum -a 256 "$CAB" | awk '{print $1}' > "$STAGE/WEBVIEW2-SHA256.txt"

test -f "$STAGE/webview2/msedgewebview2.exe"
test -f "$STAGE/protocols/reconnect-pilot.json"
file "$STAGE/Reconnect Experiment.exe" | grep -q 'PE32+'
if llvm-objdump -p "$STAGE/Reconnect Experiment.exe" | grep -qi 'DLL Name:.*lsl'; then
  echo "liblsl was linked dynamically; portable build requires static linkage" >&2
  exit 1
fi

(
  cd "$WINDOWS_ROOT"
  /usr/bin/zip -qry "$ARCHIVE" "Reconnect Experiment"
)

printf '%s\n' "$ARCHIVE"
