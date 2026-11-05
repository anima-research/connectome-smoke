#!/usr/bin/env node
/**
 * Post the run's lane summaries to Discord (webhook in $DISCORD_WEBHOOK).
 * Reads every summary-*.md under the evidence dir (downloaded artifacts).
 * In the workflow each run writes summary-<lane>-<runtime>.md. $LANES (the
 * lanes the run requested, comma-separated) and $RUNTIMES (the workflow's
 * runtime list, JSON) say which runs to expect, and the post names each one
 * whose summary never reached it; without either, nothing can be checked,
 * and the post fails saying so. $FULL is 'true' for a run of every lane, and
 * $RESULT_PUBLISHED and $RESULT_SOURCE are the lane jobs' results: a job
 * that ran a requested lane and didn't end in success turns the post red.
 *
 * It also decides whether the workflow remembers the set as tested, and
 * writes remember=true to $GITHUB_OUTPUT when it does, which asks the
 * workflow to save the set's marker: once a run of every lane had a result
 * from every requested run, a summary passing or failing, and the post
 * went out. A set whose post would only say all is well (every run passed,
 * and nothing else went wrong) is also remembered when its post can't go
 * out until someone acts (there's no webhook, or Discord refused it for a
 * reason the next poll would meet too). A set whose post reports a failure
 * is remembered only once that post goes out, so until then a later poll
 * runs it again and posts it once the webhook works. A post that didn't go
 * out for a passing reason, or a step stopped before the post settled,
 * writes nothing, so a later poll runs the set again and posts. A later
 * poll skips the set only while the cache holds a marker it can read: one
 * a run on the default branch saved, not yet evicted. A forced manual run
 * of a remembered set can't take the marker back.
 *
 * So that a passing failure doesn't cost a rerun of every lane, the post
 * is tried again within the step, three tries in all: after a rate limit,
 * once the wait Discord's answer gives is over (up to five minutes); after
 * a server error, a refusal other than 400, 401, 403, 404 or 413, a
 * request that got no answer, or a rate limit whose answer gives no wait,
 * after a second, then two. Each try waits up to 15 s for an answer
 * ($NOTIFY_TRY_MS, a positive whole number of milliseconds, sets it),
 * rather than fetch's own five minutes, so a webhook that takes the
 * request and never answers can't hold the step.
 * A request that got no answer may have been taken, so a later try, or a
 * later poll's post, can be a second copy.
 *
 * Without a webhook it prints what it would post. It then exits 0, or 1
 * under GitHub Actions, where an empty webhook means the secret is missing
 * and nobody was told.
 *
 * Usage: node scripts/notify.mjs <evidence-dir>
 */
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const dir = process.argv[2] ?? 'evidence';
const webhook = process.env.DISCORD_WEBHOOK;
const runUrl = process.env.RUN_URL ?? '';
const reason = process.env.REASON ?? '';

// What the post must say beyond the summaries.
const problems = [];
const why = (e) => e.code ?? e.message;

function* walk(d) {
  let ents;
  try { ents = readdirSync(d); }
  catch (e) { problems.push(`the evidence folder ${d} couldn't be read (${why(e)})`); return; }
  for (const n of ents) {
    const p = join(d, n);
    let isDir;
    try { isDir = statSync(p).isDirectory(); }
    catch (e) { problems.push(`the evidence entry ${p} couldn't be read (${why(e)})`); continue; }
    if (isDir) yield* walk(p);
    else if (/^summary-.*\.md$/.test(n)) yield p;
  }
}

// Each summary by the run that wrote it: summary-<lane>-<runtime>.md.
const summaries = new Map();
for (const p of [...walk(dir)].sort()) {
  try { summaries.set(basename(p).slice('summary-'.length, -'.md'.length), readFileSync(p, 'utf-8').trim()); }
  catch (e) { problems.push(`the summary ${p} couldn't be read (${why(e)})`); }
}

// The requested runs are the requested lanes on every runtime. A run whose
// summary isn't here never reported: its setup failed, it was cut off, or
// its evidence wasn't uploaded or downloaded. Its siblings' summaries can't
// stand in for it, so each is named.
const lanes = (process.env.LANES ?? '').split(',').map((l) => l.trim()).filter(Boolean);
if (lanes.length === 0) problems.push("the requested lanes (LANES) weren't given, so no run could be checked for a summary");
let runtimes = [];
try {
  runtimes = JSON.parse(process.env.RUNTIMES ?? '');
  if (!Array.isArray(runtimes) || runtimes.length === 0) throw new Error('not a list of runtimes');
  if (!runtimes.every((rt) => ['name', 'node', 'bun'].every((k) => typeof rt?.[k] === 'string' && rt[k] !== ''))) throw new Error('a runtime without a name, node or bun');
} catch {
  runtimes = [];
  problems.push("the workflow's runtime list (RUNTIMES) couldn't be read, so no run could be checked for a summary");
}
const requested = lanes.flatMap((lane) => runtimes.map((rt) => ({ lane, rt, run: `${lane}-${rt.name}` })));
for (const { lane, rt, run } of requested) {
  if (!summaries.has(run)) problems.push(`${lane} on ${rt.name} (Node ${rt.node}, Bun ${rt.bun}): no summary reached the report (infra/error)`);
}
// Every requested run reported, with a summary that says something.
const complete = requested.length > 0 && requested.every(({ run }) => summaries.get(run));

// A summary's verdict is on its first line; later lines can quote anything.
const passed = (s) => s.split('\n')[0].includes('✅ PASS');
const failing = [...summaries].filter(([, s]) => !passed(s));
// A lane job can end other than in success after its runs wrote passing
// summaries (a later step failed, or it was cancelled), and the post doesn't
// read green while the run doesn't. A job counts only when the run requested
// one of its lanes: the published job's legs for other lanes run nothing.
if (failing.length === 0 && problems.length === 0) {
  for (const [job, its, name] of [['Published lane', ['published', 'latest'], 'RESULT_PUBLISHED'], ['Source-main lane', ['source'], 'RESULT_SOURCE']]) {
    const result = process.env[name];
    if (!its.some((l) => lanes.includes(l)) || result === 'success') continue;
    problems.push(result ? `the ${job} job ended '${result}', though every summary it wrote passes` : `the ${job} job's result (${name}) wasn't given`);
  }
}

const allPass = failing.length === 0 && problems.length === 0;
const verdict = !allPass
  ? 'FAILURES'
  : process.env.FULL === 'true' ? 'all lanes pass' : `${lanes.join(', ')} ${lanes.length === 1 ? 'passes' : 'pass'}`;
const head = `${allPass ? '🟢' : '🔴'} **connectome-smoke** — ${verdict}${reason ? ` · _${reason}_` : ''}${runUrl ? ` · <${runUrl}>` : ''}`;
// Discord caps a message at 2000 characters; keep one message. Nine runs'
// summaries don't fit one after another, and a lane's runs mostly say the
// same thing, so each lane gets one block: its name, a line per runtime
// with that run's verdict, then each line worth posting from the runs'
// summaries (versions, lag, nested, failing steps, fatal) once, after the
// runtimes that have it when not every run the block lists does: a run
// whose summary is empty has none. A lane with a run that didn't pass
// comes first, so a cut drops passing lanes before any failure. The cut
// falls at a line boundary, and a last line says the post was cut. Each
// line a summary gives, and each problem line, is kept to 300 characters,
// the cap lib/common.mjs puts on a step's detail, so one long line can't
// push later failures out; the runtimes a line is marked with come before
// it, outside the cap.
const LINE = 300;
const cap = (l) => (l.length > LINE ? `${l.slice(0, LINE - 1)}…` : l);
// A run's name is summary-<lane>-<runtime>.md's middle, so its lane runs to
// the first hyphen and its runtime is the rest.
const byLane = new Map();
for (const [run, s] of summaries) {
  const at = run.indexOf('-');
  const lane = at === -1 ? run : run.slice(0, at);
  if (!byLane.has(lane)) byLane.set(lane, []);
  byLane.get(lane).push({ runtime: at === -1 ? run : run.slice(at + 1), s });
}
// A summary's first line is "**connectome-smoke · <lane>** — <verdict>".
const verdictOf = (s) => {
  const first = s.split('\n')[0];
  const at = first.indexOf(' — ');
  return at === -1 ? first : first.slice(at + ' — '.length);
};
const worthPosting = (s) => {
  const ls = s.split('\n');
  return [ls[1] ?? '', ...ls.slice(2).filter((l) => /^(lag|nested|✗|fatal)/.test(l))].filter(Boolean);
};
const block = (lane, runs) => {
  const said = runs.filter(({ s }) => s);
  const has = new Map();
  for (const { runtime, s } of said) {
    // Cut before comparing, so lines that differ only past the cut are one.
    for (const l of worthPosting(s).map(cap)) {
      if (!has.has(l)) has.set(l, []);
      if (!has.get(l).includes(runtime)) has.get(l).push(runtime);
    }
  }
  return [
    `**${lane}**`,
    ...runs.map(({ runtime, s }) => `${runtime}: ${s ? cap(verdictOf(s)) : '✗ its summary is empty'}`),
    ...[...has].map(([l, runtimes]) => (runtimes.length === runs.length ? l : `${runtimes.join(', ')}: ${l}`)),
  ];
};
const failed = (runs) => runs.some(({ s }) => !passed(s));
const blocks = [...byLane].filter(([, runs]) => failed(runs)).concat([...byLane].filter(([, runs]) => !failed(runs)));
const body = [
  ...problems.map((m) => cap(`✗ ${m}`)),
  ...blocks.flatMap(([lane, runs]) => block(lane, runs)),
];
const LIMIT = 2000;
const CUT = "… cut at Discord's 2,000-character limit; each summary is on the run's page";
let content = [head, ...body].join('\n');
if (content.length > LIMIT) content = `${content.slice(0, content.lastIndexOf('\n', LIMIT - CUT.length - 1))}\n${CUT}`;
// A cut, here or in a lane's summary, can split an emoji's surrogate pair;
// what's posted is well-formed, with U+FFFD in place of a half.
content = content.toWellFormed();

// Whether the set may be remembered once the post settles: a run of every
// lane, with a result from every requested run.
const rememberable = process.env.FULL === 'true' && complete;
// A post that went out remembers the set. One that can't go out until
// someone acts remembers it only when it would only say all is well (it's
// green), while a post that reports a failure, a red lane job's included,
// is the point of the run.
const remember = (delivered) => {
  if (rememberable && (delivered || allPass) && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'remember=true\n');
};
// What an undelivered post's message says of the memory, once its cause is
// fixed ("once the secret is set", "once that is fixed"). A later poll
// skips a set only while the cache holds its marker, and a manual run runs
// it whatever the memory says only with force, the default.
const undelivered = (once) => (!rememberable ? ''
  : allPass ? `. The post says only that all is well, so this run asks the workflow to remember the set; ${once}, a forced manual run (force is the default) posts the current set`
  : `. The post reports a failure, so this run didn't remember the set: unless an earlier run did, a later poll runs it again and posts it ${once}`);

if (!webhook) {
  remember(false);
  console.log('(no DISCORD_WEBHOOK) would post:\n' + content);
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error(`DISCORD_WEBHOOK is empty here: the repository secret is missing, so nothing was posted${undelivered('once the secret is set')}.`);
    process.exit(1);
  }
  process.exit(0);
}
// Refusals the next poll would meet too: a malformed post, a webhook whose
// token is wrong or that no longer exists, or a post too large. Any other
// refusal, 429 included, is tried again.
const PERMANENT = new Set([400, 401, 403, 404, 413]);
const TRIES = 3;
const MAX_WAIT_S = 300;
// A positive whole number of milliseconds a timer can hold, else 15 s: a
// timer past 2**31 - 1 ms fires at once, and AbortSignal.timeout refuses a
// negative or fractional one.
const tryMs = Number(process.env.NOTIFY_TRY_MS);
const TRY_MS = Number.isSafeInteger(tryMs) && tryMs > 0 && tryMs <= 2 ** 31 - 1 ? tryMs : 15_000;
const tries = [];
for (let n = 1; ; n++) {
  let waitMs = n * 1000;
  // Only the request is tried here: what follows a delivered post, such as
  // writing $GITHUB_OUTPUT, failing must not read as no answer and post it
  // again.
  let res;
  try {
    // The signal also bounds reading the answer, below.
    res = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }), signal: AbortSignal.timeout(TRY_MS) });
  } catch (e) {
    tries.push(e?.name === 'TimeoutError' ? `no answer in ${TRY_MS} ms` : `no answer (${e.cause?.code ?? e.message})`);
  }
  if (res?.ok) {
    // Earlier tries that went unanswered may have been taken too (above), so
    // the receipt names them.
    console.log(`posted${tries.length ? ` after ${tries.length} failed ${tries.length === 1 ? 'try' : 'tries'} (${tries.join('; ')})` : ''}:\n${content}`);
    remember(true);
    process.exit(0);
  }
  if (res) {
    const answer = await res.text().catch(() => '');
    tries.push(`${res.status} ${answer.slice(0, 300)}`.trim());
    if (PERMANENT.has(res.status)) {
      remember(false);
      console.error(`discord webhook: refused: ${tries.join('; ')}. Trying again would be refused the same way${undelivered('once that is fixed')}.`);
      process.exit(1);
    }
    if (res.status === 429) {
      let after;
      try { after = JSON.parse(answer).retry_after; } catch {}
      if (typeof after === 'number' && after >= 0) {
        if (after > MAX_WAIT_S) { tries.push(`Discord asked for a wait of ${after}s, longer than ${MAX_WAIT_S}s`); break; }
        waitMs = after * 1000;
      }
    }
  }
  if (n === TRIES) break;
  await new Promise((r) => setTimeout(r, waitMs));
}
console.error(`discord webhook: not delivered: ${tries.join('; ')}. This run remembered nothing, so unless an earlier run remembered the set, a later poll runs it again and tries the post again.`);
process.exit(1);
