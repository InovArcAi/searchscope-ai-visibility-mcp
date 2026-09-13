#!/usr/bin/env bash
# Extract this folder from the searchscope monorepo into its own standalone
# repository, preserving history. Run from anywhere inside the monorepo.
#
#   ./scripts/extract-to-own-repo.sh git@github.com:InovArcAi/searchscope-ai-visibility-mcp.git
#
# With no argument it only produces the split branch and a portable git bundle,
# so the result can be pushed later or from another machine:
#
#   git clone ai-visibility-mcp.bundle ai-visibility-mcp
#   cd ai-visibility-mcp
#   git remote set-url origin <new-repo-url>
#   git push -u origin main
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

# Stage through a bare repo so the bundle carries a HEAD pointing at main.
# A bundle built directly from the split branch records no HEAD, and cloning it
# leaves an empty working tree on a branch with no commits.
STAGING="$(mktemp -d)/staging.git"
git init -q --bare "$STAGING"
git push -q "$STAGING" "$BRANCH:refs/heads/main"
git --git-dir="$STAGING" symbolic-ref HEAD refs/heads/main

BUNDLE="$REPO_ROOT/${PREFIX}.bundle"
git --git-dir="$STAGING" bundle create "$BUNDLE" --all
rm -rf "$(dirname "$STAGING")"
echo "Wrote $BUNDLE"

if [ -n "$TARGET_REMOTE" ]; then
  git push "$TARGET_REMOTE" "$BRANCH:main"
  echo "Pushed $BRANCH to $TARGET_REMOTE as main"
else
  echo "No target remote given; skipped the push. Clone the bundle to move the history elsewhere."
fi
