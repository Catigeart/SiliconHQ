#!/usr/bin/env bash
set -euo pipefail
if [[ $# -gt 0 ]]; then
  echo '用法：build.sh' >&2
  exit 2
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
command -v npm >/dev/null || { echo '请先安装 npm' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("需要 Node.js >=22"); process.exit(1); }'
npm ci --include=dev
npm run build
mkdir -p build
npm pack --ignore-scripts --pack-destination build
