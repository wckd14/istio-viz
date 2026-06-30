#!/usr/bin/env bash
# istio-viz installer
#
# Usage:
#   curl -fsSL https://istio-viz.wckd14.xyz/install.sh | bash
#
# Install a specific version:
#   curl -fsSL https://istio-viz.wckd14.xyz/install.sh | bash -s -- v0.2.0
#
# Override install directory:
#   INSTALL_DIR=~/.local/bin curl -fsSL https://istio-viz.wckd14.xyz/install.sh | bash
#
# Supported platforms:
#   linux-x64, linux-arm64, macos-arm64
#   Windows: download from https://github.com/wckd14/istio-viz/releases
set -euo pipefail

REPO="wckd14/istio-viz"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
VERSION="${ISTIO_VIZ_VERSION:-${1:-}}"

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

if [ -w "$INSTALL_DIR" ]; then
  _do_install "$INSTALL_DIR"
elif command -v sudo >/dev/null 2>&1; then
  step "sudo required to write to $INSTALL_DIR..."
  sudo install -m755 "$TMP/istio-viz" "$INSTALL_DIR/istio-viz"
else
  INSTALL_DIR="${HOME}/.local/bin"
  warn "No write access to /usr/local/bin and sudo not available."
  warn "Installing to $INSTALL_DIR instead."
  _do_install "$INSTALL_DIR"
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) ;;
    *) warn "Add $INSTALL_DIR to your PATH:"
       warn "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
fi

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
