#!/usr/bin/env bash
# One-time setup of the OrgWorld lab (nightly research sessions; see lab/README.md). Safe to re-run: it refreshes the
# lab tools and the launchd file, and leaves the frozen code, the workspace and the notebook alone.
#   lab/setup.sh              set up, or refresh the tools
#   lab/setup.sh --refreeze   also replace the frozen code with this commit (blocks an experiment in progress)
# It does not activate the nightly job; it prints the two commands that do.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LAB="${ORGWORLD_LAB:-$HOME/orgworld-lab}"
NODE="$(command -v node)"
LABEL=org.orgworld.lab
cd "$REPO"
mkdir -p "$LAB/bin" "$LAB/frozen" "$LAB/state" "$LAB/logs" "$LAB/unpublished"

# 1. Lab tools. They schedule, check and record; they do not change results, so refreshing them is always allowed.
cp lab/daily.sh lab/lab.mjs lab/privacy-check.sh "$LAB/bin/"
chmod +x "$LAB/bin/daily.sh" "$LAB/bin/privacy-check.sh"

# 2. Settings and privacy patterns (existing patterns are kept, so you can add your own, one per line).
URL="$(git remote get-url origin)"
[[ -f "$LAB/lab.env" ]] || sed "s|@REPO_URL@|${URL%.git}|" lab/lab.env.example >"$LAB/lab.env"
touch "$LAB/state/privacy-patterns"
{
  cat "$LAB/state/privacy-patterns"
  echo "/Users/"
  echo "$HOME"
  echo "EVOORG_RESEARCH"
  echo "docs/research/source"
  for e in "$(git config --global user.email || true)" "$(git config user.email || true)"; do
    if [[ -n "$e" && "$e" != *noreply* ]]; then echo "$e"; fi
  done
} | grep -v '^$' | sort -u >"$LAB/state/privacy-patterns.new"
mv "$LAB/state/privacy-patterns.new" "$LAB/state/privacy-patterns"

# 3. Frozen code: the experiment runs this bundle and these configs until you refreeze.
if [[ -L "$LAB/current" && "${1:-}" != --refreeze ]]; then
  echo "frozen code: $(readlink "$LAB/current") (unchanged; --refreeze replaces it)"
else
  git fetch -q origin
  git merge-base --is-ancestor HEAD origin/main || { echo "push this commit to origin/main first, so the notebook can link to the exact code" >&2; exit 1; }
  [[ -z "$(git status --porcelain)" ]] || echo "note: uncommitted changes are not frozen; building commit $(git rev-parse --short HEAD) as pushed"
  # Build in a temporary checkout of the commit, so the bundle matches it exactly.
  COMMIT="$(git rev-parse HEAD)"
  WT="$(mktemp -d)/orgworld-$COMMIT"
  git worktree add -q --detach "$WT" "$COMMIT"
  trap 'git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true' EXIT
  (cd "$WT" && { pnpm install -s --frozen-lockfile --offline || pnpm install -s --frozen-lockfile; } && pnpm -s build)
  D="$LAB/frozen/${COMMIT:0:12}"
  rm -rf "$D" && mkdir -p "$D"
  cp "$WT/dist/orgworld.mjs" "$D/" && cp -R "$WT/experiments" "$D/experiments"
  SHA="$(shasum -a 256 "$D/orgworld.mjs" | cut -d' ' -f1)"
  printf '{\n  "commit": "%s",\n  "bundleSha256": "%s",\n  "frozenAt": "%s",\n  "node": "%s"\n}\n' "$COMMIT" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$("$NODE" --version)" >"$D/FROZEN.json"
  ln -sfn "$D" "$LAB/current"
  echo "froze $COMMIT → $D"
fi

# 4. Event stores: one per experiment under workspaces/, created by the first session that runs it and deleted once
#    the experiment is complete and confirmed on GitHub.
mkdir -p "$LAB/workspaces"
[[ -d "$LAB/workspace" ]] && echo "note: $LAB/workspace is no longer used (one store per experiment in workspaces/); delete it once you have checked it holds nothing you need"

# 5. Notebook branch. Sessions download a slim copy each night and delete it after a confirmed push.
# shellcheck source=/dev/null
source "$LAB/lab.env"
NBR="${NOTEBOOK_BRANCH:-lab-notebook}"
printf '%s\n%s\n' "$(git config user.name)" "$(git config user.email)" >"$LAB/state/git-identity"
if ! git ls-remote --exit-code --heads origin "$NBR" >/dev/null 2>&1; then
  T="$(mktemp -d)"
  git init -q -b "$NBR" "$T"
  touch "$T/sessions.jsonl"
  "$NODE" "$LAB/bin/lab.mjs" index "$T" "${URL%.git}"
  git -C "$T" add -A
  git -C "$T" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" commit -q -m "Start the lab notebook"
  git -C "$T" push -q "$URL" "HEAD:refs/heads/$NBR"
  rm -rf "$T"
  echo "created branch $NBR on origin"
fi
if [[ -d "$LAB/notebook/.git" ]]; then
  # Older setups kept a permanent clone; remove it if it has nothing unpushed.
  if [[ -z "$(git -C "$LAB/notebook" status --porcelain)" ]] && git -C "$LAB/notebook" fetch -q origin "$NBR" && [[ -z "$(git -C "$LAB/notebook" log --oneline FETCH_HEAD..HEAD)" ]]; then
    rm -rf "$LAB/notebook"
  else
    echo "note: $LAB/notebook has unpushed changes; the next session pushes them"
  fi
fi
echo "notebook: branch $NBR on origin"

# 6. launchd job, written but not activated.
H="${START_TIME%%:*}" M="${START_TIME##*:}"
PLIST="$LAB/$LABEL.plist"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- OrgWorld lab: one research session every night at $START_TIME. Written by lab/setup.sh. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$LAB/bin/daily.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$((10#$H))</integer><key>Minute</key><integer>$((10#$M))</integer></dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/Applications/Ollama.app/Contents/Resources:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_BIN</key><string>$NODE</string>
    <key>ORGWORLD_LAB</key><string>$LAB</string>
  </dict>
  <key>StandardOutPath</key><string>$LAB/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$LAB/logs/launchd.log</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null
cat <<EOF

Lab ready. To run a session every night at $START_TIME:
  cp "$PLIST" ~/Library/LaunchAgents/
  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$LABEL.plist
To stop the nightly sessions:
  launchctl bootout gui/\$(id -u)/$LABEL
Settings: $LAB/lab.env · logs: $LAB/logs/
EOF
