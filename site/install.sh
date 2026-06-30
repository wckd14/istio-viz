#!/usr/bin/env bash
# istio-viz installer
#
# Usage:
#   curl -fsSL https://istio-viz.wckd14.xyz/install.sh | bash
#
# Install a specific version:
#   curl -fsSL https://istio-viz.wckd14.xyz/install.sh | bash -s -- v0.2.0
#
# Re-running the script when already installed updates an out-of-date
# binary in place, or reports that it is already present and latest.
#
# Uninstall (removes istio-viz from every detected location):
#   curl -fsSL https://istio-viz.wckd14.xyz/install.sh | bash -s -- --uninstall
#
# Override install directory:
#   INSTALL_DIR=/usr/local/bin curl -fsSL https://istio-viz.wckd14.xyz/install.sh | bash
#
# Supported platforms:
#   linux-x64, linux-arm64, macos-arm64
#   Windows: download from https://github.com/wckd14/istio-viz/releases
set -euo pipefail

REPO="wckd14/istio-viz"

# Track whether the user explicitly chose an install dir; if not, we may
# adopt the directory of an existing installation when updating.
if [ -n "${INSTALL_DIR:-}" ]; then INSTALL_DIR_EXPLICIT=1; else INSTALL_DIR_EXPLICIT=0; fi
INSTALL_DIR="${INSTALL_DIR:-${HOME}/.local/bin}"

# ── parse arguments ───────────────────────────────────────────────────────────
ACTION="install"
VERSION="${ISTIO_VIZ_VERSION:-}"
if [ -n "${ISTIO_VIZ_VERSION:-}" ]; then VERSION_EXPLICIT=1; else VERSION_EXPLICIT=0; fi

while [ $# -gt 0 ]; do
  case "$1" in
    -u|--uninstall|uninstall) ACTION="uninstall" ;;
    -h|--help|help)           ACTION="help" ;;
    -*) printf 'Unknown option: %s\n' "$1" >&2; ACTION="help" ;;
    *)  VERSION="$1"; VERSION_EXPLICIT=1 ;;
  esac
  shift
done

# ── color helpers (disabled when stdout is not a TTY) ─────────────────────────
if [ -t 1 ]; then
  c_bold=$'\033[1m' c_reset=$'\033[0m'
  c_green=$'\033[32m' c_blue=$'\033[34m'
  c_yellow=$'\033[33m' c_red=$'\033[31m'
else
  c_bold='' c_reset='' c_green='' c_blue='' c_yellow='' c_red=''
fi

step() { printf "${c_blue}  →${c_reset} %s\n" "$*"; }
ok()   { printf "${c_green}  ✔${c_reset} %s\n" "$*"; }
warn() { printf "${c_yellow}  ⚠${c_reset}  %s\n" "$*" >&2; }
die()  { printf "\n${c_red}  ✖${c_reset}  %s\n\n" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
istio-viz installer

Usage:
  install.sh [VERSION]     Install or update istio-viz (defaults to latest)
  install.sh --uninstall   Remove istio-viz from every detected location
  install.sh --help        Show this help

Environment:
  INSTALL_DIR              Target directory (default: \$HOME/.local/bin)
  ISTIO_VIZ_VERSION        Version to install (overridden by VERSION argument)
EOF
}

# Print unique istio-viz binary paths found on PATH + common locations.
_find_installs() {
  {
    IFS=:
    for d in $PATH; do
      [ -n "$d" ] && [ -f "$d/istio-viz" ] && printf '%s\n' "$d/istio-viz"
    done
  }
  for d in "$INSTALL_DIR" "$HOME/.local/bin" "/usr/local/bin" "/opt/homebrew/bin" "/usr/bin"; do
    [ -f "$d/istio-viz" ] && printf '%s\n' "$d/istio-viz"
  done
}

# Extract installed version (prefixed with 'v') from a binary; empty if unknown.
_installed_version() {
  "$1" --version 2>/dev/null | head -n1 \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^[:space:]]*' | head -n1 \
    | sed 's/^/v/'
}

_uninstall() {
  local found p
  found="$(_find_installs | awk '!seen[$0]++')"
  if [ -z "$found" ]; then
    warn "istio-viz is not installed (nothing found on PATH or common locations)."
    exit 0
  fi
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ -w "$(dirname "$p")" ] || [ -w "$p" ]; then
      rm -f "$p" && ok "Removed ${c_bold}${p}${c_reset}"
    else
      warn "No write access to $p — try: sudo rm -f \"$p\""
    fi
  done <<EOF
$found
EOF
  ok "Uninstall complete."
  exit 0
}

# ── dispatch non-install actions ──────────────────────────────────────────────
case "$ACTION" in
  help)      usage; exit 0 ;;
  uninstall) _uninstall ;;
esac

# ── dependency check ──────────────────────────────────────────────────────────
command -v curl >/dev/null 2>&1 || die "curl is required but not found."

# ── detect OS + architecture ──────────────────────────────────────────────────
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64|amd64)   PLATFORM="linux-x64"  ;;
      aarch64|arm64)  PLATFORM="linux-arm64" ;;
      *) die "Unsupported Linux architecture: $ARCH. Open an issue: https://github.com/$REPO/issues" ;;
    esac
    EXT="tar.gz"
    ;;
  Darwin)
    case "$ARCH" in
      arm64)  PLATFORM="macos-arm64" ;;
      x86_64) die "macOS Intel (x86_64) is not supported. Only Apple Silicon (arm64) builds are provided. Open an issue: https://github.com/$REPO/issues" ;;
      *) die "Unsupported macOS architecture: $ARCH" ;;
    esac
    EXT="tar.gz"
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    die "Windows installer is not supported via this script. Download the .zip from: https://github.com/$REPO/releases"
    ;;
  *)
    die "Unrecognised OS: $OS. See releases: https://github.com/$REPO/releases"
    ;;
esac

# ── resolve version ───────────────────────────────────────────────────────────
if [ -z "$VERSION" ]; then
  step "Fetching latest release..."
  _api_response="$(curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/releases/latest")"

  if command -v jq >/dev/null 2>&1; then
    VERSION="$(printf '%s' "$_api_response" | jq -r '.tag_name')"
  else
    VERSION="$(printf '%s' "$_api_response" \
      | grep -o '"tag_name" *: *"[^"]*"' \
      | sed 's/.*"\([^"]*\)"$/\1/')"
  fi

  [ -n "$VERSION" ] && [ "$VERSION" != "null" ] \
    || die "Could not determine the latest version. Check your network connection."
fi

# normalise: ensure a leading 'v'
case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac

ok "Version ${c_bold}${VERSION}${c_reset}  ·  Platform ${c_bold}${PLATFORM}${c_reset}"

# ── detect existing installation ──────────────────────────────────────────────
EXISTING_BIN="$(command -v istio-viz 2>/dev/null || true)"
if [ -z "$EXISTING_BIN" ]; then
  EXISTING_BIN="$(_find_installs | awk '!seen[$0]++' | head -n1)"
fi

if [ -n "$EXISTING_BIN" ]; then
  CURRENT_VERSION="$(_installed_version "$EXISTING_BIN")"

  # Update in place unless the user explicitly chose an INSTALL_DIR.
  if [ "$INSTALL_DIR_EXPLICIT" -eq 0 ]; then
    INSTALL_DIR="$(cd "$(dirname "$EXISTING_BIN")" && pwd)"
  fi

  if [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" = "$VERSION" ]; then
    if [ "$VERSION_EXPLICIT" -eq 1 ]; then
      ok "istio-viz ${c_bold}${VERSION}${c_reset} is already present → ${EXISTING_BIN}"
    else
      ok "istio-viz ${c_bold}${VERSION}${c_reset} is already present and latest → ${EXISTING_BIN}"
    fi
    exit 0
  fi

  if [ -n "$CURRENT_VERSION" ]; then
    step "Updating ${c_bold}${CURRENT_VERSION}${c_reset} → ${c_bold}${VERSION}${c_reset} at ${INSTALL_DIR}"
  else
    step "Existing install at ${EXISTING_BIN}; reinstalling ${c_bold}${VERSION}${c_reset}"
  fi
fi

# ── download ──────────────────────────────────────────────────────────────────
ARCHIVE="istio-viz_${VERSION}_${PLATFORM}.${EXT}"
URL="https://github.com/$REPO/releases/download/$VERSION/$ARCHIVE"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step "Downloading $ARCHIVE..."
if ! curl -fSL --progress-bar "$URL" -o "$TMP/$ARCHIVE"; then
  die "Download failed. Verify that $VERSION is a valid release: https://github.com/$REPO/releases"
fi

# ── extract ───────────────────────────────────────────────────────────────────
tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
[ -f "$TMP/istio-viz" ] \
  || die "Binary 'istio-viz' not found in $ARCHIVE — unexpected archive layout."

chmod +x "$TMP/istio-viz"

# ── install ───────────────────────────────────────────────────────────────────
_do_install() {
  mkdir -p "$1"
  install -m755 "$TMP/istio-viz" "$1/istio-viz"
}

if ! mkdir -p "$INSTALL_DIR" 2>/dev/null || [ ! -w "$INSTALL_DIR" ]; then
  die "No write access to $INSTALL_DIR. Set INSTALL_DIR to a writable directory and re-run."
fi

_do_install "$INSTALL_DIR"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) warn "$INSTALL_DIR is not on your PATH. Add it:"
     warn "  export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac

ok "Installed → ${c_bold}${INSTALL_DIR}/istio-viz${c_reset}"

# ── quick-start hint ──────────────────────────────────────────────────────────
printf '\n'
if command -v istio-viz >/dev/null 2>&1; then
  ok "istio-viz is ready. Quick start:"
else
  ok "Open a new shell, then:"
fi
printf '    istio-viz render ./manifests/ -o routes.html\n'
printf '    istio-viz trace  ./manifests/ --host api.example.com --path /api/v1\n'
printf '    istio-viz lint   ./manifests/ --strict\n\n'
