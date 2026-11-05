// What manifest.mjs makes of the registry's answers, with a stand-in `npm`
// on PATH that answers for each package as a test says. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MANIFEST = fileURLToPath(new URL('./manifest.mjs', import.meta.url));

/** npm's answer, under --json, for a package it doesn't serve, as npm 10.9.0
 *  and 11.17.0 give it: the error as JSON on stdout, its lines on stderr. */
function notFound(pkg) {
  const url = `https://registry.npmjs.org/${pkg.replace('/', '%2f')}`;
  return {
    stdout: JSON.stringify({ error: { code: 'E404', summary: `Not Found - GET ${url} - Not found`, detail: `'${pkg}@*' is not in this registry.` } }),
    stderr: `npm error code E404\nnpm error 404 Not Found - GET ${url} - Not found`,
  };
}

/** Run manifest.mjs with `npm view <package> …` answered by `answers`:
 *  package → the JSON npm prints, { stdout, stderr } for a lookup that
 *  fails (npm exits 1), or { signal, stderr } for an npm a signal stops,
 *  after it writes `stderr`, if given. Every other package is answered as
 *  published at 1.0.<n>, at 2026-10-01T00:<n>:00Z, where n counts the
 *  packages answered so; its `time.modified` is later, so a manifest that
 *  took it for the publish time would show. With `noNpm`, no npm is on
 *  PATH at all. Returns the exit status, stdout, stderr, and the packages
 *  answered so, in the order they were asked about. */
function manifest(answers = {}, { noNpm = false } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'manifest-test-'));
  const asked = join(bin, 'asked');
  const sq = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  try {
    const cases = Object.entries(answers).map(([pkg, a]) => (typeof a === 'string'
      ? `  ${sq(pkg)}) printf '%s\\n' ${sq(a)} ;;`
      : a.signal
        ? `  ${sq(pkg)}) ${a.stderr ? `printf '%s\\n' ${sq(a.stderr)} >&2; ` : ''}kill -${a.signal} $$ ;;`
        : `  ${sq(pkg)}) printf '%s\\n' ${sq(a.stdout)}; printf '%s\\n' ${sq(a.stderr)} >&2; exit 1 ;;`)).join('\n');
    writeFileSync(join(bin, 'npm'), [
      '#!/bin/sh',
      'case "$2" in',
      cases,
      `  *) n=$(cat ${sq(asked)} 2>/dev/null | wc -l); n=$((n + 0)); echo "$2" >> ${sq(asked)}`,
      `     printf '{"dist-tags.latest":"1.0.%d","time":{"1.0.%d":"2026-10-01T00:%02d:00.000Z","modified":"2026-10-15T00:00:00.000Z"}}\\n' "$n" "$n" "$n" ;;`,
      'esac',
      '',
    ].join('\n'));
    chmodSync(join(bin, 'npm'), 0o755);
    const r = spawnSync(process.execPath, [MANIFEST], { encoding: 'utf-8', env: { PATH: noNpm ? join(bin, 'nothing-here') : `${bin}:${process.env.PATH}` } });
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      asked: existsSync(asked) ? readFileSync(asked, 'utf-8').split('\n').filter(Boolean) : [],
    };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test('every package answering gives each its own version and publish time, and the hash of the sorted set', () => {
  const r = manifest();
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  assert.ok(r.asked.length > 1, 'more than one package was asked about');
  assert.deepEqual(Object.keys(m.packages).sort(), [...r.asked].sort(), 'every package asked about is in the manifest');
  r.asked.forEach((pkg, n) => {
    assert.deepEqual(m.packages[pkg], { latest: `1.0.${n}`, modified: `2026-10-01T00:${String(n).padStart(2, '0')}:00.000Z` }, pkg);
  });
  const set = r.asked.map((pkg, n) => `${pkg}@1.0.${n}`).sort().join(' ');
  assert.equal(m.hash, createHash('sha256').update(set).digest('hex').slice(0, 16), 'the first 16 hex digits of the sha256 of the sorted name@version list');
  assert.equal(JSON.parse(manifest().stdout).hash, m.hash, 'the same answers give the same hash');
  const other = manifest({ [r.asked[0]]: JSON.stringify({ 'dist-tags.latest': '9.9.9', time: { '9.9.9': '2026-10-02T00:00:00.000Z' } }) });
  assert.equal(other.status, 0, other.stderr);
  assert.notEqual(JSON.parse(other.stdout).hash, m.hash, 'another version is another set');
});

test('a failed lookup fails, naming the package with npm\'s reason, and gives no manifest', () => {
  const r = manifest({ '@animalabs/membrane': notFound('@animalabs/membrane') });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^manifest: the registry lookup failed for @animalabs\/membrane \(E404: Not Found - GET https:\/\/registry\.npmjs\.org\/@animalabs%2fmembrane - Not found\)\. /);
  assert.match(r.stderr, /this run stops here, and the next poll asks again/);
  assert.match(r.stderr, /A package that answers E404 at every poll can't be had under that name from this registry \(unpublished, renamed or private\): correct it, or take it out of scripts\/manifest\.mjs's PACKAGES and wherever the lanes and lib\/common\.mjs's boot exercise use it\.$/m);
  assert.doesNotMatch(r.stderr, /^npm error/m, 'npm\'s own lines are taken into the reason, not printed beside it');
});

test('without npm\'s error on stdout, the reason is the first line npm wrote to stderr, and E404\'s remedy isn\'t given', () => {
  const r = manifest({ '@animalabs/membrane': { stdout: '', stderr: 'npm error code ECONNRESET\nnpm error network aborted' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /failed for @animalabs\/membrane \(npm error code ECONNRESET\)\. No set was hashed, so this run stops here, and the next poll asks again\.$/m);
  assert.doesNotMatch(r.stderr, /E404/);
});

test('npm\'s error on stdout with neither a code nor a summary gives way to its stderr', () => {
  const r = manifest({ '@animalabs/membrane': { stdout: '{"error": {}}', stderr: 'npm error something went wrong' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /failed for @animalabs\/membrane \(npm error something went wrong\)\. /);
});

test('a failed lookup with nothing on stderr is named by Node\'s own line for it', () => {
  const r = manifest({ '@animalabs/membrane': { stdout: 'not json', stderr: '' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /failed for @animalabs\/membrane \(Command failed: npm view @animalabs\/membrane dist-tags\.latest time --json\)\. /);
});

test('a lookup that didn\'t exit by itself is named by what stopped it, before anything npm wrote to stderr', () => {
  const killed = manifest({ '@animalabs/membrane': { signal: 'KILL', stderr: 'npm warn config production Use `--omit=dev` instead.' } });
  assert.equal(killed.status, 1);
  assert.match(killed.stderr, /failed for @animalabs\/membrane \(npm was stopped by SIGKILL\)\. /);
  const missing = manifest({}, { noNpm: true });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /failed for @animalabs\/chronicle \(spawnSync npm ENOENT\); /);
  // Every package is named, each with that reason: the ones a run with npm
  // asks about.
  const every = manifest().asked;
  assert.ok(every.length > 1);
  for (const pkg of every) assert.ok(missing.stderr.includes(`${pkg} (spawnSync npm ENOENT)`), pkg);
});

test('every failed lookup is named in the one line, each with its reason', () => {
  const r = manifest({ '@animalabs/membrane': notFound('@animalabs/membrane'), '@animalabs/chronicle': { stdout: '', stderr: 'npm error code E503' } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /failed for @animalabs\/chronicle \(npm error code E503\); @animalabs\/membrane \(E404: Not Found - /);
});

test('an answer without a latest tag, or without a publish time for its latest version, fails too', () => {
  for (const [json, why] of [
    [JSON.stringify({ time: { modified: '2026-10-02T00:00:00.000Z' } }), /@animalabs\/discord-mcpl \(no latest dist-tag\)/],
    [JSON.stringify({ 'dist-tags.latest': '1.0.0', time: {} }), /@animalabs\/discord-mcpl \(no publish time for 1\.0\.0\)/],
    [JSON.stringify({ 'dist-tags.latest': '1.0.0', time: { modified: '2026-10-02T00:00:00.000Z' } }), /@animalabs\/discord-mcpl \(no publish time for 1\.0\.0\)/],
  ]) {
    const r = manifest({ '@animalabs/discord-mcpl': json });
    assert.equal(r.status, 1, json);
    assert.equal(r.stdout, '', json);
    assert.match(r.stderr, why, json);
  }
});
