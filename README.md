# connectome-smoke

Smoke tests for the **published** Connectome stack — proof that what is on
npm installs from nothing, builds, boots, and takes a turn — plus a
separate lane for the repos' `main` branches laid out the way fleet boxes
deploy them.

Runs on GitHub Actions: every 30 minutes it polls the registry and runs
when the set of published versions changed (debounced, so a cascading
release membrane → cm → af → host is tested once, settled), or on demand.
Results go to `#connectome-ops` (Discord webhook) and the run's job summary.

## Lanes

| lane | what it proves |
|---|---|
| `published` | `npm install @animalabs/connectome-host` (+ heartbeat-mcpl, discord-mcpl) into an empty dir resolves, postinstall builds the web UI, chronicle's native binding loads, the host's TS source typechecks against the published deps' `.d.ts`, the host boots headless on the mock provider with a real MCPL server, takes a turn, serves `/healthz` (auth enforced), writes a provider receipt, offers the MCPL tools to the model, shuts down clean — then boots **again** on the same store and takes a second turn. Reports each package's resolved version vs. its `latest` tag (caret on 0.x is minor-locked, so a consumer can legitimately be behind — the report shows it) and nested duplicate copies of core packages (fails on core). |
| `latest` | same, with every `@animalabs/*` forced to its `latest` dist-tag via npm overrides — "is newest-of-everything coherent?" |
| `source` | clone `main` of voice-kit, mcpl-core-ts, membrane, context-manager, agent-framework, connectome-host, heartbeat-mcpl, discord-mcpl, portal (protocol/client/mcpl/relay); per repo: strict `npm ci` → build → typecheck → test, in `file:`-link order (voice-kit before discord-mcpl and portal-relay). Then compose host@main + membrane/cm/af@main into one tree (nested copies removed, single symlink root; chronicle from npm — Rust) — typecheck the host against the sibling mains and boot it twice. |

Every lane leaves `report.json`, `summary.md`, the host's output and the full
IPC event stream as artifacts.

## Run locally

Needs node ≥ 22.12, npm, bun ≥ 1.4.3 (the floors connectome-host declares in `engines`; the host runs under bun), git. Each lane checks its Bun against the floor the host it tests declares, and fails, naming both, when it's below.

```sh
node lanes/published.mjs                       # consumer view
node lanes/published.mjs --lane latest         # newest-of-everything
node lanes/source.mjs                          # mains, ~10 min
node lanes/source.mjs --only voice-kit,discord-mcpl   # subset, no compose
```

Options: `--workdir DIR` (default: a temp dir, deleted on pass unless
`--keep`), `--report FILE`, `--summary FILE`, `--host @animalabs/connectome-host@<spec>`.
Exit 0 = pass.

## Triggering

- **Manual:** Actions → *connectome smoke* → *Run workflow* (choose lanes;
  `force` runs even if the published set is unchanged) — or
  `gh workflow run smoke.yml -R anima-research/connectome-smoke`.
- **Automatic:** the 30-min poll. `scripts/manifest.mjs` hashes the set of
  `latest` versions; a run is skipped when that hash was already tested (an
  Actions cache entry `tested-<hash>`, saved only after the lanes completed)
  or when the newest publish is younger than `DEBOUNCE_MINUTES` (20).
- **From a publish workflow** (optional): `repository_dispatch` with
  `event_type: npm-publish` — treated as a poll tick, still debounced.

## What a failure means

- `npm install` fails → the published set is un-installable (a dep range
  points at nothing, a postinstall breaks, a native binary is missing).
- `bun meets the host's floor` fails → the lanes' Bun is below the
  `engines.bun` of the host they test, and the host isn't broken: raise both
  `setup-bun` steps in `.github/workflows/smoke.yml` (run locally, put a Bun
  at or above the floor first on `PATH`). Or the check couldn't read the
  floor or the Bun version, and its message says which and where to look.
- `typecheck published host src` fails → the host ships source that does
  not compile against the `.d.ts` its own dependency ranges resolve to.
- `boot #1` fails → the stack does not take a turn; the step detail carries
  the host's last 40 output lines and `*.events.jsonl` has every IPC event.
- `boot #2` fails → the store written by boot #1 does not reload.
- `source` per-repo failures name the repo and stage; `install` failures on
  discord-mcpl / portal-relay are usually the `file:` sibling not building.

## Secrets

`DISCORD_WEBHOOK` — the `#connectome-ops` webhook (same one fleet-watch
uses). Absent, the notifier prints instead of posting.
