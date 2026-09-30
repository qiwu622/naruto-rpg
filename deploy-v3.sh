#!/usr/bin/env bash
# Compatibility entry: one package and one installer for every environment.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$SCRIPT_DIR/deploy-wsl.sh" production "$@"
