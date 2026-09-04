#!/bin/zsh
set -euo pipefail

PROJECT_ROOT=${0:A:h:h}
MODULE_CACHE="$PROJECT_ROOT/.build/ModuleCache"
SDK_PATH=${SDKROOT:-$(find /Library/Developer/CommandLineTools/SDKs -maxdepth 1 -type d -name 'MacOSX[0-9]*.sdk' | sort -V | head -1)}

if rg -q 'Timer\.scheduledTimer\(timeInterval:.*#selector\(refresh\)' "$PROJECT_ROOT/macos/main.swift"; then
  echo "unsafe Timer selector for @MainActor refresh" >&2
  exit 1
fi

env SDKROOT="$SDK_PATH" SWIFTPM_MODULECACHE_OVERRIDE="$MODULE_CACHE" CLANG_MODULE_CACHE_PATH="$MODULE_CACHE" \
  swift run --disable-sandbox --disable-keychain --package-path "$PROJECT_ROOT" ThisIsLoggedSelfcheck
env SDKROOT="$SDK_PATH" SWIFTPM_MODULECACHE_OVERRIDE="$MODULE_CACHE" CLANG_MODULE_CACHE_PATH="$MODULE_CACHE" \
  swift run --disable-sandbox --disable-keychain --package-path "$PROJECT_ROOT" ThisIsLogged --selfcheck
