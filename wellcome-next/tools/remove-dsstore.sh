#!/usr/bin/env bash
set -euo pipefail

# Remove .DS_Store files from the git index and working tree (if present), then commit.
# Usage: run from the project root: ./tools/remove-dsstore.sh

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

# Find tracked .DS_Store files
tracked=$(git ls-files --full-name | grep -F ".DS_Store" || true)

if [ -z "$tracked" ]; then
  echo "No tracked .DS_Store files found."
else
  echo "Tracked .DS_Store files:" 
  echo "$tracked"
  echo
  echo "Removing from git index..."
  echo "$tracked" | xargs -r git rm --cached -f
  echo "Deleted from index."
fi

# Also remove any working-tree .DS_Store files (optional)
found=$(find . -type f -name '.DS_Store' -print)
if [ -n "$found" ]; then
  echo "Found .DS_Store files in working tree. Deleting them..."
  echo "$found" | xargs -r rm -f
  echo "Deleted working-tree .DS_Store files."
else
  echo "No .DS_Store files found in working tree."
fi

# Commit changes
if git status --porcelain | grep -E "^ D|^ M|^R|^A|^\?" >/dev/null 2>&1; then
  echo "Committing removal..."
  git add .
  git commit -m "chore: remove .DS_Store files and ignore them"
  echo "Committed. You may now push: git push"
else
  echo "No changes to commit."
fi

# Suggest global ignore
cat <<'EOF'

Tip: to avoid creating .DS_Store in other repos, add a global gitignore:

  echo '.DS_Store' >> ~/.gitignore_global
  git config --global core.excludesfile ~/.gitignore_global

EOF
