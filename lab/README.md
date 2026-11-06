# OrgWorld lab: nightly research sessions

The lab runs the pre-registered experiments a little each night on a free local model. It records every reading and pushes them to the [`lab-notebook`](https://github.com/roszhan2684/orgworld-public/tree/lab-notebook) branch. It never calls a paid model: the CLI refuses paid providers unless given `--allow-paid`, and the lab never passes that flag.

## What one session does

`daily.sh` starts every night at `START_TIME` (launchd) and does the following in order:

1. **Checks the window and power.** It skips the night if it started outside `START_TIME`–`STOP_AT` (for example, the Mac was asleep and woke later) or if the Mac is on battery.
2. **Picks the experiment.** It takes the first experiment in `QUEUE` that isn't complete yet.
3. **Checks the model.** It starts Ollama if needed and checks that the model is downloaded and runs on the GPU. A model on the CPU blocks the session, because no run could finish in one window.
4. **Locks the environment.** The first session of an experiment records the frozen code bundle, the model-weights digest and the runtime versions. In later sessions:
   - a different bundle or different weights **blocks** the experiment;
   - a different Ollama, Node or macOS version is recorded as a **deviation**.
5. **Runs, stopping between runs.** A run is atomic. The CLI (`orgworld experiment --stop-at`) doesn't start a run that the longest completed run says would not finish by `STOP_AT`. Anything still running at `HARD_STOP_AT` is stopped. That run is kept but excluded from the results, and it's re-run from the start next session (C-19).
6. **Records the readings:**
   - progress, per-run metrics and interim aggregates (`orgworld readings`);
   - the results CSV;
   - a full event-log export of every new run, including excluded runs and validation shadows;
   - the session page;
   - the index.
7. **Publishes.** Every file passes a privacy check first, which blocks the machine's home path, the researcher's email and the private research dossier. Then the session is committed and pushed to `lab-notebook`.

**Storage.** The Mac keeps only what the next session needs:
- the event store of each unfinished experiment (`~/orgworld-lab/workspaces/<experiment>/`);
- the frozen code;
- the settings;
- the model.

Each session downloads a slim copy of the notebook (pages and readings only; run exports are never downloaded back). It adds the new run exports, pushes, and confirms the push with GitHub before deleting anything. After that confirmation it deletes:
- the notebook copy and the session's working files;
- logs older than 14 days;
- for a complete experiment whose every run export is on GitHub, its whole event store. A small note in `state/done/` keeps that experiment from running again.

If the push isn't confirmed, nothing is deleted and the next session pushes it. If less than `MIN_FREE_GB` (default 5 GB) is free, the session is skipped.

Sessions that don't run anything (skipped, blocked, queue finished) are published once. If the next one repeats the same outcome for the same reason, it is only logged locally.

## Set up (once)

Requirements:

- macOS on Apple silicon, Node ≥ 22.13, `pnpm`, and `git` able to push to the repo.
- **Ollama for Apple silicon.** An Intel (x86_64) Ollama running under Rosetta uses the CPU only, at about 8 minutes per agent turn, and the lab refuses it. If yours is from an Intel Homebrew (`file -L "$(command -v ollama)"` says `x86_64` only):
  1. Run `brew uninstall ollama`. Downloaded models in `~/.ollama` are kept.
  2. Install the app from https://ollama.com/download and open it once.
  3. Check: after any request, `ollama ps` should show `100% GPU`.
- The model: `ollama pull qwen2.5-coder:7b`.

From the repo, once the commit you want to run is on `origin/main`. Setup builds that commit in a temporary checkout, so uncommitted changes never get into the experiment:

```bash
lab/setup.sh
```

`setup.sh` freezes the code (bundle plus `experiments/`) into `~/orgworld-lab/current` and creates `~/orgworld-lab/workspaces/` for the per-experiment event stores, creates the notebook branch if it doesn't exist yet, and writes the settings file `~/orgworld-lab/lab.env`. It prints two commands that switch on the nightly job:

```bash
cp ~/orgworld-lab/org.orgworld.lab.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.orgworld.lab.plist
# stop:  launchctl bootout gui/$(id -u)/org.orgworld.lab
```

A laptop must be awake and plugged in at `START_TIME`. Either leave it open with "Prevent automatic sleeping on power adapter when the display is off" turned on (System Settings → Battery → Options), or schedule a wake with `sudo pmset repeat wakeorpoweron MTWRFSU 00:55:00`. During a session, `caffeinate` keeps it awake.

## Day to day

- **Settings:** edit `~/orgworld-lab/lab.env` (window, queue, power, push). To change `START_TIME`, re-run `lab/setup.sh` and bootstrap again.
- **Manual session now:** `FORCE=1 STOP_AT=15:00 HARD_STOP_AT=15:30 ~/orgworld-lab/bin/daily.sh`. Variables set in the environment override `lab.env`.
- **Logs:** `~/orgworld-lab/logs/`. Per-session working files are in `~/orgworld-lab/state/sessions/`.
- **Next experiment:** when the queue is finished, the notebook says so. Review the results, then add the next config to `QUEUE`. Per the pilot's pre-registration addendum, `pilot.yaml` follows `feasibility.yaml` only after the feasibility review.
- **New code:** commit, push, and run `lab/setup.sh --refreeze`. Do this only between experiments; an experiment in progress is blocked if its code changes.
- **Accepting an environment change** (avoid it): `ACCEPT_ENV_CHANGE=1 ~/orgworld-lab/bin/daily.sh` records it as a deviation in the notebook.

## Files

| File | Role |
| --- | --- |
| `setup.sh` | one-time setup and tool refresh; writes the launchd file but does not activate it |
| `daily.sh` | one session (installed to `~/orgworld-lab/bin/`) |
| `lab.mjs` | time window, Ollama checks, environment lock, notebook pages (no dependencies) |
| `privacy-check.sh` | refuses files, including files inside run zips, that contain private text |
| `lab.env.example` | default settings |
