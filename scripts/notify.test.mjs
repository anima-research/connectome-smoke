// What notify.mjs posts for a run's evidence: without a webhook it prints
// the post, and with one, a webhook this process serves answers it. Run
// with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const NOTIFY = fileURLToPath(new URL('./notify.mjs', import.meta.url));
const RUNTIMES = JSON.stringify([
  { name: 'floor', node: '22.12.0', bun: '1.4.3' },
  { name: 'middle', node: '24', bun: 'latest' },
  { name: 'newest', node: 'latest', bun: 'latest' },
]);
const ALL = ['published', 'latest', 'source'];
const LEGS = ['floor', 'middle', 'newest'];
const CUT = "… cut at Discord's 2,000-character limit; each summary is on the run's page";

/** A lane's summary as lib/common.mjs's finish() writes it: the verdict on
 *  its first line, the versions on its second, then a line per step, with
 *  `fails` failing steps whose detail is `detail`, and any `extra` lines. */
function summary(lane, verdict, { fails = 1, detail = 'boot failed', extra = [] } = {}) {
  return `**connectome-smoke · ${lane}** — ${verdict === 'pass' ? '✅ PASS' : '❌ FAIL'} (30s, linux-x64, node v22.12.0, bun 1.4.3)\n` +
    'host 0.10.2 · af 0.22.1 · cm 0.14.1 · membrane 0.5.87 · chronicle 0.4.0 · mcpl-core 0.2.2\n' +
    '✓ npm install\n' +
    (verdict === 'pass' ? '' : Array.from({ length: fails }, (_, i) => `✗ step ${i + 1} — ${detail}\n`).join('')) +
    extra.map((l) => `${l}\n`).join('');
}

/** A lane's summary with the lines a real run posts, as main's run
 *  39193842112 wrote them on Oct 19: the versions, lag, mains and failing
 *  lines, at their real lengths, here on `node` and Bun 1.4.3. Its passing
 *  steps but one are left out, since the post never shows them. */
function realSummary(lane, node, fail = false) {
  const lines = {
    published: [
      'host 0.10.2 · af 0.22.3 · cm 0.14.1 · membrane 0.5.87 · chronicle 0.4.0 · mcpl-core 0.2.2',
      'lag vs latest: membrane 0.5.87→0.6.0, context-manager 0.14.1→0.15.0, mcpl-core 0.2.2→0.3.0',
    ],
    latest: ['host 0.10.2 · af 0.22.3 · cm 0.15.0 · membrane 0.6.0 · chronicle 0.4.0 · mcpl-core 0.3.0'],
    source: [
      'mains: host d4c0b67 · af 67aabff · cm e6b12e5 · membrane 1c33026 · mcpl-core e17f773 · discord-mcpl 424b7ec · portal 393e101 · voice-kit 2f20400 · chronicle@0.4.0 (npm)',
      fail ? '✗ connectome-host: test — Error: `npm test` in ./src/connectome-host exited 1' : '✓ connectome-host: test',
    ],
  }[lane];
  return `**connectome-smoke · ${lane}** — ${fail ? '❌ FAIL' : '✅ PASS'} (${lane === 'source' ? 724 : 24}s, linux-x64, node ${node}, bun 1.4.3)\n` +
    `${lines.join('\n')}\n✓ boot #2: reload store → second turn → shutdown\n`;
}

/** Run notify.mjs on evidence as the workflow downloads it: one artifact
 *  directory per run, holding summary-<lane>-<runtime>.md. `runs` maps each
 *  run to its summary; a run left out wrote nothing. `env` overrides what
 *  the workflow sets, and an undefined value leaves that variable unset.
 *  With `noEvidence`, the evidence folder doesn't exist, and `prepare` can
 *  change it before the run. Returns the exit status, what it would post,
 *  its stderr, and what it wrote to $GITHUB_OUTPUT. */
function run(runs, env = {}, opts = {}) {
  const { tmp, dir, vars, result } = setUp(runs, env, opts);
  try {
    const r = spawnSync(process.execPath, [NOTIFY, dir], { encoding: 'utf-8', env: vars });
    return result(r.status, r.stdout, r.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The evidence folder, environment and result reader run() and runAsync()
 *  share. */
function setUp(runs, env, { noEvidence = false, prepare = () => {} } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'notify-test-'));
  const dir = join(tmp, 'evidence');
  const output = join(tmp, 'github-output');
  if (!noEvidence) mkdirSync(dir);
  for (const [r, text] of Object.entries(runs)) {
    mkdirSync(join(dir, `${r}-evidence`));
    writeFileSync(join(dir, `${r}-evidence`, `summary-${r}.md`), text);
  }
  prepare(dir);
  const vars = {
    PATH: process.env.PATH, LANES: ALL.join(','), FULL: 'true', RUNTIMES,
    RESULT_PUBLISHED: 'success', RESULT_SOURCE: 'success', GITHUB_OUTPUT: output, ...env,
  };
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete vars[k];
  const result = (status, stdout, stderr) => ({
    status,
    // What it would post, or posted: the lines after its first, without
    // console.log's closing newline.
    out: stdout.split('\n').slice(1).join('\n').replace(/\n$/, ''),
    // Its first line: "posted:", or what it says before what it posted.
    head: stdout.split('\n')[0],
    stderr,
    output: existsSync(output) ? readFileSync(output, 'utf-8') : '',
  });
  return { tmp, dir, vars, result };
}

/** run(), without blocking this process, so a webhook it serves can answer.
 *  A run still going after 30 s is stopped, and its status is null. */
async function runAsync(runs, env = {}, opts = {}) {
  const { tmp, dir, vars, result } = setUp(runs, env, opts);
  try {
    const child = spawn(process.execPath, [NOTIFY, dir], { env: vars });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8').on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf-8').on('data', (c) => { stderr += c; });
    const stop = setTimeout(() => child.kill(), 30_000);
    const [status] = await once(child, 'close');
    clearTimeout(stop);
    return result(status, stdout, stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Post `runs` (every run passing, unless given) to a webhook this process
 *  serves, which gives the posts `answers` in turn: a status, or { status,
 *  body }. With `answers` null, the webhook is a port nothing listens on.
 *  Returns runAsync()'s result, and the posts the webhook got, each with
 *  when it came. */
async function deliver(answers, env = {}, runs = every(), opts = {}) {
  const posts = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf-8').on('data', (c) => { body += c; }).on('end', () => {
      posts.push({ at: performance.now(), body });
      const answer = answers[posts.length - 1] ?? 500;
      const { status, body: text = '' } = typeof answer === 'number' ? { status: answer } : answer;
      res.writeHead(status, { 'content-type': 'application/json' }).end(text);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  if (answers === null) {
    server.close();
    await once(server, 'close');
  }
  try {
    return { ...(await runAsync(runs, { DISCORD_WEBHOOK: `http://127.0.0.1:${port}/`, ...env }, opts)), posts };
  } finally {
    if (answers !== null) server.close();
  }
}

/** What notify.mjs would post, where it exits 0. */
function post(runs, env = {}, opts = {}) {
  const r = run(runs, env, opts);
  assert.equal(r.status, 0, r.stderr);
  return r.out;
}

/** Every run of `lanes` on every runtime, passing. */
const every = (lanes = ALL) => Object.fromEntries(lanes.flatMap((l) => LEGS.map((r) => [`${l}-${r}`, summary(l, 'pass')])));

test('every requested run passing posts "all lanes pass", whole, one block per lane', () => {
  const out = post(every());
  assert.match(out, /^🟢 \*\*connectome-smoke\*\* — all lanes pass/);
  assert.doesNotMatch(out, /✗/);
  const lines = out.split('\n');
  assert.equal(lines.length, 1 + 3 * (1 + 3 + 1), 'the head, then each lane\'s name, a line per runtime, and the versions line its runs share');
  assert.deepEqual(lines.filter((l) => /^\*\*\w+\*\*$/.test(l)), ['**latest**', '**published**', '**source**']);
  assert.equal(lines.filter((l) => /^(floor|middle|newest): ✅ PASS \(30s, linux-x64, node v22\.12\.0, bun 1\.4\.3\)$/.test(l)).length, 9, 'every run\'s verdict');
  assert.match(lines.at(-1), /^host 0\.10\.2 · .* mcpl-core 0\.2\.2$/, 'the last lane\'s versions line is kept');
  assert.ok(!out.includes(CUT), 'a post under the limit has no cut line');
});

test('nine runs with summaries the size real runs write fit in one post, passing or with a failing lane', () => {
  const node = { floor: 'v22.12.0', middle: 'v24.11.1', newest: 'v25.1.0' };
  const runs = (failSource) => Object.fromEntries(ALL.flatMap((l) => LEGS.map((r) => [`${l}-${r}`, realSummary(l, node[r], failSource && l === 'source')])));
  const green = post(runs(false));
  assert.ok(!green.includes(CUT), `the passing post is whole, at ${green.length} characters`);
  assert.equal(green.split('\n').filter((l) => /^(floor|middle|newest): ✅ PASS \(\d+s, linux-x64, node v2\d\.\d+\.\d+, bun 1\.4\.3\)$/.test(l)).length, 9, 'with every run\'s verdict');
  const red = post(runs(true));
  const lines = red.split('\n');
  assert.ok(!red.includes(CUT), `the failing post is whole, at ${red.length} characters`);
  assert.equal(lines[1], '**source**', 'the failing lane comes first');
  assert.equal(lines.filter((l) => /^✗ connectome-host: test — Error: `npm test` in \.\/src\/connectome-host exited 1$/.test(l)).length, 1, 'the failing line all three source runs share is posted once');
  assert.equal(lines.filter((l) => /^(floor|middle|newest): ❌ FAIL \(724s/.test(l)).length, 3, 'beside each source run\'s verdict');
});

test('one failure on every runtime, its line naming the lane\'s work directory, is posted once a lane, and every failing lane fits', () => {
  // As the workflow names them, a lane's work directory is the same on
  // every runtime, so a failing line that names it is too. One bad host
  // publish fails npm install on the published and latest lanes' six runs,
  // beside the source lane's own failure, as in main's run 39193842112.
  const node = { floor: 'v22.12.0', middle: 'v24.11.1', newest: 'v25.1.0' };
  const install = (lane) => `✗ npm install (${lane}) — npm install --no-audit --no-fund --loglevel=error @animalabs/connectome-host@latest @animalabs/heartbeat-mcpl@latest @animalabs/discord-mcpl@latest typescript@^5 @types/bun @types/node@^22 (cwd /home/runner/work/_temp/smoke-${lane}) exited 1`;
  const failed = (lane, r) => realSummary(lane, node[r]).replace('✅ PASS', '❌ FAIL').replace(/\n✓ boot #2[^\n]*\n$/, `\n${install(lane)}\n`);
  const runs = Object.fromEntries(ALL.flatMap((l) => LEGS.map((r) => [`${l}-${r}`, l === 'source' ? realSummary(l, node[r], true) : failed(l, r)])));
  const out = post(runs);
  const lines = out.split('\n');
  assert.ok(!out.includes(CUT), `the post is whole, at ${out.length} characters`);
  for (const lane of ['published', 'latest']) assert.equal(lines.filter((l) => l === install(lane)).length, 1, `${lane}'s install line, which all three of its runs have, is posted once`);
  assert.ok(lines.includes('**source**'), 'the source lane\'s block is there');
  assert.equal(lines.filter((l) => l.startsWith('✗ connectome-host: test — ')).length, 1, 'with its failure, once');
});

test('the workflow names each run\'s work directory for its lane alone, so its failing lines read the same on every runtime', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/smoke.yml', import.meta.url)), 'utf-8');
  const dirs = [...workflow.matchAll(/--workdir "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(dirs, ['$RUNNER_TEMP/smoke-${{ matrix.lane }}', '$RUNNER_TEMP/smoke-source']);
});

test('each lane job uploads its logs from the work directory it gives its lane', () => {
  // Its uploads skip a path that matches nothing, so one naming another
  // directory would drop the lane's logs without a word.
  const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/smoke.yml', import.meta.url)), 'utf-8');
  for (const job of ['published', 'source']) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    const rest = workflow.slice(start + 1);
    const end = rest.search(/\n  [a-z-]+:\n/);
    const block = end === -1 ? rest : rest.slice(0, end);
    const workdir = block.match(/--workdir "\$RUNNER_TEMP\/([^"]+)"/)?.[1];
    // A directory runs to the next slash, an expression such as
    // ${{ matrix.lane }} whole.
    const uploaded = [...block.matchAll(/\$\{\{ runner\.temp \}\}\/((?:\$\{\{[^}]*\}\}|[^/\s$])+)\//g)].map((m) => m[1]);
    assert.ok(workdir && uploaded.length > 0, `${job} gives its lane a work directory and uploads from the runner's temp`);
    assert.deepEqual([...new Set(uploaded)], [workdir], `${job}'s uploads read its lane's work directory`);
  }
});

test('lines two runtimes give that differ only past the 300-character cap are posted once', async () => {
  const long = 'e'.repeat(320);
  const runs = {
    ...every(),
    'source-floor': summary('source', 'fail', { detail: `${long} at /tmp/cs-1001.sock` }),
    'source-middle': summary('source', 'fail', { detail: `${long} at /tmp/cs-2002.sock` }),
  };
  const r = await runAsync(runs);
  const failing = r.out.split('\n').filter((l) => l.includes('✗ step 1 — e'));
  assert.equal(failing.length, 1, `one line for both, not one per runtime: ${failing.join(' | ')}`);
  assert.ok(failing[0].startsWith('floor, middle: ✗ step 1 — e'), 'marked with both runtimes');
});

test('a line only some of a lane\'s runs have is marked with their runtimes, and one all of them have isn\'t', () => {
  const runs = every();
  runs['published-floor'] = summary('published', 'fail');
  runs['published-newest'] = summary('published', 'fail', { extra: ['fatal: newest only'] });
  const lines = post(runs).split('\n');
  assert.ok(lines.includes('floor, newest: ✗ step 1 — boot failed'), 'two of three runs have it');
  assert.ok(lines.includes('newest: fatal: newest only'), 'one run has it');
  assert.equal(lines.filter((l) => /^host 0\.10\.2 · /.test(l)).length, 3, 'each lane\'s shared versions line comes once, unmarked');
});

test('a run that wrote no summary is named, though its lane\'s other runs passed', () => {
  const runs = every();
  delete runs['published-middle'];
  const out = post(runs);
  assert.match(out, /^🔴 \*\*connectome-smoke\*\* — FAILURES/);
  assert.match(out, /✗ published on middle \(Node 24, Bun latest\): no summary reached the report/);
});

test('a run that wrote no summary is named beside a sibling that failed', () => {
  const runs = every();
  runs['published-floor'] = summary('published', 'fail');
  delete runs['published-newest'];
  const out = post(runs);
  assert.match(out, /✗ published on newest \(Node latest, Bun latest\): no summary reached the report/);
  assert.match(out, /❌ FAIL/);
});

test('a run of some lanes expects only those, and says which passed', () => {
  assert.match(post(every(['source']), { LANES: 'source', FULL: 'false' }), /^🟢 \*\*connectome-smoke\*\* — source passes/);
  assert.match(post(every(['published', 'latest']), { LANES: 'published,latest', FULL: 'false' }), /^🟢 \*\*connectome-smoke\*\* — published, latest pass/);
});

test('lanes written with spaces are the same lanes', () => {
  const out = post(every(), { LANES: 'published, latest , source' });
  assert.match(out, /^🟢 \*\*connectome-smoke\*\* — all lanes pass/);
});

test('a cut drops passing lanes before the missing run and the failing lane, at a line boundary, and says so', () => {
  // A run with five long failure lines its lane's other runs don't have,
  // and a run that wrote nothing: about 2,300 characters before the cut.
  const runs = every();
  runs['source-newest'] = summary('source', 'fail', { fails: 5, detail: 'x'.repeat(250) });
  delete runs['latest-floor'];
  const out = post(runs);
  const lines = out.split('\n');
  assert.ok(out.length <= 2000, `the post is ${out.length} characters`);
  assert.equal(lines.at(-1), CUT);
  assert.match(lines[1], /^✗ latest on floor .*no summary reached the report/, 'the missing run comes first');
  assert.equal(lines[2], '**source**', 'then the failing lane');
  assert.equal(lines.filter((l) => /^newest: ✗ step \d — x+$/.test(l)).length, 5, 'with all five of its failure lines, each marked as the newest run\'s');
  const lastFailure = lines.findLastIndex((l) => /^newest: ✗ step/.test(l));
  const passingLanes = lines.flatMap((l, i) => (l === '**latest**' || l === '**published**' ? [i] : []));
  assert.ok(passingLanes.length > 0 && passingLanes.every((i) => i > lastFailure), 'passing lanes come after it');
  assert.ok(lines.filter((l) => /^(floor|middle|newest): ✅ PASS/.test(l)).length < 5, 'and are what\'s cut');
  assert.match(lines.at(-2), /^(\*\*(latest|published)\*\*|(floor|middle|newest): ✅ PASS \(30s, linux-x64, node v22\.12\.0, bun 1\.4\.3\)|host 0\.10\.2 · .* mcpl-core 0\.2\.2)$/, 'the cut falls between whole lines');
});

test('when failing lanes fill most of the post, every failure is kept and the passing lane is what\'s cut', () => {
  // Every run of two lanes fails with a long line of its own: those lanes
  // fit, and the passing lane after them is what's cut.
  const runs = every();
  for (const l of ['latest', 'published']) for (const r of LEGS) runs[`${l}-${r}`] = summary(l, 'fail', { detail: `${r} ${'z'.repeat(180)}` });
  const out = post(runs);
  const lines = out.split('\n');
  assert.ok(out.length <= 2000, `the post is ${out.length} characters`);
  assert.equal(lines.at(-1), CUT);
  assert.equal(lines.filter((l) => /^(floor|middle|newest): ✗ step 1 — (floor|middle|newest) z+$/.test(l)).length, 6, 'all six failures are kept');
  assert.ok(lines.filter((l) => /^(floor|middle|newest): ✅ PASS/.test(l)).length < 3, 'the passing lane was cut');
});

test('failing lanes past the limit are cut only after every passing lane', () => {
  // Every run of two lanes fails with three long lines of its own, far past
  // the limit together, and the third lane passes.
  const runs = every();
  for (const l of ['published', 'latest']) for (const r of LEGS) runs[`${l}-${r}`] = summary(l, 'fail', { fails: 3, detail: `${r} ${'y'.repeat(250)}` });
  const out = post(runs);
  const lines = out.split('\n');
  assert.ok(out.length <= 2000, `the post is ${out.length} characters`);
  assert.equal(lines.at(-1), CUT);
  assert.ok(!lines.includes('**source**'), 'the passing lane is cut');
  assert.doesNotMatch(out, /✅ PASS/, 'and no passing run is left');
  assert.ok(lines.filter((l) => /^(floor|middle|newest): ✗ step/.test(l)).length < 18, 'failures are cut too');
  // The evidence sorts by run, so latest comes first.
  assert.equal(lines[1], '**latest**');
});

test('a problem line past 300 characters is cut to 300 too', () => {
  const name = 'r'.repeat(400);
  const out = post({}, { LANES: 'source', FULL: 'false', RUNTIMES: JSON.stringify([{ name, node: '22.12.0', bun: '1.4.3' }]) });
  const line = out.split('\n').find((l) => l.startsWith('✗ source on r'));
  assert.equal(line.length, 300);
  assert.ok(line.endsWith('…'), 'the cut line ends in an ellipsis');
});

test('a line past 300 characters is cut to 300, so the failures after it still fit', () => {
  const runs = every();
  runs['latest-floor'] = summary('latest', 'fail', { extra: [`fatal: ${'q'.repeat(2500)}`] });
  runs['source-newest'] = summary('source', 'fail');
  const lines = post(runs).split('\n');
  const fatal = lines.find((l) => l.startsWith('floor: fatal: '));
  assert.equal(fatal.length, 'floor: '.length + 300, 'the summary\'s line is cut to 300, and its runtime marks it outside the cap');
  assert.ok(fatal.endsWith('…'), 'the cut line ends in an ellipsis');
  assert.ok(lines.includes('**source**') && lines.some((l) => /^newest: ❌ FAIL/.test(l)), 'the failing lane after the long line is in the post');
});

test('the head carries the run\'s reason and a link to the run\'s page', () => {
  const out = post(every(), { REASON: 'new published set (newest publish 25m ago)', RUN_URL: 'https://github.com/o/r/actions/runs/1' });
  assert.equal(out.split('\n')[0], '🟢 **connectome-smoke** — all lanes pass · _new published set (newest publish 25m ago)_ · <https://github.com/o/r/actions/runs/1>');
});

test('a post of exactly 2,000 characters is whole, and one more is cut', () => {
  // One failing run, beside two passing ones, whose lane's lag lines set
  // the post's length, each under the 300-character line cap. All three
  // runs have them, so each is posted once, unmarked, and each has a letter
  // of its own, since a lane posts a line once. A lag line of m letters
  // adds m + 5 characters: its newline, "lag " and the letters.
  const runsWith = (ms) => {
    const extra = ms.map((m, i) => `lag ${String.fromCharCode(97 + i).repeat(m)}`);
    return { ...every(), 'source-floor': summary('source', 'fail', { extra }), 'source-middle': summary('source', 'pass', { extra }), 'source-newest': summary('source', 'pass', { extra }) };
  };
  const toAdd = 2000 - post(runsWith([])).length;
  const k = Math.ceil(toAdd / 250);
  const ms = Array.from({ length: k }, (_, i) => Math.floor(toAdd / k) + (i < toAdd % k ? 1 : 0) - 5);
  assert.ok(toAdd > 0 && k <= 26 && ms.every((m) => m > 0 && m + 4 < 300), `lag lines of ${ms} letters`);
  const exact = post(runsWith(ms));
  assert.equal(exact.length, 2000);
  assert.ok(!exact.includes(CUT), 'exactly at the limit, nothing is cut');
  const over = post(runsWith([...ms.slice(0, -1), ms.at(-1) + 1]));
  assert.ok(over.length <= 2000, `the post is ${over.length} characters`);
  assert.equal(over.split('\n').at(-1), CUT);
});

test('a summary\'s lag, nested and fatal lines are kept, and its passing steps aren\'t', () => {
  const runs = every();
  runs['latest-newest'] = summary('latest', 'fail', { extra: ['lag af 0.22.1 < 0.23.0', 'nested membrane 0.5.86 under af', 'fatal: chronicle binding missing', 'a line of host output'] });
  const out = post(runs);
  for (const l of ['lag af 0.22.1 < 0.23.0', 'nested membrane 0.5.86 under af', 'fatal: chronicle binding missing']) {
    assert.ok(out.split('\n').includes(`newest: ${l}`), `"${l}" is in the post, marked as the newest run's`);
  }
  assert.doesNotMatch(out, /✓ npm install|a line of host output/);
});

test('a runtime list that can\'t be read, isn\'t a list, is empty, has an entry without a name, node or bun, or is unset fails the post', () => {
  for (const runtimes of [
    'not json', '{"name": "floor", "node": "22.12.0", "bun": "1.4.3"}', '[]', '[null]', '[1]',
    '[{"node": "22.12.0", "bun": "1.4.3"}]', '[{"name": "", "node": "22.12.0", "bun": "1.4.3"}]',
    '[{"name": "floor", "bun": "1.4.3"}]', '[{"name": "floor", "node": "", "bun": "1.4.3"}]', '[{"name": "floor", "node": "22.12.0"}]',
    undefined,
  ]) {
    const out = post(every(), { RUNTIMES: runtimes });
    assert.match(out, /^🔴 .* FAILURES/, `RUNTIMES=${runtimes}`);
    assert.match(out, /runtime list \(RUNTIMES\) couldn't be read/, `RUNTIMES=${runtimes}`);
  }
});

test('without the requested lanes the post fails', () => {
  for (const lanes of ['', undefined]) {
    const out = post(every(), { LANES: lanes });
    assert.match(out, /^🔴 .* FAILURES/, `LANES=${lanes}`);
    assert.match(out, /✗ the requested lanes \(LANES\) weren't given/, `LANES=${lanes}`);
  }
});

test('an evidence folder that can\'t be read is named', () => {
  const out = post({}, {}, { noEvidence: true });
  assert.match(out, /^🔴 .* FAILURES/);
  assert.match(out, /^✗ the evidence folder .*evidence couldn't be read \(ENOENT\)$/m);
  assert.match(out, /✗ source on newest .*no summary reached the report/);
});

test('an evidence entry that can\'t be read is named, and the rest is still read', () => {
  const out = post(every(), {}, { prepare: (dir) => symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling')) });
  assert.match(out, /^🔴 .* FAILURES/);
  assert.match(out, /^✗ the evidence entry .*dangling couldn't be read \(ENOENT\)$/m);
  assert.doesNotMatch(out, /no summary reached the report/);
});

test('a summary that can\'t be read is named, and its run counts as missing', { skip: process.getuid?.() === 0 && 'root can read a file whatever its mode' }, () => {
  const out = post(every(), {}, { prepare: (dir) => chmodSync(join(dir, 'source-floor-evidence', 'summary-source-floor.md'), 0) });
  assert.match(out, /^✗ the summary .*summary-source-floor\.md couldn't be read \(EACCES\)$/m);
  assert.match(out, /✗ source on floor .*no summary reached the report/);
});

test('an empty summary is named in its lane by its runtime, and its lane\'s lines are marked with the runs that have them', () => {
  // source sorts last, so coming first is the empty run's doing.
  const runs = every();
  runs['source-middle'] = '';
  const out = post(runs);
  assert.match(out, /^🔴 .* FAILURES/);
  const lines = out.split('\n');
  assert.equal(lines[1], '**source**', 'its lane comes first');
  assert.equal(lines[3], 'middle: ✗ its summary is empty');
  assert.match(lines[5], /^floor, newest: host 0\.10\.2 · /, 'the versions line the other two runs share is marked as theirs');
});

test('a run\'s lane runs to the first hyphen in its name, so a runtime\'s name can hold one', () => {
  const RT = JSON.stringify([{ name: 'node-22', node: '22.12.0', bun: '1.4.3' }, { name: 'node-24', node: '24', bun: 'latest' }]);
  const runs = { 'source-node-22': summary('source', 'pass'), 'source-node-24': summary('source', 'fail') };
  const lines = post(runs, { LANES: 'source', FULL: 'false', RUNTIMES: RT }).split('\n');
  assert.equal(lines[1], '**source**');
  assert.match(lines[2], /^node-22: ✅ PASS/);
  assert.match(lines[3], /^node-24: ❌ FAIL/);
  assert.ok(lines.includes('node-24: ✗ step 1 — boot failed'));
  assert.doesNotMatch(lines.join('\n'), /no summary reached the report/, 'both requested runs are found');
});

test('a lane job that didn\'t end in success while every summary passed turns the post red', () => {
  for (const [result, line] of [['failure', /✗ the Published lane job ended 'failure', though every summary it wrote passes/], ['cancelled', /✗ the Published lane job ended 'cancelled'/], [undefined, /✗ the Published lane job's result \(RESULT_PUBLISHED\) wasn't given/]]) {
    const out = post(every(), { RESULT_PUBLISHED: result });
    assert.match(out, /^🔴 .* FAILURES/, `RESULT_PUBLISHED=${result}`);
    assert.match(out, line, `RESULT_PUBLISHED=${result}`);
    assert.doesNotMatch(out, /Source-main lane job/, `RESULT_PUBLISHED=${result}`);
  }
  const out = post(every(), { RESULT_SOURCE: 'failure' });
  assert.match(out, /^🔴 .* FAILURES/);
  assert.match(out, /✗ the Source-main lane job ended 'failure', though every summary it wrote passes/);
  assert.doesNotMatch(out, /Published lane job/);
});

test('a lane job counts only when the run requested one of its lanes', () => {
  const out = post(every(['source']), { LANES: 'source', FULL: 'false', RESULT_PUBLISHED: 'failure' });
  assert.match(out, /^🟢 \*\*connectome-smoke\*\* — source passes/);
});

test('a lane job\'s end isn\'t named when the post already names a missing or failing run', () => {
  const missing = every();
  delete missing['published-middle'];
  const failing = every();
  failing['latest-floor'] = summary('latest', 'fail');
  for (const [what, runs] of [['missing', missing], ['failing', failing]]) {
    const out = post(runs, { RESULT_PUBLISHED: 'failure' });
    assert.match(out, /^🔴 .* FAILURES/, what);
    assert.doesNotMatch(out, /lane job/, what);
  }
});

test('the verdict is read from the summary\'s first line', () => {
  const runs = every();
  runs['source-floor'] = summary('source', 'fail', { detail: 'expected "✅ PASS" in the output' });
  assert.match(post(runs), /^🔴 .* FAILURES/);
});

test('a run of every lane with every requested run\'s summary, passing or failing, is remembered once its post goes out', async () => {
  assert.equal((await deliver([204])).output, 'remember=true\n');
  const failing = every();
  failing['published-floor'] = summary('published', 'fail');
  assert.equal((await deliver([204], {}, failing)).output, 'remember=true\n');
});

test('nothing is remembered for a run of some lanes, a summary missing or empty, or nothing to check against, though its post went out', async () => {
  // A post that went out remembers whatever it reports, so only what was
  // run and what arrived decide here.
  const notRemembered = (r, what) => {
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.equal(r.posts.length, 1, `${what}: the post went out`);
    assert.equal(r.output, '', what);
  };
  notRemembered(await deliver([204], { LANES: 'source', FULL: 'false' }, every(['source'])), 'a run of some lanes');
  notRemembered(await deliver([204], { FULL: undefined }), 'FULL not given');
  const missing = every();
  delete missing['source-middle'];
  notRemembered(await deliver([204], {}, missing), 'a summary missing');
  const empty = every();
  empty['source-middle'] = '';
  notRemembered(await deliver([204], {}, empty), 'a summary empty');
  notRemembered(await deliver([204], { LANES: '' }), 'LANES empty');
  notRemembered(await deliver([204], { RUNTIMES: '[]' }), 'RUNTIMES empty');
  notRemembered(await deliver([204], {}, {}, { noEvidence: true }), 'no evidence folder');
});

test('a lane job that ends cancelled after every summary arrived turns the post red, and the set is still remembered once the post goes out', async () => {
  const r = await deliver([204], { RESULT_PUBLISHED: 'cancelled' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.out, /^🔴 \*\*connectome-smoke\*\* — FAILURES/);
  assert.match(r.out, /^✗ the Published lane job ended 'cancelled', though every summary it wrote passes$/m);
  assert.equal(r.output, 'remember=true\n', 'every run gave a result');
});

test('a local run, with no $GITHUB_OUTPUT, prints what it would post and exits 0', () => {
  const r = run(every(), { GITHUB_OUTPUT: undefined });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.out, /^🟢 \*\*connectome-smoke\*\* — all lanes pass/);
});

test('in Actions an empty webhook fails the step, naming the secret, and a set whose post would only say all is well is remembered', () => {
  const r = run(every(), { GITHUB_ACTIONS: 'true', DISCORD_WEBHOOK: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^DISCORD_WEBHOOK is empty here: the repository secret is missing, so nothing was posted\. The post says only that all is well, so this run asks the workflow to remember the set; once the secret is set, a forced manual run \(force is the default\) posts the current set\.$/m);
  assert.match(r.out, /^🟢 \*\*connectome-smoke\*\* — all lanes pass/, 'it prints what it would have posted');
  assert.equal(r.output, 'remember=true\n', 'the next poll would find no webhook either, and its post would only say all is well');
  const some = run(every(['source']), { GITHUB_ACTIONS: 'true', DISCORD_WEBHOOK: '', LANES: 'source', FULL: 'false' });
  assert.equal(some.status, 1);
  assert.match(some.stderr, /^DISCORD_WEBHOOK is empty here: the repository secret is missing, so nothing was posted\.$/m, 'a run of some lanes remembers nothing, and says nothing of it');
  assert.equal(some.output, '');
});

test('in Actions an empty webhook leaves a set whose post reports a failure to a later poll, so it posts once the secret is set', () => {
  const failing = every();
  failing['source-floor'] = summary('source', 'fail');
  // A lane job that didn't end in success, while every summary passed,
  // makes a post that reports a failure too.
  for (const [what, runs, env] of [['a failing run', failing, {}], ['a cancelled lane job', every(), { RESULT_SOURCE: 'cancelled' }]]) {
    const r = run(runs, { GITHUB_ACTIONS: 'true', DISCORD_WEBHOOK: '', ...env });
    assert.equal(r.status, 1, what);
    assert.match(r.out, /^🔴 \*\*connectome-smoke\*\* — FAILURES/, what);
    assert.match(r.stderr, /^DISCORD_WEBHOOK is empty here: the repository secret is missing, so nothing was posted\. The post reports a failure, so this run didn't remember the set: unless an earlier run did, a later poll runs it again and posts it once the secret is set\.$/m, what);
    assert.equal(r.output, '', what);
  }
});

test('a post the webhook takes is sent once, as the content it prints, and the set is remembered', async () => {
  const r = await deliver([204]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.posts.length, 1);
  const { content } = JSON.parse(r.posts[0].body);
  assert.match(content, /^🟢 \*\*connectome-smoke\*\* — all lanes pass/);
  assert.equal(r.out, content, 'what it prints after "posted:" is what it sent');
  assert.equal(r.output, 'remember=true\n');
});

test('a $NOTIFY_TRY_MS that isn\'t a positive whole number a timer can hold gives each try 15 s, and the post goes out', async () => {
  // 2**31 is the first value the bound refuses that a timer would take, and
  // fire at once.
  for (const value of ['-5', '1.5', String(2 ** 31), String(2 ** 32)]) {
    const r = await deliver([204], { NOTIFY_TRY_MS: value });
    assert.equal(r.status, 0, `${value}: ${r.stderr}`);
    assert.equal(r.posts.length, 1, value);
  }
});

test('a post the webhook refuses fails the step at once, naming the answer, and a set whose post would only say all is well is remembered', async () => {
  const refused = { status: 404, body: '{"message": "Unknown Webhook", "code": 10015}' };
  const r = await deliver([refused, 204]);
  assert.equal(r.status, 1);
  assert.equal(r.posts.length, 1, 'a refusal isn\'t tried again');
  assert.match(r.stderr, /^discord webhook: refused: 404 \{"message": "Unknown Webhook", "code": 10015\}\. Trying again would be refused the same way\. The post says only that all is well, so this run asks the workflow to remember the set; once that is fixed, a forced manual run \(force is the default\) posts the current set\.$/m);
  assert.equal(r.output, 'remember=true\n', 'the next poll would be refused too, and its post would only say all is well');
  const some = await deliver([refused], { LANES: 'source', FULL: 'false' }, every(['source']));
  assert.equal(some.status, 1);
  assert.match(some.stderr, /^discord webhook: refused: 404 .*\. Trying again would be refused the same way\.$/m, 'a run of some lanes remembers nothing, and says nothing of it');
  assert.equal(some.output, '');
});

test('a refused post that reports a failure leaves its set to a later poll, so it posts once the webhook works', async () => {
  const runs = every();
  runs['source-floor'] = summary('source', 'fail');
  const r = await deliver([{ status: 404, body: '{"message": "Unknown Webhook", "code": 10015}' }], {}, runs);
  assert.equal(r.status, 1);
  assert.equal(r.posts.length, 1, 'a refusal isn\'t tried again');
  assert.match(r.stderr, /^discord webhook: refused: 404 .*\. Trying again would be refused the same way\. The post reports a failure, so this run didn't remember the set: unless an earlier run did, a later poll runs it again and posts it once that is fixed\.$/m);
  assert.equal(r.output, '');
});

test('400, 401, 403, 404 and 413 aren\'t tried again, and any other refusal is', async () => {
  for (const status of [400, 401, 403, 404, 413]) {
    const r = await deliver([status, 204]);
    assert.equal(r.status, 1, `${status}`);
    assert.equal(r.posts.length, 1, `${status} isn't tried again`);
  }
  for (const status of [408, 409, 422, 425]) {
    const r = await deliver([status, 204]);
    assert.equal(r.status, 0, `${status}: ${r.stderr}`);
    assert.equal(r.posts.length, 2, `${status} is tried again`);
    assert.equal(r.output, 'remember=true\n', `${status}: the post went out`);
  }
});

test('a server error is tried again, and the post is delivered', async () => {
  const r = await deliver([503, 204]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.posts.length, 2);
  assert.equal(r.posts[1].body, r.posts[0].body, 'the same post again');
  assert.equal(r.output, 'remember=true\n');
});

test('a rate limit is waited out as long as Discord says, then the post is delivered', async () => {
  const r = await deliver([{ status: 429, body: '{"message": "You are being rate limited.", "retry_after": 1.5, "global": false}' }, 204]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.posts.length, 2);
  // The lower bound is the wait itself. The upper bound catches only a wait
  // read in the wrong unit, leaving a loaded runner room.
  const gap = r.posts[1].at - r.posts[0].at;
  assert.ok(gap >= 1400 && gap < 25_000, `the second try came ${gap} ms after the first`);
  assert.equal(r.output, 'remember=true\n');
});

test('a rate limit with no usable retry_after is waited a second, then two', async () => {
  // Not JSON at all, then a retry_after Discord's docs never give: each try
  // waits as a server error's would.
  const html = { status: 429, body: '<html>Too Many Requests</html>' };
  const r = await deliver([html, { status: 429, body: '{"retry_after": -1}' }, html]);
  assert.equal(r.status, 1);
  assert.equal(r.posts.length, 3);
  const [first, second] = [r.posts[1].at - r.posts[0].at, r.posts[2].at - r.posts[1].at];
  // Lower bounds are the waits; the upper bounds catch only a wait read in
  // the wrong unit, leaving a loaded runner room.
  assert.ok(first >= 900 && first < 25_000, `the second try came ${first} ms after the first`);
  assert.ok(second >= 1900 && second < 25_000, `the third try came ${second} ms after the second`);
  assert.match(r.stderr, /^discord webhook: not delivered: 429 <html>Too Many Requests<\/html>; 429 \{"retry_after": -1\}; 429 <html>Too Many Requests<\/html>\. This run remembered nothing/m);
  assert.equal(r.output, '');
});

test('a rate limit longer than five minutes fails the step without waiting it out, and leaves the set to a later poll', async () => {
  const r = await deliver([{ status: 429, body: '{"retry_after": 3600}' }, 204]);
  assert.equal(r.status, 1);
  assert.equal(r.posts.length, 1);
  assert.match(r.stderr, /not delivered: 429 \{"retry_after": 3600\}; Discord asked for a wait of 3600s, longer than 300s\. This run remembered nothing, so unless an earlier run remembered the set, a later poll runs it again and tries the post again\.$/m);
  assert.equal(r.output, '');
});

test('three passing refusals fail the step, naming each, and leave the set to a later poll', async () => {
  const limited = { status: 429, body: '{"retry_after": 0.01}' };
  const r = await deliver([limited, limited, limited, 204]);
  assert.equal(r.status, 1);
  assert.equal(r.posts.length, 3, 'three tries in all');
  assert.match(r.stderr, /not delivered: 429 \{"retry_after": 0\.01\}; 429 \{"retry_after": 0\.01\}; 429 \{"retry_after": 0\.01\}\. This run remembered nothing/m);
  assert.equal(r.output, '');
});

test('a post that gets no answer is tried three times, fails the step, and leaves the set to a later poll', async () => {
  const r = await deliver(null);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not delivered: no answer \(ECONNREFUSED\); no answer \(ECONNREFUSED\); no answer \(ECONNREFUSED\)\. This run remembered nothing/m);
  assert.equal(r.output, '');
});

test('a webhook that takes the post and never answers is no answer once the try\'s time is up, tried three times, and the step fails', async () => {
  // It reads the request and never answers. Without a time of its own, each
  // try would wait out fetch's five minutes, and the run would outlast
  // runAsync's 30 s.
  // The try's time, 2 s, leaves a loaded runner room to deliver each request
  // before it's cut, so the server sees all three.
  let requests = 0;
  const server = createServer((req) => { requests++; req.resume(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const r = await runAsync(every(), { DISCORD_WEBHOOK: `http://127.0.0.1:${server.address().port}/`, NOTIFY_TRY_MS: '2000' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not delivered: no answer in 2000 ms; no answer in 2000 ms; no answer in 2000 ms\. This run remembered nothing/m);
    assert.equal(requests, 3, 'each try sent its own request');
    assert.equal(r.output, '');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a post that goes out after a try that got no answer says so, since that try may have been taken too', async () => {
  // The first request is read and never answered; the second is taken.
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    if (requests > 1) req.on('end', () => res.writeHead(204).end());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const r = await runAsync(every(), { DISCORD_WEBHOOK: `http://127.0.0.1:${server.address().port}/`, NOTIFY_TRY_MS: '2000' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(requests, 2);
    assert.equal(r.head, 'posted after 1 failed try (no answer in 2000 ms):');
    assert.equal(r.output, 'remember=true\n');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a delivered post is sent once, even when what follows it fails', async () => {
  // $GITHUB_OUTPUT in a folder that isn't there: writing the memory throws
  // after the webhook took the post.
  const r = await deliver([204, 204, 204], { GITHUB_OUTPUT: join(tmpdir(), 'notify-test-no-such-folder', 'github-output') });
  assert.equal(r.posts.length, 1, 'the post isn\'t sent again');
  assert.equal(r.head, 'posted:', 'the receipt is printed before the memory is written');
  assert.notEqual(r.status, 0, 'the step fails');
  assert.match(r.stderr, /ENOENT/, 'naming the write that failed');
  assert.doesNotMatch(r.stderr, /not delivered/);
});

test('a cut that splits an emoji in two leaves the post well-formed', async () => {
  // A failure line whose 299th character is the first half of an emoji, so
  // the 300-character cap keeps that half alone. Its run's runtime marks it
  // outside the cap.
  const detail = `${'e'.repeat(298 - '✗ step 1 — '.length)}🟢 and more`;
  const r = await deliver([204], {}, { ...every(), 'source-floor': summary('source', 'fail', { detail }) });
  assert.equal(r.status, 0, r.stderr);
  const { content } = JSON.parse(r.posts[0].body);
  const line = content.split('\n').find((l) => l.startsWith('floor: ✗ step 1 — e'));
  assert.equal(line.length, 'floor: '.length + 300);
  assert.equal(line.at(-2), '\uFFFD', 'the half is replaced');
  assert.ok(content.isWellFormed(), 'what the webhook got is well-formed');
});
