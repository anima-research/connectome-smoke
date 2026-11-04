/**
 * Shared plumbing for the smoke lanes: step/report bookkeeping, shell,
 * IPC client, and the host boot exercise (the part that proves the stack
 * takes a turn, not just that it installs).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The Bun this lane runs against the floor the host it tests declares
 * (`engines.bun` in its package.json, which the host also warns about at
 * boot): a line saying so, or an error: below the floor, naming both
 * versions; for a floor or a Bun version it can't read, naming that. The
 * host declares its floor as `>=X.Y.Z`, as its own bun-floor check reads it,
 * and a prerelease sorts below its release. A floor in another form fails
 * rather than passes, since passing would leave the lane's Bun unchecked.
 */
export function bunMeetsHostFloor(hostPackageJson, bun) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(hostPackageJson, 'utf-8'));
  } catch (error) {
    throw new Error(`the host's package.json at ${hostPackageJson} can't be read as JSON: ${error?.message ?? error}`);
  }
  const declared = manifest.engines?.bun;
  if (declared === undefined) return `the host declares no Bun floor; Bun ${bun}`;
  const floor = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(String(declared).trim());
  if (!floor) {
    throw new Error(`the host declares engines.bun ${JSON.stringify(declared)}, which this check reads only as >=X.Y.Z, ` +
      'as the host\'s own floor check does: read the new form in bunMeetsHostFloor, in lib/common.mjs');
  }
  const least = `${floor[1]}.${floor[2]}.${floor[3]}`;
  const version = String(bun ?? '').trim();
  const have = /^(\d+)\.(\d+)\.(\d+)(-[^+\s]+)?(\+\S*)?$/.exec(version);
  if (!have) throw new Error(`bun -v gave ${JSON.stringify(bun)}, which isn't a version`);
  const order = [1, 2, 3].map((i) => Number(have[i]) - Number(floor[i])).find((d) => d !== 0) ?? (have[4] ? -1 : 0);
  if (order < 0) {
    throw new Error(`this lane runs Bun ${version}, below the host's floor of ${least}. The lanes run the first bun on PATH: ` +
      `in CI, .github/workflows/smoke.yml's setup-bun steps set it; run locally, put a Bun at or above ${least} first ` +
      `on PATH and run the lane again, in a fresh --workdir if you gave one. (engines.bun in ${hostPackageJson})`);
  }
  return `Bun ${version} meets the host's ${declared}`;
}
export async function waitFor(check, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { const v = check(); if (v) return v; await sleep(50); }
  throw new Error(`timeout after ${timeoutMs}ms waiting for: ${label}`);
}
const indent = (s) => s.split('\n').map((l) => '    ' + l).join('\n');

/** Report + step runner. Every step's outcome and duration lands in the JSON report. */
export function makeReport(lane, extra = {}) {
  const t0 = Date.now();
  const report = {
    lane, startedAt: new Date().toISOString(), node: process.version,
    bun: (spawnSync('bun', ['-v'], { encoding: 'utf-8' }).stdout || '').trim() || null,
    platform: `${process.platform}-${process.arch}`, steps: [], pass: null, ...extra,
  };
  const log = (m) => console.log(`[smoke:${lane} +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  function step(name, fn) {
    const s = { name, ok: false, ms: 0, detail: '' };
    const st = Date.now();
    return Promise.resolve().then(fn)
      .then((detail) => { s.ok = true; s.detail = typeof detail === 'string' ? detail : ''; })
      .catch((err) => { s.ok = false; s.detail = String(err?.stack || err).slice(0, 6000); })
      .then(() => { s.ms = Date.now() - st; report.steps.push(s); log(`${s.ok ? 'PASS' : 'FAIL'} ${name} (${s.ms}ms)${s.ok ? '' : '\n' + indent(s.detail)}`); return s.ok; });
  }
  return { report, step, log, t0 };
}

export function sh(cmd, cmdArgs, { cwd, env = {}, timeout = 600_000, allowFail = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, encoding: 'utf-8', timeout, maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} (cwd ${cwd}) exited ${r.status}${r.signal ? ' signal ' + r.signal : ''}\n${(r.stdout + '\n' + r.stderr).trim().slice(-3000)}`);
  }
  return r;
}

export function findFile(dir, re) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { const f = findFile(p, re); if (f) return f; }
    else if (re.test(ent.name)) return p;
  }
  return null;
}

// ---------------------------------------------------------------- IPC client
function ipcConnect(path, timeoutMs = 5000) {
  return new Promise((res, rej) => {
    const s = netConnect(path);
    const t = setTimeout(() => { s.destroy(); rej(new Error(`ipc connect timeout ${path}`)); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); res(s); });
    s.once('error', (e) => { clearTimeout(t); rej(e); });
  });
}
function ipcReader(sock) {
  const events = []; let buf = '';
  sock.on('data', (c) => {
    buf += c.toString('utf-8'); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  });
  return events;
}
const send = (sock, obj) => sock.write(JSON.stringify(obj) + '\n');

// ---------------------------------------------------------------- recipe
/**
 * The smoke recipe: mock provider with a deterministic reply carrying the
 * run nonce, web UI on loopback with basic auth, the heartbeat MCPL server
 * over stdio. Every optional module off — this is the stack's spine.
 */
export function makeRecipe({ nonce, webPort, auth, heartbeatEntry, dataDir }) {
  return {
    name: 'Connectome Smoke',
    description: 'stack smoke: mock provider, headless, heartbeat MCPL',
    agent: {
      name: 'smoke',
      provider: 'mock',
      mock: { echoMode: false, defaultResponse: `SMOKE-REPLY ${nonce}` },
      systemPrompt: 'You are the connectome smoke agent.',
    },
    mcpServers: {
      heartbeat: {
        command: 'node',
        args: [heartbeatEntry, '--stdio'],
        env: { HEARTBEAT_CONFIG_FILE: join(dataDir, 'heartbeat-config.json'), HEARTBEAT_REMINDERS_FILE: join(dataDir, 'heartbeat-reminders.json') },
        enabledFeatureSets: ['heartbeat'],
      },
    },
    modules: {
      subagents: false, lessons: false, retrieval: false, wake: false, workspace: false,
      webui: { host: '127.0.0.1', port: webPort, basicAuth: auth },
    },
  };
}

// ---------------------------------------------------------------- boot
function spawnHost({ hostDir, recipePath, dataDir, cwd, sockPath, env = {} }) {
  const out = [];
  const child = spawn('bun', [join(hostDir, 'src', 'index.ts'), recipePath, '--headless', '--socket-path', sockPath], {
    cwd,
    env: { ...process.env, DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', NO_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => out.push(d.toString()));
  child.stderr.on('data', (d) => out.push(d.toString()));
  return { child, out };
}

/**
 * Boot the host headless and drive one full turn:
 *   ipc ready → /help → text → message:added → inference:speech (nonce) →
 *   lifecycle:idle → /healthz 200 with auth, 401 without → llm-calls receipt
 *   → heartbeat tools offered to the model → shutdown exit 0.
 * Leaves <label>.events.jsonl and <label>.host.log in `work` regardless.
 */
export async function exerciseBoot({ hostDir, recipePath, dataDir, work, label, webPort, auth, nonce, bootTimeoutMs = 120_000, env = {} }) {
  mkdirSync(dataDir, { recursive: true });
  // Unix socket paths cap at ~104 bytes on macOS — keep it short and outside
  // the (possibly deep) workdir.
  const sockPath = join(tmpdir(), `cs-${process.pid}-${label}.sock`);
  try { rmSync(sockPath, { force: true }); } catch { /* noop */ }
  const { child, out } = spawnHost({ hostDir, recipePath, dataDir, cwd: work, sockPath, env });
  let sock; let events = [];
  const die = (msg) => { const tail = out.join('').split('\n').slice(-40).join('\n'); throw new Error(`${msg}\n--- host output tail ---\n${tail}`); };
  try {
    await waitFor(() => child.exitCode !== null || existsSync(sockPath), bootTimeoutMs, `${label}: ipc socket`);
    if (child.exitCode !== null) die(`host exited ${child.exitCode} before opening ipc`);
    for (let attempt = 0; ; attempt++) {
      try { sock = await ipcConnect(sockPath); break; }
      catch (e) { if (attempt >= 20 || child.exitCode !== null) die(`ipc connect failed: ${e.message}`); await sleep(250); }
    }
    events = ipcReader(sock);
    await waitFor(() => events.some((e) => e.type === 'lifecycle' && e.phase === 'ready'), 30_000, `${label}: lifecycle:ready`);

    send(sock, { type: 'command', command: '/help' });
    await waitFor(() => events.filter((e) => e.type === 'command-output').length >= 3, 10_000, `${label}: /help output`);

    const mcplBad = events.filter((e) => /^mcpl:server-(connect-failed|error)$/.test(e.type));
    if (mcplBad.length) die(`MCPL server trouble: ${JSON.stringify(mcplBad.slice(0, 3)).slice(0, 1500)}`);

    const text = `smoke ${label} ${nonce} ${Date.now()}`;
    send(sock, { type: 'text', content: text });
    await waitFor(() => events.some((e) => e.type === 'message:added' && e.source === 'external-message'), 30_000, `${label}: message:added (external-message)`);
    const speech = await waitFor(() => events.find((e) => e.type === 'inference:speech' && e.agentName === 'smoke' && String(e.content).includes(`SMOKE-REPLY ${nonce}`)), 60_000, `${label}: inference:speech carrying the recipe nonce`);
    await waitFor(() => events.some((e) => e.type === 'lifecycle' && e.phase === 'idle'), 30_000, `${label}: lifecycle:idle`);
    const failed = events.filter((e) => /^inference:(failed|exhausted)$/.test(e.type));
    if (failed.length) die(`inference failures: ${JSON.stringify(failed[0]).slice(0, 1500)}`);

    const authz = { authorization: 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64') };
    const res = await fetch(`http://127.0.0.1:${webPort}/healthz`, { headers: authz });
    if (res.status !== 200) die(`/healthz → ${res.status}`);
    const health = await res.json();
    const unauth = await fetch(`http://127.0.0.1:${webPort}/healthz`);
    if (unauth.status === 200) die('/healthz served WITHOUT auth');

    const llmLog = findFile(dataDir, /llm-calls.*\.jsonl$/);
    if (!llmLog) die('no llm-calls*.jsonl receipt written');
    const calls = readFileSync(llmLog, 'utf-8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const offered = new Set(calls.flatMap((c) => c?.requestSummary?.toolNames ?? []));
    const hbTools = [...offered].filter((t) => /heartbeat/.test(t));
    if (!hbTools.length) die(`heartbeat MCPL tools never offered to the model (receipt toolNames: ${[...offered].slice(0, 12).join(', ')})`);

    send(sock, { type: 'shutdown' });
    const code = await new Promise((r) => { if (child.exitCode !== null) r(child.exitCode); else { child.once('exit', r); setTimeout(() => r('timeout'), 20_000); } });
    if (code !== 0) die(`shutdown exit code ${code}`);
    return { speech: String(speech.content).slice(0, 120), healthKeys: Object.keys(health).slice(0, 12), events: events.length, hbTools };
  } finally {
    try { sock?.destroy(); } catch { /* noop */ }
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* noop */ } }
    try { rmSync(sockPath, { force: true }); } catch { /* noop */ }
    try { writeFileSync(join(work, `${label}.events.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n'); } catch { /* noop */ }
    try { writeFileSync(join(work, `${label}.host.log`), out.join('')); } catch { /* noop */ }
  }
}

/** Two boots on one data dir: fresh, then a store reload with a second turn. */
export async function bootTwice({ step, hostDir, heartbeatEntry, work, dataDir, label = 'boot' }) {
  const webPort = 20000 + Math.floor(Math.random() * 20000);
  const auth = { username: 'smoke', password: `pw-${Math.random().toString(36).slice(2)}` };
  const nonce = Math.random().toString(36).slice(2, 10);
  mkdirSync(dataDir, { recursive: true });
  const recipePath = join(work, `${label}-recipe.json`);
  writeFileSync(recipePath, JSON.stringify(makeRecipe({ nonce, webPort, auth, heartbeatEntry, dataDir }), null, 2));
  const ok1 = await step(`${label} #1: ready → /help → turn → idle → /healthz → receipt → mcpl tools → shutdown`, async () => {
    const r = await exerciseBoot({ hostDir, recipePath, dataDir, work, label: `${label}1`, webPort, auth, nonce });
    return `speech="${r.speech}" mcpl-tools=[${r.hbTools.join(',')}] health=[${r.healthKeys.join(',')}] events=${r.events}`;
  });
  if (!ok1) return false;
  return step(`${label} #2: reload store → second turn → shutdown`, async () => {
    const r = await exerciseBoot({ hostDir, recipePath, dataDir, work, label: `${label}2`, webPort, auth, nonce });
    return `speech="${r.speech}" events=${r.events}`;
  });
}

/** Write report.json + summary.md and exit with the verdict. */
export function finish({ report, t0, reportPath, summaryPath, headline, extraLines = [] }) {
  report.finishedAt = new Date().toISOString();
  report.pass = report.steps.length > 0 && report.steps.every((s) => s.ok) && !report.fatal;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const lines = [
    `**connectome-smoke · ${report.lane}** — ${report.pass ? '✅ PASS' : '❌ FAIL'} (${((Date.now() - t0) / 1000).toFixed(0)}s, ${report.platform}, node ${report.node}, bun ${report.bun})`,
    headline,
    ...extraLines,
  ];
  for (const s of report.steps) lines.push(`${s.ok ? '✓' : '✗'} ${s.name}${s.ok ? '' : ' — ' + s.detail.split('\n')[0].slice(0, 300)}`);
  if (report.fatal) lines.push(`fatal: ${report.fatal.split('\n')[0]}`);
  writeFileSync(summaryPath, lines.join('\n') + '\n');
  console.log(`[smoke:${report.lane}] report → ${reportPath}`);
  console.log(`[smoke:${report.lane}] RESULT: ${report.pass ? 'PASS' : 'FAIL'}`);
  process.exit(report.pass ? 0 : 1);
}

export function parseArgs(argv) {
  const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
  const flag = (name) => argv.includes(`--${name}`);
  return { opt, flag };
}
