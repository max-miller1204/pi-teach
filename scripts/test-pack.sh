#!/usr/bin/env bash
# Verify the *published tarball*, not the working tree.
#
# `pi install npm:pi-teach` gets whatever `files` in package.json allows — nothing else.
# `pi install git:...` gets the whole repo, so it can pass while the npm package is
# broken. This packs, extracts, installs the way pi installs an npm source, and asserts
# that every file the extension reads at runtime is actually in there.
#
# Usage: npm run test:pack [-- --keep]
#   --keep  leave the extracted package in place and print its path, so you can run
#           `pi -e <path>` against exactly what npm consumers would receive.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
keep=0
[[ "${1:-}" == "--keep" ]] && keep=1

# Files resolved at runtime from import.meta.url (see src/paths.ts), i.e. the ones a
# missing `files` entry would break. Keep in sync when adding assets or docs.
required=(
  index.ts
  package.json
  src/server.ts
  src/paths.ts
  assets/templates/lesson.html
  assets/templates/quiz.html
  assets/templates/reference.html
  assets/runtime/classroom.js
  assets/runtime/classroom.css
  assets/runtime/anchor.mjs
  assets/runtime/theme.mjs
  assets/runtime/shell.js
  docs/TEACHING.md
  docs/MISSION-FORMAT.md
  docs/RESOURCES-FORMAT.md
  docs/GLOSSARY-FORMAT.md
  docs/LEARNING-RECORD-FORMAT.md
  docs/ATTRIBUTION.md
  docs/LICENSE.upstream
  LICENSE
)

workdir="$(mktemp -d)"
cleanup() { [[ $keep -eq 1 ]] || rm -rf "$workdir"; }
trap cleanup EXIT

cd "$repo_root"
tarball="$(npm pack --silent --pack-destination "$workdir")"
tar -xzf "$workdir/$tarball" -C "$workdir"
pkg="$workdir/package"

# Mirror pi's npm-source install exactly: production deps only, and no auto-installed
# peers (pi passes --legacy-peer-deps so host-provided packages are not shadowed).
( cd "$pkg" && npm install --omit=dev --legacy-peer-deps --silent --no-audit --no-fund )

status=0
for f in "${required[@]}"; do
  if [[ -e "$pkg/$f" ]]; then
    printf 'ok   %s\n' "$f"
  else
    printf 'MISS %s\n' "$f" >&2
    status=1
  fi
done

# The one runtime dependency has to be resolvable without dev deps.
if [[ -e "$pkg/node_modules/marked/package.json" ]]; then
  printf 'ok   node_modules/marked\n'
else
  printf 'MISS node_modules/marked (is it in "dependencies"?)\n' >&2
  status=1
fi

# Nothing that pi provides should be vendored into the tarball's tree.
for host_pkg in typebox @mariozechner/pi-coding-agent @earendil-works/pi-coding-agent; do
  if [[ -e "$pkg/node_modules/$host_pkg" ]]; then
    printf 'WARN vendored host package: node_modules/%s (should be a peerDependency)\n' "$host_pkg" >&2
    status=1
  fi
done

# Tests and tooling are dead weight in the tarball; catch an over-broad `files`.
for unwanted in test tsconfig.tsbuildinfo .github node_modules/vitest; do
  if [[ -e "$pkg/$unwanted" ]]; then
    printf 'WARN tarball contains %s\n' "$unwanted" >&2
    status=1
  fi
done

if [[ $status -eq 0 ]]; then
  printf '\ntarball ok: %s\n' "$tarball"
else
  printf '\ntarball FAILED verification: %s\n' "$tarball" >&2
fi

if [[ $keep -eq 1 ]]; then
  printf 'extracted package kept at: %s\n' "$pkg"
  printf 'try it with: pi -e %s\n' "$pkg"
fi

exit $status
