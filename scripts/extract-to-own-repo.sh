#!/usr/bin/env bash
# Extract this folder from the searchscope monorepo into its own standalone
# repository, preserving history. Run from anywhere; it works on a fresh clone.
#
#   ./scripts/extract-to-own-repo.sh git@github.com:InovArcAi/searchscope-ai-visibility-mcp.git
#
# With no argument it only produces the split branch and a portable git bundle,
# so the result can be pushed later or from another machine.
set -euo pipefail

TARGET_REMOTE="${1:-}"
PREFIX="ai-visibility-mcp"
BRANCH="mcp-only"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [ ! -d "$PREFIX" ]; then
  echo "error: $PREFIX not found in $REPO_ROOT. Check out the branch that carries it first." >&2
  exit 1
fi

git branch -D "$BRANCH" 2>/dev/null || true
git subtree split --prefix="$PREFIX" -b "$BRANCH"

BUNDLE="$REPO_ROOT/${PREFIX}.bundle"
git bundle create "$BUNDLE" "$BRANCH"
echo "Wrote $BUNDLE"
echo "To use the bundle on another machine: git clone ${PREFIX}.bundle ${PREFIX} && cd ${PREFIX} && git remote set-url origin <new-repo-url> && git push -u origin main"

if [ -n "$TARGET_REMOTE" ]; then
  git push "$TARGET_REMOTE" "$BRANCH:main"
  echo "Pushed $BRANCH to $TARGET_REMOTE as main"
else
  echo "No target remote given; skipped the push."
fi
