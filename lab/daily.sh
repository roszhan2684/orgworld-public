#!/usr/bin/env bash
# OrgWorld lab: one nightly research session (see lab/README.md).
# Runs the next unfinished experiment in QUEUE on the free local model inside the time window, records the readings,
# and pushes them to the notebook branch. Never calls a paid model: the CLI refuses paid providers without
# --allow-paid, and this script never passes it.
set -uo pipefail

LAB="${ORGWORLD_LAB:-$HOME/orgworld-lab}"
[[ -f "$LAB/lab.env" ]] || { echo "no $LAB/lab.env; run lab/setup.sh first" >&2; exit 1; }
# Settings from lab.env; variables already set in the environment win (for one-off manual sessions).
OVERRIDES="$(for v in START_TIME STOP_AT HARD_STOP_AT QUEUE PUSH REQUIRE_AC_POWER; do [[ -n "${!v-}" ]] && printf '%s=%q\n' "$v" "${!v}"; done)"
# shellcheck source=/dev/null
source "$LAB/lab.env"
eval "$OVERRIDES"
NODE="${NODE_BIN:-$(command -v node)}"
CUR="$LAB/current"   # frozen code + experiment configs (lab/setup.sh)
NB="$LAB/notebook"   # slim copy of the notebook branch, downloaded each session and deleted after a confirmed push
GIT_NAME="$(sed -n 1p "$LAB/state/git-identity" 2>/dev/null)"
GIT_EMAIL="$(sed -n 2p "$LAB/state/git-identity" 2>/dev/null)"
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
S="$LAB/state/sessions/$STAMP"
SJ="$S/session.json"
mkdir -p "$LAB/logs" "$LAB/unpublished" "$S/runs"
LOG="$LAB/logs/$STAMP.log"
echo "OrgWorld lab session log: $LOG" >&2
exec >>"$LOG" 2>&1

lab() { "$NODE" "$LAB/bin/lab.mjs" "$@"; }
# One event store per experiment (deleted once the experiment is complete and confirmed on GitHub).
slug() { local x="${1#experiments/}"; x="${x%.yaml}"; x="${x%.yml}"; echo "${x//\//-}"; }
wsdir() { echo "$LAB/workspaces/$(slug "$1")"; }
owx() { ORGWORLD_HOME="$(wsdir "$1")" "$NODE" "$CUR/orgworld.mjs" "${@:2}"; } # owx CONFIG COMMAND ARGS…
ids() { lab get "$1" allRunIds | tr -d '[]"' | tr ',' ' '; }
say() { echo "[$(date +%H:%M:%S)] $*"; }
notify() { command -v osascript >/dev/null && osascript -e "display notification \"$1\" with title \"OrgWorld lab\"" >/dev/null 2>&1 || true; }
now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# One session at a time.
LOCK="$LAB/state/session.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then say "another session is running"; exit 0; fi
  rm -rf "$LOCK" && mkdir "$LOCK"
fi
echo $$ >"$LOCK/pid"
OLLAMA_PID="" EXP_PID="" WD_PID=""
cleanup() {
  [[ -n "$WD_PID" ]] && { pkill -P "$WD_PID" 2>/dev/null; kill "$WD_PID" 2>/dev/null; }
  [[ -n "$EXP_PID" ]] && kill "$EXP_PID" 2>/dev/null
  [[ -n "$OLLAMA_PID" ]] && kill "$OLLAMA_PID" 2>/dev/null
  [[ "${REMOVE_SESSION:-0}" == 1 ]] && rm -rf "$S"
  rm -rf "$LOCK"
}
trap cleanup EXIT
# A stop signal (a user, launchd, or another program) while an experiment runs: record it, stop the experiment, and
# still publish what was recorded. At any other time: exit.
on_signal() {
  say "received a stop signal"
  touch "$S/signalled"
  if [[ -n "$EXP_PID" ]]; then kill -TERM "$EXP_PID" 2>/dev/null; else exit 130; fi
}
trap on_signal INT TERM

nb_open() {
  if [[ -d "$NB/.git" ]]; then
    git -C "$NB" pull -q --rebase origin "$NOTEBOOK_BRANCH" || say "pull failed (offline?)"
  else
    rm -rf "$NB"
    git clone -q --depth 1 --filter=blob:none --sparse --branch "$NOTEBOOK_BRANCH" "$REPO_URL" "$NB" || return 1
    # Run exports stay on GitHub only: they are never downloaded back.
    git -C "$NB" sparse-checkout set --no-cone '/*' '!/data/*/runs/' || return 1
  fi
  git -C "$NB" config user.name "$GIT_NAME"
  git -C "$NB" config user.email "$GIT_EMAIL"
  printf '%s\n' '#!/bin/sh' "git diff --cached --name-only -z --diff-filter=ACMR | ORGWORLD_LAB=\"$LAB\" xargs -0 \"$LAB/bin/privacy-check.sh\" || { echo 'pre-commit: private text found; nothing committed' >&2; exit 1; }" >"$NB/.git/hooks/pre-commit"
  chmod +x "$NB/.git/hooks/pre-commit"
}

# Export every run of the experiment that is not on GitHub yet (counted, excluded, validation shadows).
export_runs() {
  local name="$1" cfg="$2" dir="$NB/data/$1/runs" have id f why
  mkdir -p "$dir"
  have="$(git -C "$NB" ls-tree -r --name-only HEAD -- "data/$name/runs/" 2>/dev/null)"
  for id in $(ids "$S/after.json"); do
    f="$id.orgworld-run.zip"
    grep -qxF "data/$name/runs/$f" <<<"$have" && continue
    [[ -f "$LAB/unpublished/$f" ]] && continue
    owx "$cfg" export --run "$id" --out "$dir/$f" >/dev/null || { say "export failed: $id"; continue; }
    why=""
    "$LAB/bin/privacy-check.sh" "$dir/$f" >/dev/null 2>&1 || why="it contains a private path or address"
    (($(stat -f %z "$dir/$f") > 50000000)) && why="it is larger than 50 MB"
    if [[ -n "$why" ]]; then
      mv "$dir/$f" "$LAB/unpublished/"
      lab push "$SJ" unpublished "{\"file\":\"$f\",\"reason\":\"$why\"}" json
    else
      lab push "$SJ" exported "$f"
    fi
  done
}

# A complete experiment whose runs and readings are all on GitHub no longer needs its local database.
archive_finished() {
  local c ws name have id missing
  for c in $QUEUE; do
    ws="$(wsdir "$c")"
    [[ -d "$ws" ]] || continue
    owx "$c" readings "$CUR/$c" --out "$S/archive.json" >/dev/null 2>&1 || continue
    [[ "$(lab get "$S/archive.json" done)" == true ]] || continue
    name="$(lab get "$S/archive.json" name)"
    have="$(git -C "$NB" ls-tree -r --name-only HEAD -- "data/$name/")"
    missing=0
    grep -qxF "data/$name/readings.json" <<<"$have" || missing=1
    for id in $(ids "$S/archive.json"); do grep -qxF "data/$name/runs/$id.orgworld-run.zip" <<<"$have" || missing=1; done
    if ((missing)); then say "$name is complete but not all of it is on GitHub; its database is kept"; continue; fi
    mkdir -p "$LAB/state/done"
    cp "$S/archive.json" "$LAB/state/done/$(slug "$c").json"
    rm -rf "$ws"
    say "$name: complete and confirmed on GitHub; local database removed"
  done
}

# After a confirmed push: remove what the next session does not need.
tidy() {
  cd "$LAB" || return
  rm -rf "$NB"
  find "$LAB/logs" -type f -name '*.log' -mtime +14 -delete 2>/dev/null
  find "$LAB/state/sessions" -mindepth 1 -maxdepth 1 -type d ! -name "$STAMP" -exec rm -rf {} + 2>/dev/null
  REMOVE_SESSION=1
}

publish() {
  nb_open || { say "could not download the notebook (offline?); this session is not published, its files stay in $S"; return; }
  cd "$NB" || return
  local name file progress="" pushed=0
  name="$(lab get "$S/after.json" name)"
  if [[ -n "$name" && "$(lab get "$SJ" outcome)" == ran ]]; then
    export_runs "$name" "$(lab get "$SJ" config)"
    [[ -f "$S/results.csv" ]] && cp "$S/results.csv" "data/$name/results.csv"
  fi
  file="$(lab render "$S" "$NB")" || { say "render failed"; return; }
  git -c advice.updateSparsePath=false add -A
  # New run exports sit outside the sparse checkout (only they exist locally), so they are added explicitly.
  [[ -n "$name" && -d "data/$name/runs" ]] && git add --sparse -- "data/$name/runs"
  if ! git diff --cached --name-only -z --diff-filter=ACMR | xargs -0 "$LAB/bin/privacy-check.sh"; then
    git reset -q
    say "privacy check failed; nothing committed"
    notify "Lab notebook NOT published: a file contains private text. See the log in ~/orgworld-lab/logs."
    return
  fi
  [[ -n "$name" ]] && progress=" · $name $(lab get "$S/after.json" completed)/$(lab get "$S/after.json" planned)"
  git commit -q -m "Lab session $(lab get "$SJ" date): $(lab get "$SJ" outcome)$progress" || say "nothing to commit"
  if [[ "${PUSH:-1}" == 1 ]]; then
    git push -q origin "HEAD:$NOTEBOOK_BRANCH" || { git pull -q --rebase origin "$NOTEBOOK_BRANCH" && git push -q origin "HEAD:$NOTEBOOK_BRANCH"; }
    [[ "$(git ls-remote origin "refs/heads/$NOTEBOOK_BRANCH" | cut -f1)" == "$(git rev-parse HEAD)" ]] && pushed=1
  fi
  if ((pushed)); then
    say "pushed $file (confirmed by GitHub)"
    archive_finished
    tidy
  else
    say "push not confirmed; everything is kept locally and the next session pushes it"
  fi
  notify "Session $(lab get "$SJ" outcome)$progress"
}

# finish OUTCOME REASON: record, publish, exit. A non-run session identical to the previous one is only logged.
finish() {
  lab set "$SJ" outcome "$1"
  [[ -n "${2:-}" ]] && lab set "$SJ" reason "$2"
  lab set "$SJ" endedAt "$(now_utc)"
  say "outcome: $1 ${2:-}"
  local key="$1|${2:-}"
  if [[ "$1" != ran && -f "$LAB/state/last-outcome" && "$(cat "$LAB/state/last-outcome")" == "$key" ]]; then
    say "same as the previous session; not published again"
    exit 0
  fi
  echo "$key" >"$LAB/state/last-outcome"
  publish
  exit 0
}

say "session start"
lab set "$SJ" date "$(date +%Y-%m-%d)"
lab set "$SJ" startedAt "$(now_utc)"
lab set "$SJ" window "${START_TIME}–$STOP_AT, hard stop $HARD_STOP_AT"
lab set "$SJ" repoUrl "$REPO_URL"
[[ -n "${SESSION_NOTE:-}" ]] && lab push "$SJ" notes "$SESSION_NOTE"
cp "$CUR/FROZEN.json" "$S/frozen.json"

# 1. Time window and power.
eval "$(lab window "$START_TIME" "$STOP_AT" "$HARD_STOP_AT")"
[[ "$IN_WINDOW" == 1 || "${FORCE:-0}" == 1 ]] || finish skipped "Started outside the window ${START_TIME}–$STOP_AT (the Mac was probably asleep at $START_TIME)."
POWER="$(pmset -g batt 2>/dev/null | head -1 | sed -E "s/.*'(.*)'.*/\1/")"
lab set "$SJ" power "$POWER"
[[ "${REQUIRE_AC_POWER:-1}" != 1 || "$POWER" != "Battery Power" ]] || finish skipped "On battery power (REQUIRE_AC_POWER=1)."
FREE_GB="$(df -g "$LAB" | awk 'NR==2 {print $4}')"
lab set "$SJ" freeDiskGB "$FREE_GB" json
((FREE_GB >= ${MIN_FREE_GB:-5})) || finish skipped "Less than ${MIN_FREE_GB:-5} GB of free disk space."

# 2. Next unfinished experiment in the queue.
CFG=""
for c in $QUEUE; do
  [[ -f "$CUR/$c" ]] || finish blocked "Queued config $c is not in the frozen code; re-run lab/setup.sh --refreeze after committing it."
  [[ -f "$LAB/state/done/$(slug "$c").json" ]] && continue # complete, on GitHub, local database removed
  [[ -d "$(wsdir "$c")" ]] || owx "$c" init >/dev/null || finish blocked "Could not create a workspace for $c (see the local log)."
  owx "$c" readings "$CUR/$c" --out "$S/before.json" >/dev/null || finish blocked "Could not read progress for $c (see the local log)."
  if [[ "$(lab get "$S/before.json" done)" != true ]]; then CFG="$c"; break; fi
done
[[ -n "$CFG" ]] || finish queue-finished "Every queued experiment is complete. Review the results, then add the next config to QUEUE in ~/orgworld-lab/lab.env."
lab set "$SJ" config "$CFG"
cp "$S/before.json" "$S/after.json"
EXP_ID="$(lab get "$S/before.json" experimentId)"
PROVIDER="$(lab get "$S/before.json" model.provider)"
MODEL="$(lab get "$S/before.json" model.model)"
[[ "$PROVIDER" == ollama ]] || finish blocked "$CFG uses the \"$PROVIDER\" provider; nightly sessions run only the free local model (ollama)."

# 3. Local model: running, downloaded, on the GPU.
OLLAMA_URL="${OLLAMA_HOST:-http://127.0.0.1:11434}"
up() { curl -fsS -m 3 "$OLLAMA_URL/api/version" >/dev/null 2>&1; }
if ! up && [[ -z "${OLLAMA_HOST:-}" ]] && command -v ollama >/dev/null; then
  say "starting ollama serve"
  ollama serve >>"$LAB/logs/ollama-$STAMP.log" 2>&1 &
  OLLAMA_PID=$!
  for _ in $(seq 30); do up && break; sleep 1; done
fi
lab ollama "$MODEL" "$S/ollama.json"
ERR="$(lab get "$S/ollama.json" error)"
[[ -z "$ERR" ]] || finish blocked "$ERR"
GPU="$(lab get "$S/ollama.json" gpuFraction)"
if [[ "$(uname -m)" == arm64 && "${ALLOW_CPU:-0}" != 1 ]] && awk "BEGIN { exit !(${GPU:-0} < 0.5) }"; then
  finish blocked "Ollama runs the model on the CPU, not the GPU (the Intel build under Rosetta: about 8 minutes per agent turn), so no run can finish in one window. Install the Apple-silicon Ollama app (see lab/README.md)."
fi

# 4. Environment lock: same code bundle and model weights for the whole experiment.
cat >"$S/env.json" <<EOF
{
  "bundleSha256": "$(lab get "$S/frozen.json" bundleSha256)",
  "commit": "$(lab get "$S/frozen.json" commit)",
  "model": "$MODEL",
  "modelDigest": "$(lab get "$S/ollama.json" digest)",
  "ollamaVersion": "$(lab get "$S/ollama.json" version)",
  "contextLength": "$(lab get "$S/ollama.json" contextLength)",
  "nodeVersion": "$("$NODE" --version)",
  "macos": "$(sw_vers -productVersion)",
  "machine": "$(sysctl -n hw.model), $(sysctl -n machdep.cpu.brand_string), $(($(sysctl -n hw.memsize) / 1073741824)) GB"
}
EOF
PROV="$LAB/state/$EXP_ID.provenance.json"
lab set "$SJ" provenanceFile "$PROV"
lab provenance "$PROV" "$S/env.json" "$(lab get "$SJ" date)" >"$S/prov.json"
[[ "$(lab get "$S/prov.json" status)" != blocked ]] || finish blocked "The experiment's code bundle or model weights changed (see Deviations). An experiment needs the same ones throughout: start a new experiment, or accept the change with ACCEPT_ENV_CHANGE=1 (recorded as a deviation)."

# 5. Run until the window closes. Runs are atomic: the CLI starts no run that would not finish by STOP_AT, and the
#    watchdog stops anything still running at HARD_STOP_AT (that run is kept, excluded, and re-run next session).
OLOG="$HOME/.ollama/logs/server.log"
OLOG_START="$(stat -f %z "$OLOG" 2>/dev/null || echo 0)"
RC=0
if [[ "${PUBLISH_ONLY:-0}" == 1 ]]; then
  # Publish what is already recorded (e.g. after a session that was stopped before it could publish); no new runs.
  say "publish only: no new runs"
  : >"$S/experiment.out"
else
  say "running $CFG; no new run after $STOP_AT; hard stop $HARD_STOP_AT (in ${SECS_TO_HARD}s)"
  # Started directly (not through a shell function) so that $! is the experiment process itself.
  export ORGWORLD_HOME; ORGWORLD_HOME="$(wsdir "$CFG")"
  "$NODE" "$CUR/orgworld.mjs" experiment "$CUR/$CFG" --stop-at "$STOP_AT" >"$S/experiment.out" 2>&1 &
  EXP_PID=$!
  caffeinate -i -s -w "$EXP_PID" &
  (sleep "$SECS_TO_HARD"; touch "$S/hard-stop"; kill -TERM "$EXP_PID"; sleep 60; kill -KILL "$EXP_PID") 2>/dev/null &
  WD_PID=$!
  wait "$EXP_PID"
  RC=$?
  # A trapped signal interrupts wait; keep waiting until the experiment has really exited.
  while kill -0 "$EXP_PID" 2>/dev/null; do wait "$EXP_PID"; RC=$?; done
  EXP_PID=""
  pkill -P "$WD_PID" 2>/dev/null; kill "$WD_PID" 2>/dev/null; WD_PID=""
  cat "$S/experiment.out"
fi

# 6. Readings.
HARD=false; [[ -f "$S/hard-stop" ]] && HARD=true
STATUS="$(sed -n 's/^status: //p' "$S/experiment.out" | tail -1)"
lab set "$SJ" hardStopped "$HARD" json
lab set "$SJ" exitCode "$RC" json
lab set "$SJ" retries "$(grep -c 'model call failed (attempt' "$S/experiment.out")" json
# Ollama logs every request with "truncated = 0|1"; count the truncated ones written during this session.
TRUNC="$(tail -c +"$((OLOG_START + 1))" "$OLOG" 2>/dev/null | grep -c 'truncated = 1')"
lab set "$SJ" truncatedPrompts "${TRUNC:-0}" json
while IFS= read -r n; do lab push "$SJ" notes "$n"; done < <(sed -n 's/^note: //p' "$S/experiment.out")
SIG=false; [[ -f "$S/signalled" ]] && SIG=true
case "$HARD:$SIG:$STATUS" in
  true:*) STOP="hard stop at $HARD_STOP_AT" ;;
  *:true:*) STOP="stopped by an outside signal at $(date -r "$S/signalled" +%H:%M) (the run in progress is kept, excluded and re-run next session)" ;;
  *:*:completed) STOP="experiment complete" ;;
  *:*:time-stopped) STOP="time window closing at $STOP_AT" ;;
  *:*:infra-stopped) STOP="model service kept failing after retries" ;;
  *:*:budget-stopped) STOP="experiment budget ceiling" ;;
  *) STOP="the experiment process exited with code $RC (see the local log)" ;;
esac
[[ "${PUBLISH_ONLY:-0}" == 1 ]] && STOP="publish only: results recorded so far, no new runs"
lab set "$SJ" stopReason "$STOP"
owx "$CFG" readings "$CUR/$CFG" --out "$S/after.json" --csv "$S/results.csv" >/dev/null || say "readings failed"

# Run exports, the privacy check and the push happen in publish (finish → publish).
finish ran
