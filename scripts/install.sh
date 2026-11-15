#!/usr/bin/env bash
set -euo pipefail
prefix="${HOME}/.local"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      [[ $# -ge 2 && -n "$2" ]] || { echo '--prefix 需要路径参数' >&2; exit 2; }
      prefix="$2"; shift 2 ;;
    -h|--help) echo '用法：install.sh [--prefix <安装路径>]（默认 ~/.local）'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
# 在切换到源码目录前解析相对安装路径。
mkdir -p -- "$prefix"
prefix="$(cd -- "$prefix" && pwd -P)"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
./scripts/build.sh
archive="$(node -p "'siliconhq-' + JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version + '.tgz'")"
npm install --global --prefix "$prefix" --omit=dev "./build/$archive"
printf '已安装：%s/bin/sihq\n请确保 %s/bin 位于 PATH 中。\n' "$prefix" "$prefix"
