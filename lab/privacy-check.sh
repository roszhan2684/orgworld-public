#!/usr/bin/env bash
# Exit 1, naming the file, if any given file (or any file inside a .zip) contains a private pattern: the lab
# machine's home path, the researcher's email, or the private research dossier. Patterns: one per line in
# $ORGWORLD_LAB/state/privacy-patterns (written by lab/setup.sh).
set -uo pipefail
PAT="${ORGWORLD_LAB:-$HOME/orgworld-lab}/state/privacy-patterns"
[[ -s "$PAT" ]] || { echo "privacy-check: no patterns file at $PAT" >&2; exit 1; }
bad=0
for f in "$@"; do
  [[ -f "$f" ]] || continue
  case "$f" in
    *.zip) unzip -p "$f" | grep -q -F -f "$PAT" && { echo "private text in $f" >&2; bad=1; } ;;
    *) grep -q -F -f "$PAT" "$f" && { echo "private text in $f" >&2; bad=1; } ;;
  esac
done
exit "$bad"
