# connectome-smoke

Smoke tests for the **published** Connectome stack — proof that what is on
npm installs from nothing, builds, boots, and takes a turn — plus a
separate lane for the repos' `main` branches laid out the way fleet boxes
deploy them.

Runs on GitHub Actions: every 30 minutes it polls the registry and the
source mains, and runs when the set it would test changed (the published
versions, the mains' heads, or this workflow's commit; debounced, so a
cascading release membrane → cm → af → host is tested once, settled), or
on demand. Results go to `#connectome-ops` (Discord webhook) and the run's
job summary.
Each lane runs on three runtimes: Node 22.12.0 with Bun 1.4.3, the highest
floors the stack's packages declare; the newest Node 24 with the newest Bun;
and the newest Node with the newest Bun.

## Lanes

| lane | what it proves |
|---|---|
| `published` | `npm install @animalabs/connectome-host` (+ heartbeat-mcpl, discord-mcpl) into an empty dir resolves, postinstall builds the web UI, chronicle's native binding loads, the host's TS source typechecks against the published deps' `.d.ts`, the host boots headless on the mock provider with a real MCPL server, takes a turn, serves `/healthz` (auth enforced), writes a provider receipt, offers the MCPL tools to the model, shuts down clean — then boots **again** on the same store and takes a second turn. Reports each package's resolved version vs. its `latest` tag (caret on 0.x is minor-locked, so a consumer can legitimately be behind — the report shows it) and nested duplicate copies of core packages (fails on core). |
| `latest` | same, with every `@animalabs/*` forced to its `latest` dist-tag via npm overrides — "is newest-of-everything coherent?" |
| `source` | clone `main` of voice-kit, mcpl-core-ts, membrane, context-manager, agent-framework, connectome-host, heartbeat-mcpl, discord-mcpl, portal (protocol/client/mcpl/relay); per repo: strict `npm ci` → build → typecheck → test, in `file:`-link order (voice-kit before discord-mcpl and portal-relay). Then compose host@main + membrane/cm/af@main into one tree (nested copies removed, single symlink root; chronicle from npm — Rust) — typecheck the host against the sibling mains and boot it twice. |

Every run, a lane on one runtime, leaves `report-<lane>-<runtime>.json` and
`summary-<lane>-<runtime>.md` as artifacts, and, when the run reached the
boot, the host's output and the full IPC event stream.

## Run locally

Needs Node 22.12 or later, npm, Bun 1.4.3 or later (the floors connectome-host declares in `engines`; the host runs under Bun), and git. Each lane checks its Bun against the floor the host it tests declares, and fails, naming both, when it's below.

```sh
node lanes/published.mjs                       # consumer view
node lanes/published.mjs --lane latest         # newest-of-everything
node lanes/source.mjs                          # mains, ~10 min
node lanes/source.mjs --only voice-kit,discord-mcpl   # subset, no compose
```

Options: `--workdir DIR` (default: a temp dir, deleted on pass unless
`--keep`), `--report FILE`, `--summary FILE`, `--host @animalabs/connectome-host@<spec>`.
Exit 0 = pass.

`npm test` runs the tests of the notifier, the registry manifest and the
lanes' shared helpers, as the *unit tests* workflow does on every push to
`main` and every pull request.

## Triggering

- **Manual:** Actions → *connectome smoke* → *Run workflow* (choose lanes;
  `force`, the default, runs even when the set was tested or is settling) — or
  `gh workflow run smoke.yml -R anima-research/connectome-smoke`.
- **Automatic:** the 30-min poll. `scripts/manifest.mjs` hashes the set of
  `latest` versions and `scripts/source-heads.mjs` the source mains' heads;
  a run is skipped when both were already tested by the workflow's current
  commit (an Actions cache entry `tested-<set hash>-<heads hash>-<commit>`,
  so any commit, a docs-only one included, makes the set untested once) or
  when the newest publish is younger than `DEBOUNCE_MINUTES` (20). A set is
  remembered once a run of every lane had every lane's summary on every
  runtime reach the report, whether they pass or not, and its post went
  out. A set whose post would only say all is well (every run passed, and
  nothing else went wrong) is also remembered when its post can't go out
  until someone acts (no webhook, or a refusal the next poll would meet
  too); one whose post reports a failure, a lane job that didn't end in
  success included, is remembered only once that post goes out, so until
  then a later poll runs it again and posts it once the webhook works. A
  run whose summary never arrived, or a post that didn't go out for a
  passing reason (no answer, a rate limit, a server error), leaves the set
  to the next poll too. A later poll skips a set only while the cache
  holds a marker it can read, one a run on the default branch saved and
  not yet evicted. The workflow can't replace or delete a cache entry, so
  a forced manual run of a set already remembered leaves it remembered,
  whatever that run finds. Remembering is best-effort: a cache save that
  fails doesn't fail the run, so a set whose post went out can run and
  post again at the next poll. A registry lookup that fails
  stops the poll, or the manual run, before anything runs, and the next
  poll asks again; a stopped poll posts nothing to Discord and shows only
  as a failed run, with the reason in its log.
- **From a publish workflow** (optional): `repository_dispatch` with
  `event_type: npm-publish` — treated as a poll tick, still debounced.

## What a failure means

- `npm install` fails → the published set is un-installable (a dep range
  points at nothing, a postinstall breaks, a native binary is missing).
- `bun meets the host's floor` fails → the lanes' Bun is below the
  `engines.bun` of the host they test, and the host isn't broken: raise the
  `floor` runtime's `bun` in `RUNTIMES`, in `.github/workflows/smoke.yml`,
  which sets each leg's Bun (run locally, put a Bun at or above the floor
  first on `PATH`). Or the check couldn't read the
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
uses). Absent, the notifier prints what it would have posted, and in
Actions it then fails the report job, since nobody was told.
