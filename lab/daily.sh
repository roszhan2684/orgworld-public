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
NB="$LAB/notebook"   # clone of the notebook branch
export ORGWORLD_HOME="$LAB/workspace"
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
S="$LAB/state/sessions/$STAMP"
SJ="$S/session.json"
mkdir -p "$LAB/logs" "$LAB/unpublished" "$S/runs"
LOG="$LAB/logs/$STAMP.log"
echo "OrgWorld lab session log: $LOG" >&2
exec >>"$LOG" 2>&1

lab() { "$NODE" "$LAB/bin/lab.mjs" "$@"; }
ow() { "$NODE" "$CUR/orgworld.mjs" "$@"; }
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
  rm -rf "$LOCK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

publish() {
  cd "$NB" || { say "no notebook clone at $NB"; return; }
  git pull -q --rebase origin "$NOTEBOOK_BRANCH" || say "pull failed (offline?); committing locally"
  local name; name="$(lab get "$S/after.json" name)"
  if [[ -n "$name" ]]; then
    mkdir -p "data/$name/runs"
    [[ -f "$S/results.csv" ]] && cp "$S/results.csv" "data/$name/results.csv"
    find "$S/runs" -name '*.zip' -exec mv {} "data/$name/runs/" \;
  fi
  local file; file="$(lab render "$S" "$NB")" || { say "render failed"; return; }
  git add -A
  if ! git diff --cached --name-only -z --diff-filter=ACMR | xargs -0 "$LAB/bin/privacy-check.sh"; then
    git reset -q
    say "privacy check failed; nothing committed"
    notify "Lab notebook NOT published: a file contains private text. See the log in ~/orgworld-lab/logs."
    return
  fi
  local progress=""; [[ -n "$name" ]] && progress=" · $name $(lab get "$S/after.json" completed)/$(lab get "$S/after.json" planned)"
  git commit -q -m "Lab session $(lab get "$SJ" date): $(lab get "$SJ" outcome)$progress" || say "nothing to commit"
  if [[ "${PUSH:-1}" == 1 ]]; then
    if git push -q origin "HEAD:$NOTEBOOK_BRANCH" || { git pull -q --rebase origin "$NOTEBOOK_BRANCH" && git push -q origin "HEAD:$NOTEBOOK_BRANCH"; }; then say "pushed $file"; else say "push failed; the next session pushes it"; fi
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
cp "$CUR/FROZEN.json" "$S/frozen.json"

# 1. Time window and power.
eval "$(lab window "$START_TIME" "$STOP_AT" "$HARD_STOP_AT")"
[[ "$IN_WINDOW" == 1 || "${FORCE:-0}" == 1 ]] || finish skipped "Started outside the window ${START_TIME}–$STOP_AT (the Mac was probably asleep at $START_TIME)."
POWER="$(pmset -g batt 2>/dev/null | head -1 | sed -E "s/.*'(.*)'.*/\1/")"
lab set "$SJ" power "$POWER"
[[ "${REQUIRE_AC_POWER:-1}" != 1 || "$POWER" != "Battery Power" ]] || finish skipped "On battery power (REQUIRE_AC_POWER=1)."

# 2. Next unfinished experiment in the queue.
CFG=""
for c in $QUEUE; do
  [[ -f "$CUR/$c" ]] || finish blocked "Queued config $c is not in the frozen code; re-run lab/setup.sh --refreeze after committing it."
  ow readings "$CUR/$c" --out "$S/before.json" >/dev/null || finish blocked "Could not read progress for $c (see the local log)."
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
say "running $CFG; no new run after $STOP_AT; hard stop $HARD_STOP_AT (in ${SECS_TO_HARD}s)"
# Started directly (not through a shell function) so that $! is the experiment process itself.
"$NODE" "$CUR/orgworld.mjs" experiment "$CUR/$CFG" --stop-at "$STOP_AT" >"$S/experiment.out" 2>&1 &
EXP_PID=$!
caffeinate -i -s -w "$EXP_PID" &
(sleep "$SECS_TO_HARD"; touch "$S/hard-stop"; kill -TERM "$EXP_PID"; sleep 60; kill -KILL "$EXP_PID") 2>/dev/null &
WD_PID=$!
wait "$EXP_PID"
RC=$?
EXP_PID=""
pkill -P "$WD_PID" 2>/dev/null; kill "$WD_PID" 2>/dev/null; WD_PID=""
cat "$S/experiment.out"

# 6. Readings.
HARD=false; [[ -f "$S/hard-stop" ]] && HARD=true
STATUS="$(sed -n 's/^status: //p' "$S/experiment.out" | tail -1)"
lab set "$SJ" hardStopped "$HARD" json
lab set "$SJ" exitCode "$RC" json
lab set "$SJ" retries "$(grep -c 'model call failed (attempt' "$S/experiment.out")" json
while IFS= read -r n; do lab push "$SJ" notes "$n"; done < <(sed -n 's/^note: //p' "$S/experiment.out")
case "$HARD:$STATUS" in
  true:*) STOP="hard stop at $HARD_STOP_AT" ;;
  *:completed) STOP="experiment complete" ;;
  *:time-stopped) STOP="time window closing at $STOP_AT" ;;
  *:infra-stopped) STOP="model service kept failing after retries" ;;
  *:budget-stopped) STOP="experiment budget ceiling" ;;
  *) STOP="the experiment process exited with code $RC (see the local log)" ;;
esac
lab set "$SJ" stopReason "$STOP"
ow readings "$CUR/$CFG" --out "$S/after.json" --csv "$S/results.csv" >/dev/null || say "readings failed"

# Export every run not yet in the notebook (counted, excluded, validation shadows) after a privacy and size check.
NAME="$(lab get "$S/after.json" name)"
for id in $(lab get "$S/after.json" allRunIds | tr -d '[]"' | tr ',' ' '); do
  f="$id.orgworld-run.zip"
  [[ -f "$NB/data/$NAME/runs/$f" || -f "$LAB/unpublished/$f" ]] && continue
  ow export --run "$id" --out "$S/runs/$f" >/dev/null || { say "export failed: $id"; continue; }
  why=""
  "$LAB/bin/privacy-check.sh" "$S/runs/$f" >/dev/null || why="it contains a private path or address"
  (($(stat -f %z "$S/runs/$f") > 50000000)) && why="it is larger than 50 MB"
  if [[ -n "$why" ]]; then
    mv "$S/runs/$f" "$LAB/unpublished/"
    lab push "$SJ" unpublished "{\"file\":\"$f\",\"reason\":\"$why\"}" json
  else
    lab push "$SJ" exported "$f"
  fi
done

finish ran
