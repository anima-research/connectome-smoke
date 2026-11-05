#!/usr/bin/env node
/**
 * Registry manifest: the current `latest` version + publish time of every
 * package in the stack, plus a stable hash of the version set. The workflow
 * gate compares hashes to decide "did anything change since we last tested?"
 * and uses the newest `modified` to debounce a cascading release.
 *
 * Usage: node scripts/manifest.mjs   → JSON on stdout
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const PACKAGES = [
  '@animalabs/chronicle',
  '@animalabs/membrane',
  '@animalabs/context-manager',
  '@animalabs/agent-framework',
  '@animalabs/connectome-host',
  '@animalabs/mcpl-core',
  '@animalabs/heartbeat-mcpl',
  '@animalabs/discord-mcpl',
  '@animalabs/portal-protocol',
  '@animalabs/portal-client',
];

function view(pkg) {
  const out = execFileSync('npm', ['view', pkg, 'dist-tags.latest', 'time', '--json'], { encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const j = JSON.parse(out);
  const latest = j['dist-tags.latest'];
  if (!latest) throw new Error('no latest dist-tag');
  const modified = j.time?.[latest];
  if (!modified) throw new Error(`no publish time for ${latest}`);
  return { latest, modified };
}

// Why a lookup failed, in npm's words where it gave any: under --json npm
// prints its error on stdout as {"error": {"code", "summary"}}. Otherwise,
// a lookup that didn't exit by itself is named by what stopped it, ahead of
// anything npm wrote to stderr: Node's own error when it ran past its 60 s
// (spawnSync npm ETIMEDOUT) or couldn't start (ENOENT), which carries a
// code, else the signal. Otherwise the first line npm wrote to stderr, else
// the error's own first line (an answer view() refused, or Node's 'Command
// failed' line).
function reasonOf(e) {
  try {
    const { code, summary } = JSON.parse(e.stdout).error;
    if (code || summary) return [code, summary].filter(Boolean).join(': ');
  } catch {}
  if (e.status === null) return e.code ? String(e.message).split('\n')[0] : `npm was stopped by ${e.signal}`;
  return String(e.stderr ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? String(e.message).split('\n')[0];
}

// A package the registry didn't answer for has no version in the set, so
// the hash wouldn't name the set that's published, and the workflow would
// remember or skip a set nobody tested. So any failed lookup fails, and the
// next poll asks again.
const packages = {};
const failed = [];
for (const p of PACKAGES) {
  try { packages[p] = view(p); }
  catch (e) { failed.push([p, reasonOf(e)]); }
}
if (failed.length) {
  const notServed = failed.some(([, why]) => why.startsWith('E404'))
    ? " A package that answers E404 at every poll can't be had under that name from this registry (unpublished, renamed or private): correct it, or take it out of scripts/manifest.mjs's PACKAGES and wherever the lanes and lib/common.mjs's boot exercise use it."
    : '';
  console.error(`manifest: the registry lookup failed for ${failed.map(([p, why]) => `${p} (${why})`).join('; ')}. No set was hashed, so this run stops here, and the next poll asks again.${notServed}`);
  process.exit(1);
}
const versionSet = Object.entries(packages).map(([k, v]) => `${k}@${v.latest}`).sort().join(' ');
const hash = createHash('sha256').update(versionSet).digest('hex').slice(0, 16);
process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), hash, packages }) + '\n');
