#!/usr/bin/env bash
# Point this package's bare specifiers at the DSH profile's installed copies.
#
# The host half imports `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, and the
# attachment store. Those are peer dependencies: at runtime the profile resolves
# them because this package is installed *into* the profile. Running the harnesses
# from the source directory has no such resolution, so this script creates the
# symlinks the tests need. It writes only inside this directory.
#
# Usage: scripts/dev-link.sh [profile-path]
set -euo pipefail

profile="${1:-$HOME/.dsh/profiles}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$here/node_modules/@deepseek-ai"

for pkg in dsh-tools dsh-llm dsh-attachment cordis; do
  target="$profile/node_modules/@deepseek-ai/$pkg"
  if [ ! -e "$target" ]; then
    echo "missing $target — install the DSH web profile first" >&2
    exit 1
  fi
  ln -sfn "$target" "$here/node_modules/@deepseek-ai/$pkg"
  echo "linked $pkg"
done

echo "ready: run 'node test/host.test.mjs' and 'node test/client.test.mjs'"
