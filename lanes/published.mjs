#!/usr/bin/env node
/**
 * connectome-smoke — "published" lane.
 *
 * Installs the connectome stack FROM THE NPM REGISTRY into a fresh directory,
 * exactly as a new consumer would, then proves it boots and takes a turn:
 *
 *   1. npm install @animalabs/connectome-host (+ heartbeat-mcpl, discord-mcpl)
 *      — resolves af / context-manager / membrane / chronicle / mcpl-core
 *      from the registry; the host's postinstall builds the web UI.
 *   2. Records what resolved vs. each package's `latest` dist-tag (lag report)
 *      and flags nested duplicate copies of core packages.
 *   3. Typechecks the published host's src against the published deps' .d.ts
 *      (the host ships TS run by bun — "it builds" means this).
 *   4. Boots the host headless with membrane's mock provider + the heartbeat
 *      MCPL server, drives a full turn over the IPC socket, checks /healthz
 *      (auth on/off), the provider receipt, and that MCPL tools reached the
 *      model; shuts down cleanly.
 *   5. Boots AGAIN on the same data dir (chronicle store reload), second turn.
 *
 * Lanes:  --lane published   what a consumer gets (default)
 *         --lane latest      every @animalabs/* pinned to its `latest` tag via
 *                            npm overrides — "is newest-of-everything coherent?"
 *
 * Zero dependencies. Needs node >= 22.12, bun >= 1.4.3 (the floors connectome-host
 * declares in `engines`; the host runs under bun), npm. Checks its Bun against
 * the floor the host it installs declares, and fails, naming both, below it.
 * Exit 0 pass / 1 fail. Writes --report (JSON) and --summary (markdown).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport, sh, bootTwice, finish, parseArgs, bunMeetsHostFloor } from '../lib/common.mjs';

const { opt, flag } = parseArgs(process.argv.slice(2));
const LANE = opt('lane', 'published');
const WORK = opt('workdir') ? resolve(opt('workdir')) : mkdtempSync(join(tmpdir(), `connectome-smoke-${LANE}-`));
const REPORT = opt('report', join(WORK, 'report.json'));
const SUMMARY = opt('summary', join(WORK, 'summary.md'));
const HOST_SPEC = opt('host', '@animalabs/connectome-host@latest');
const KEEP = flag('keep');

const STACK = [
  '@animalabs/chronicle', '@animalabs/membrane', '@animalabs/context-manager', '@animalabs/agent-framework',
  '@animalabs/connectome-host', '@animalabs/mcpl-core', '@animalabs/heartbeat-mcpl', '@animalabs/discord-mcpl',
];

const { report, step, log, t0 } = makeReport(LANE, { workdir: WORK, resolved: {}, latest: {}, lag: [], nestedDuplicates: [] });
const S = (p) => p.replace('@animalabs/', '');

(async () => {
  mkdirSync(WORK, { recursive: true });
  log(`workdir ${WORK}`);
  if (!report.bun) { log('FATAL: bun not found on PATH'); process.exit(2); }

  await step('registry: latest dist-tags', () => {
    for (const p of STACK) {
      const r = sh('npm', ['view', p, 'version', '--json'], { cwd: WORK, allowFail: true });
      report.latest[p] = r.status === 0 ? JSON.parse(r.stdout) : null;
    }
    return Object.entries(report.latest).map(([k, v]) => `${S(k)}@${v}`).join(' ');
  });

  const pkg = { name: 'connectome-smoke-consumer', private: true, version: '0.0.0', type: 'module' };
  if (LANE === 'latest') {
    pkg.overrides = Object.fromEntries(Object.entries(report.latest).filter(([, v]) => v).map(([k, v]) => [k, v]));
  }
  writeFileSync(join(WORK, 'package.json'), JSON.stringify(pkg, null, 2));

  const installOk = await step(`npm install (${LANE})`, () => {
    const specs = [HOST_SPEC, '@animalabs/heartbeat-mcpl@latest', '@animalabs/discord-mcpl@latest', 'typescript@^5', '@types/bun', '@types/node@^22'];
    const r = sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...specs], { cwd: WORK, timeout: 900_000 });
    return (r.stdout + r.stderr).trim().split('\n').slice(-3).join('\n');
  });
  if (!installOk) return done();

  await step("bun meets the host's floor", () => {
    const said = bunMeetsHostFloor(join(WORK, 'node_modules', '@animalabs', 'connectome-host', 'package.json'), report.bun);
    log(said);
    return said;
  });

  await step('resolved versions + lag vs latest + nested copies', () => {
    for (const p of STACK) {
      const pj = join(WORK, 'node_modules', p, 'package.json');
      report.resolved[p] = existsSync(pj) ? JSON.parse(readFileSync(pj, 'utf-8')).version : null;
      if (report.resolved[p] && report.latest[p] && report.resolved[p] !== report.latest[p]) {
        report.lag.push({ pkg: p, resolved: report.resolved[p], latest: report.latest[p] });
      }
    }
    // Two copies of a core package in one tree = the duplicate-Membrane class
    // of bug (instanceof / TS2322 across copies). Report all; fail on core.
    for (const p of STACK) {
      const nm = join(WORK, 'node_modules', p, 'node_modules', '@animalabs');
      if (existsSync(nm)) for (const d of readdirSync(nm)) report.nestedDuplicates.push(`${S(p)} → ${d}`);
    }
    const coreDup = report.nestedDuplicates.filter((n) => /→ (chronicle|membrane|context-manager|agent-framework)$/.test(n));
    if (coreDup.length) throw new Error(`nested duplicate core packages: ${coreDup.join(', ')}`);
    return Object.entries(report.resolved).map(([k, v]) => `${S(k)}@${v}`).join(' ')
      + (report.lag.length ? `\n    lag: ${report.lag.map((l) => `${S(l.pkg)} ${l.resolved}→${l.latest}`).join(', ')}` : '')
      + (report.nestedDuplicates.length ? `\n    nested: ${report.nestedDuplicates.join(', ')}` : '');
  });

  const hostDir = join(WORK, 'node_modules', '@animalabs', 'connectome-host');

  await step('chronicle native binding loads', () => {
    sh('node', ['-e', `const c=require(${JSON.stringify(join(WORK, 'node_modules', '@animalabs', 'chronicle'))}); if(!Object.keys(c).length) throw new Error('no exports')`], { cwd: WORK });
    return 'ok';
  });

  await step('web UI bundle built by postinstall', () => {
    const idx = join(hostDir, 'dist', 'web', 'index.html');
    if (!existsSync(idx)) throw new Error(`missing ${idx}`);
    return 'dist/web/index.html present';
  });

  await step('typecheck published host src against published deps', () => {
    const r = sh('npx', ['tsc', '--noEmit', '-p', join(hostDir, 'tsconfig.json')], { cwd: WORK, allowFail: true, timeout: 600_000 });
    if (r.status !== 0) throw new Error((r.stdout + r.stderr).trim().split('\n').filter((l) => /error TS/.test(l)).slice(0, 25).join('\n') || `tsc exit ${r.status}`);
    return 'clean';
  });

  await step('published mcpl servers: bins resolve + parse', () => {
    const bins = ['heartbeat-mcpl', 'discord-mcpl'];
    const missing = bins.filter((b) => !existsSync(join(WORK, 'node_modules', '.bin', b)));
    if (missing.length) throw new Error(`missing bins: ${missing.join(', ')}`);
    sh('node', ['--check', join(WORK, 'node_modules', '@animalabs', 'discord-mcpl', 'dist', 'src', 'index.js')], { cwd: WORK });
    return bins.join(', ');
  });

  await bootTwice({
    step, hostDir, work: WORK, dataDir: join(WORK, 'data'),
    heartbeatEntry: join(WORK, 'node_modules', '@animalabs', 'heartbeat-mcpl', 'dist', 'src', 'index.js'),
  });
  done();
})().catch((e) => { log(`FATAL ${e?.stack || e}`); report.fatal = String(e?.stack || e); done(); });

function done() {
  const v = (p) => report.resolved[p] ?? '—';
  const extra = [];
  if (report.lag.length) extra.push(`lag vs latest: ${report.lag.map((l) => `${S(l.pkg)} ${l.resolved}→${l.latest}`).join(', ')}`);
  if (report.nestedDuplicates.length) extra.push(`nested copies: ${report.nestedDuplicates.join(', ')}`);
  if (!KEEP && !opt('workdir')) process.on('exit', () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* noop */ } });
  finish({
    report, t0, reportPath: REPORT, summaryPath: SUMMARY,
    headline: `host ${v('@animalabs/connectome-host')} · af ${v('@animalabs/agent-framework')} · cm ${v('@animalabs/context-manager')} · membrane ${v('@animalabs/membrane')} · chronicle ${v('@animalabs/chronicle')} · mcpl-core ${v('@animalabs/mcpl-core')}`,
    extraLines: extra,
  });
}
