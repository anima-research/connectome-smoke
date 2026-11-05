/**
 * The source lane's repo list, in build order — shared between the lane
 * itself (lanes/source.mjs) and the gate's source-heads fingerprint
 * (scripts/source-heads.mjs), so the set the gate keys on is the set the
 * lane actually clones.
 *
 * `dir` = checkout name (what `file:` links expect). `pkgDirs` =
 * sub-packages for monorepos, in build order. `test` false = no test script
 * worth running here (or none). `sibling` = which checkouts a `file:` link
 * needs (documentation; order already satisfies it).
 */
export const DEFAULT_ORG = 'anima-research';

export const REPOS = [
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

export function repoUrl(r, org = DEFAULT_ORG) {
  return `https://github.com/${r.owner ?? org}/${r.repo}.git`;
}
