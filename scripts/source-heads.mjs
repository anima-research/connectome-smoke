#!/usr/bin/env node
/**
 * Fingerprint of the source lane's inputs: the main head of every repo the
 * lane clones, folded to one short stable hash. The workflow gate combines
 * this with the published-manifest hash so "did anything change since we
 * last tested?" covers BOTH kinds of input — npm published versions AND the
 * branch heads the source lane builds. Without it, a push to a stack repo's
 * main neither retests a fixed breakage nor catches a fresh one until the
 * next npm publish happens to change the manifest.
 *
 * A repo that can't be reached hashes as `<name>@unreachable` — stable, so
 * a network blip doesn't churn the key; the lane's own clone step is where
 * unreachability becomes a loud failure.
 *
 * Usage: node scripts/source-heads.mjs   → 16-hex hash on stdout
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { REPOS, repoUrl } from '../lib/repos.mjs';

const heads = REPOS.map((r) => {
  try {
    const out = execFileSync('git', ['ls-remote', repoUrl(r), 'refs/heads/main'], { encoding: 'utf-8', timeout: 60_000 });
    return `${r.repo}@${out.split('\t')[0].trim() || 'unknown'}`;
  } catch {
    return `${r.repo}@unreachable`;
  }
});
process.stdout.write(createHash('sha256').update(heads.sort().join(' ')).digest('hex').slice(0, 16) + '\n');
