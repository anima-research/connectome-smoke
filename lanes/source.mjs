#!/usr/bin/env node
/**
 * connectome-smoke — "source" lane: the repos' `main` branches, laid out the
 * way fleet boxes deploy them (siblings, `file:` links resolve to checkouts).
 *
 *   1. Clone every stack repo at main into <work>/src/<name>.
 *   2. Per repo, what its own CI would do: npm ci (strict lockfile) → build →
 *      typecheck → test. Order respects `file:` siblings (voice-kit before
 *      discord-mcpl / portal-relay; portal-protocol before portal-relay).
 *      This is where "portal-relay depends on ../../voice-kit and nothing
 *      checks it" gets caught — portal has no CI of its own.
 *   3. Compose: host@main + membrane/context-manager/agent-framework@main in
 *      ONE tree (each sibling's nested @animalabs copies removed, a single
 *      <work>/src/node_modules/@animalabs/* symlink set), chronicle from npm
 *      (Rust; prebuilt binaries are the published artifact). Typecheck the
 *      host against the sibling mains, then boot it twice like the
 *      published lane.
 *
 * Exit 0 pass / 1 fail. --report JSON, --summary markdown.
 */
import { mkdtempSync, mkdirSync, existsSync, rmSync, symlinkSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeReport, sh, bootTwice, finish, parseArgs, bunMeetsHostFloor } from '../lib/common.mjs';

const { opt } = parseArgs(process.argv.slice(2));
const WORK = opt('workdir') ? resolve(opt('workdir')) : mkdtempSync(join(tmpdir(), 'connectome-smoke-source-'));
const REPORT = opt('report', join(WORK, 'report.json'));
const SUMMARY = opt('summary', join(WORK, 'summary.md'));
const ORG = opt('org', 'anima-research');
const ONLY = opt('only') ? opt('only').split(',') : null;   // debug: subset of repos
const SRC = join(WORK, 'src');

/**
 * Repos in build order. `dir` = checkout name (what `file:` links expect).
 * `pkgDirs` = sub-packages for monorepos, in build order. `test` false =
 * no test script worth running here (or none). `sibling` = which checkouts
 * a `file:` link needs (documentation; order already satisfies it).
 */
const REPOS = [
  { repo: 'voice-kit',        dir: 'voice-kit' },
  { repo: 'mcpl-core-ts',     dir: 'mcpl-core-ts' },
  { repo: 'membrane',         dir: 'membrane', owner: 'antra-tess' },   // canonical home per the npm repository field
  { repo: 'context-manager',  dir: 'context-manager' },
  { repo: 'agent-framework',  dir: 'agent-framework' },
  { repo: 'connectome-host',  dir: 'connectome-host', install: 'npm install', build: 'npm run build:web:ci', test: 'npm test' },
  { repo: 'mcpl-harness',     dir: 'mcpl-harness', test: false },   // heartbeat-mcpl's reminders harness loads ../mcpl-harness/src/session.ts
  { repo: 'heartbeat-mcpl',   dir: 'heartbeat-mcpl', sibling: ['mcpl-harness'] },
  { repo: 'discord-mcpl',     dir: 'discord-mcpl', sibling: ['voice-kit'] },
  { repo: 'portal',           dir: 'portal', pkgDirs: ['portal-protocol', 'portal-client', 'portal-mcpl', 'portal-relay'], sibling: ['voice-kit'] },
];

const { report, step, log, t0 } = makeReport('source', { workdir: WORK, heads: {}, chronicle: null });

function pkgJson(dir) { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')); }
function hasScript(dir, name) { return !!pkgJson(dir).scripts?.[name]; }
function run(dir, cmdline, timeout = 900_000) {
  const [cmd, ...a] = cmdline.split(' ');
  const r = sh(cmd, a, { cwd: dir, timeout, allowFail: true, env: { CI: '1', FORCE_COLOR: '0' } });
  if (r.status !== 0) {
    const out = (r.stdout + '\n' + r.stderr).trim().split('\n');
    const interesting = out.filter((l) => /error|fail|✗|not ok|Error:/i.test(l)).slice(-30);
    throw new Error(`\`${cmdline}\` in ${dir.replace(WORK, '.')} exited ${r.status}${r.signal ? ' ' + r.signal : ''}\n${(interesting.length ? interesting : out.slice(-30)).join('\n')}`);
  }
  return r;
}
function ciOrInstall(dir, override) {
  if (override) return run(dir, override);
  return run(dir, existsSync(join(dir, 'package-lock.json')) ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund');
}
function testSummary(r) {
  const s = r.stdout + r.stderr;
  const m = s.match(/# pass (\d+)[\s\S]*?# fail (\d+)/) || s.match(/(\d+) pass[\s\S]*?(\d+) fail/) || s.match(/Tests\s+(\d+) passed/);
  return m ? `${m[1]} pass${m[2] !== undefined ? `, ${m[2]} fail` : ''}` : 'ok';
}

(async () => {
  mkdirSync(SRC, { recursive: true });
  log(`workdir ${WORK}`);
  if (!report.bun) { log('FATAL: bun not found on PATH'); process.exit(2); }

  // -- 1. clone --
  const cloneOk = await step('clone main of every repo', () => {
    const lines = [];
    for (const r of REPOS) {
      if (ONLY && !ONLY.includes(r.repo)) continue;
      const dst = join(SRC, r.dir);
      sh('git', ['clone', '--quiet', '--depth', '1', '--branch', 'main', `https://github.com/${r.owner ?? ORG}/${r.repo}.git`, dst], { cwd: SRC, timeout: 300_000 });
      const head = sh('git', ['log', '-1', '--format=%h %cs %s'], { cwd: dst }).stdout.trim();
      report.heads[r.repo] = head;
      lines.push(`${r.repo}: ${head.slice(0, 80)}`);
    }
    return lines.join('\n    ');
  });
  if (!cloneOk) return done();

  // Whenever this run tests the host: a host it cloned without a package.json
  // fails the step, as the published lane's does.
  if (!ONLY || ONLY.includes('connectome-host')) {
    await step("bun meets the host's floor", () => {
      const said = bunMeetsHostFloor(join(SRC, 'connectome-host', 'package.json'), report.bun);
      log(said);
      return said;
    });
  }

  // -- 2. per-repo, as its own CI would --
  for (const r of REPOS) {
    if (ONLY && !ONLY.includes(r.repo)) continue;
    const dirs = (r.pkgDirs ?? ['.']).map((d) => join(SRC, r.dir, d));
    for (const dir of dirs) {
      const label = dir.replace(SRC + '/', '');
      const ok = await step(`${label}: install`, () => { ciOrInstall(dir, r.install); return 'ok'; });
      if (!ok) continue;
      if (r.build !== false && (r.build || hasScript(dir, 'build'))) {
        await step(`${label}: build`, () => { run(dir, r.build ?? 'npm run build'); return 'ok'; });
      }
      if (hasScript(dir, 'typecheck')) {
        await step(`${label}: typecheck`, () => { run(dir, 'npm run typecheck'); return 'clean'; });
      }
      if (r.test !== false && (r.test || hasScript(dir, 'test'))) {
        await step(`${label}: test`, () => testSummary(run(dir, r.test ?? 'npm test', 1_200_000)));
      }
    }
  }
  if (ONLY) return done();

  // -- 3. compose one tree --
  const hostDir = join(SRC, 'connectome-host');
  const composed = await step('compose: host@main + membrane/cm/af@main in one tree (chronicle from npm)', () => {
    // Single resolution root above the siblings. Node/bun resolve from the
    // REAL path of a symlinked package, so a sibling importing
    // @animalabs/membrane walks SRC/<sibling>/node_modules → SRC/node_modules.
    const root = join(SRC, 'node_modules', '@animalabs');
    mkdirSync(root, { recursive: true });
    const links = { membrane: 'membrane', 'context-manager': 'context-manager', 'agent-framework': 'agent-framework', 'mcpl-core': 'mcpl-core-ts', 'heartbeat-mcpl': 'heartbeat-mcpl' };
    for (const [name, dir] of Object.entries(links)) {
      const t = join(root, name); try { rmSync(t, { recursive: true, force: true }); } catch { /* noop */ }
      symlinkSync(join(SRC, dir), t);
    }
    // chronicle: take the published copy the host's own install resolved.
    const chr = join(hostDir, 'node_modules', '@animalabs', 'chronicle');
    if (!existsSync(chr)) throw new Error('host install has no @animalabs/chronicle');
    report.chronicle = pkgJson(chr).version;
    const chrLink = join(root, 'chronicle'); try { rmSync(chrLink, { recursive: true, force: true }); } catch { /* noop */ }
    symlinkSync(chr, chrLink);
    // Remove every nested @animalabs copy so there is exactly one of each.
    const removed = [];
    for (const dir of ['membrane', 'context-manager', 'agent-framework', 'mcpl-core-ts', 'heartbeat-mcpl', 'connectome-host']) {
      const nm = join(SRC, dir, 'node_modules', '@animalabs');
      if (!existsSync(nm)) continue;
      for (const d of readdirSync(nm)) {
        if (dir === 'connectome-host' && d === 'chronicle') continue;   // keep: it's what root links to
        rmSync(join(nm, d), { recursive: true, force: true }); removed.push(`${dir}/${d}`);
      }
    }
    // The host itself must see the siblings: link them into ITS node_modules.
    const hostNm = join(hostDir, 'node_modules', '@animalabs'); mkdirSync(hostNm, { recursive: true });
    for (const name of Object.keys(links)) {
      const t = join(hostNm, name); try { rmSync(t, { recursive: true, force: true }); } catch { /* noop */ }
      symlinkSync(join(root, name), t);
    }
    return `removed nested: ${removed.join(', ') || 'none'}; chronicle@${report.chronicle} (npm)`;
  });
  if (!composed) return done();

  await step('composed: typecheck host@main against sibling mains', () => {
    const r = sh('npx', ['tsc', '--noEmit', '-p', join(hostDir, 'tsconfig.json')], { cwd: hostDir, allowFail: true, timeout: 600_000 });
    if (r.status !== 0) throw new Error((r.stdout + r.stderr).trim().split('\n').filter((l) => /error TS/.test(l)).slice(0, 25).join('\n') || `tsc exit ${r.status}`);
    return 'clean';
  });

  await bootTwice({
    step, hostDir, work: WORK, dataDir: join(WORK, 'data'), label: 'composed boot',
    heartbeatEntry: join(SRC, 'heartbeat-mcpl', 'dist', 'src', 'index.js'),
  });
  done();
})().catch((e) => { log(`FATAL ${e?.stack || e}`); report.fatal = String(e?.stack || e); done(); });

function done() {
  const h = (r) => (report.heads[r] ?? '—').split(' ')[0];
  finish({
    report, t0, reportPath: REPORT, summaryPath: SUMMARY,
    headline: `mains: host ${h('connectome-host')} · af ${h('agent-framework')} · cm ${h('context-manager')} · membrane ${h('membrane')} · mcpl-core ${h('mcpl-core-ts')} · discord-mcpl ${h('discord-mcpl')} · portal ${h('portal')} · voice-kit ${h('voice-kit')} · chronicle@${report.chronicle ?? '?'} (npm)`,
  });
}
