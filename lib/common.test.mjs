// The lanes' shared helpers: the line a failed boot reports, and the Bun
// floor check. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunMeetsHostFloor, exerciseBoot, failureEventLine, INFERENCE_FAILURE_KEYS } from './common.mjs';

test('a boot whose ipc socket refuses every connection names the socket by its label, not by this process\'s pid', async () => {
  // A stand-in `bun` that makes the socket's path a plain file, which refuses
  // connections, and stays up: the host that opens its socket but won't take
  // a connection, on every runtime alike.
  const dir = mkdtempSync(join(tmpdir(), 'cs-fake-host-'));
  try {
    writeFileSync(join(dir, 'bun'), '#!/bin/sh\nwhile [ "$1" != --socket-path ]; do shift; done\n: > "$2"\nexec sleep 30\n');
    chmodSync(join(dir, 'bun'), 0o755);
    await assert.rejects(
      exerciseBoot({ hostDir: dir, recipePath: join(dir, 'recipe.json'), dataDir: join(dir, 'data'), work: dir, label: 'boot1', env: { PATH: `${dir}:${process.env.PATH}` } }),
      (e) => {
        const first = e.message.split('\n')[0];
        assert.match(first, /^ipc connect failed: .*<boot1 socket>$/);
        assert.ok(!first.includes(String(process.pid)), first);
        return true;
      },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A stand-in host that speaks the boot's ipc: it opens its socket, says it's
// ready, answers /help and a text, and adds both clocks to every event, as
// agent-framework (`timestamp`) and the host (`ts`) do. $CS_FAKE says which
// failure it reports: an MCPL server's failed connect, with its stderr and
// attempt, followed by a second failure that reads otherwise, standing for
// any later one (the smoke's recipe doesn't turn reconnect on, but a
// connected server can report more than one error); or a failed inference
// with its stack.
const FAKE_HOST = `
import { createServer } from 'node:net';
const sockPath = process.argv[process.argv.indexOf('--socket-path') + 1];
const emit = (c, e) => c.write(JSON.stringify({ ...e, timestamp: Date.now(), ts: Date.now() }) + '\\n');
createServer((c) => {
  emit(c, { type: 'lifecycle', phase: 'ready' });
  if (process.env.CS_FAKE === 'mcpl') {
    emit(c, { type: 'mcpl:server-connect-failed', serverId: 'heartbeat', error: 'MCP error -32000: Connection closed', stderrTail: 'node:internal/modules/esm/resolve:857', attempt: 0, willRetry: true });
    emit(c, { type: 'mcpl:server-connect-failed', serverId: 'heartbeat', error: 'MCP handshake timed out', attempt: 1, willRetry: true });
  }
  let buf = '';
  c.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\\n')) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      if (m.type === 'command') for (let n = 0; n < 3; n++) emit(c, { type: 'command-output', text: 'help' });
      if (m.type === 'text') {
        emit(c, { type: 'message:added', source: 'external-message' });
        emit(c, { type: 'inference:failed', agentName: 'smoke', error: 'boom', stack: 'Error: boom\\n    at ' + process.cwd() + '/src/index.ts:1:1' });
        emit(c, { type: 'inference:speech', agentName: 'smoke', content: 'SMOKE-REPLY ' + m.content.split(' ')[2] });
        emit(c, { type: 'lifecycle', phase: 'idle' });
      }
    }
  });
}).listen(sockPath);
`;

async function failingLineOf(fake) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-fake-host-'));
  try {
    writeFileSync(join(dir, 'host.mjs'), FAKE_HOST);
    writeFileSync(join(dir, 'bun'), '#!/bin/sh\nexec node "$(dirname "$0")/host.mjs" "$@"\n');
    chmodSync(join(dir, 'bun'), 0o755);
    let first;
    await assert.rejects(
      exerciseBoot({ hostDir: dir, recipePath: join(dir, 'recipe.json'), dataDir: join(dir, 'data'), work: dir, label: 'boot1', nonce: 'n1', env: { PATH: `${dir}:${process.env.PATH}`, CS_FAKE: fake } }),
      (e) => { first = e.message.split('\n')[0]; return true; },
    );
    return first;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a boot\'s MCPL failure line quotes only the first failure, by the keys that name it, whatever follows it and whatever other keys it carries', async () => {
  assert.equal(await failingLineOf('mcpl'), 'MCPL server trouble: {"type":"mcpl:server-connect-failed","serverId":"heartbeat","error":"MCP error -32000: Connection closed"}');
});

test('a boot\'s inference failure line quotes the event by the keys that name it, without its clocks or its stack', async () => {
  assert.equal(await failingLineOf('inference'), 'inference failures: {"type":"inference:failed","agentName":"smoke","error":"boom"}');
});

test('a failure\'s line keeps only the listed keys, in the list\'s order, leaving out those the event lacks', () => {
  assert.equal(
    failureEventLine({ httpStatus: 400, retryable: false, error: 'bad', type: 'inference:exhausted', agentName: 'smoke', timestamp: 1, ts: 2, added: { later: true } }, INFERENCE_FAILURE_KEYS),
    '{"type":"inference:exhausted","agentName":"smoke","error":"bad","httpStatus":400}',
  );
  assert.equal(failureEventLine({ type: 't', error: { code: 1, detail: ['a'] } }, ['type', 'error']), '{"type":"t","error":{"code":1,"detail":["a"]}}');
});

// The floor check's cases, each a decision the check exists to keep: a Bun
// below the host's engines.bun fails, a prerelease sorts below its release,
// and a floor in a form the check can't read fails rather than passes.
function hostWith(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-floor-'));
  const path = join(dir, 'package.json');
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const withFloor = (bun) => ({ name: '@animalabs/connectome-host', engines: { node: '>=22.12.0', ...(bun === undefined ? {} : { bun }) } });

test('a Bun at or above the host\'s floor meets it, a +build at the floor meets it, and one below fails naming both versions', () => {
  const host = hostWith(withFloor('>=1.4.3'));
  try {
    assert.equal(bunMeetsHostFloor(host.path, '1.4.3'), 'Bun 1.4.3 meets the host\'s >=1.4.3');
    assert.equal(bunMeetsHostFloor(host.path, '1.5.0'), 'Bun 1.5.0 meets the host\'s >=1.4.3');
    assert.equal(bunMeetsHostFloor(host.path, '1.4.3+a1b2c3d'), 'Bun 1.4.3+a1b2c3d meets the host\'s >=1.4.3');
    assert.throws(() => bunMeetsHostFloor(host.path, '1.3.14'), /^Error: this lane runs Bun 1\.3\.14, below the host's floor of 1\.4\.3\. The lanes run the first bun on PATH: in CI, RUNTIMES in \.github\/workflows\/smoke\.yml sets it for each leg; run locally, .*\(engines\.bun in .*package\.json\)$/s);
  } finally { host.done(); }
});

test('a prerelease sorts below its release: 1.4.3-canary.1 fails a floor of 1.4.3, and 1.4.4-canary.1 meets it', () => {
  const host = hostWith(withFloor('>=1.4.3'));
  try {
    assert.throws(() => bunMeetsHostFloor(host.path, '1.4.3-canary.1'), /runs Bun 1\.4\.3-canary\.1, below the host's floor of 1\.4\.3/);
    assert.equal(bunMeetsHostFloor(host.path, '1.4.4-canary.1'), 'Bun 1.4.4-canary.1 meets the host\'s >=1.4.3');
  } finally { host.done(); }
});

test('padding around the floor and the Bun version is read past, and the error names both without it', () => {
  const host = hostWith(withFloor(' >= 1.4.3 '));
  try {
    assert.equal(bunMeetsHostFloor(host.path, ' 1.4.3\n'), 'Bun 1.4.3 meets the host\'s  >= 1.4.3 ');
    assert.throws(() => bunMeetsHostFloor(host.path, ' 1.3.14\n'), /runs Bun 1\.3\.14, below the host's floor of 1\.4\.3\./);
  } finally { host.done(); }
});

test('a host that declares no Bun floor passes, naming the Bun', () => {
  const host = hostWith(withFloor(undefined));
  try {
    assert.equal(bunMeetsHostFloor(host.path, '1.3.14'), 'the host declares no Bun floor; Bun 1.3.14');
  } finally { host.done(); }
});

test('a floor in any form but >=X.Y.Z fails rather than passes, naming the form and where to teach the check it', () => {
  for (const floor of ['^1.4.3', '>=1.5.0 <2', '1.4.3', '>=1.4', null]) {
    const host = hostWith(withFloor(floor));
    try {
      assert.throws(() => bunMeetsHostFloor(host.path, '9.9.9'), (error) => error.message.startsWith(`the host declares engines.bun ${JSON.stringify(floor)}, which this check reads only as >=X.Y.Z`) && error.message.includes('bunMeetsHostFloor, in lib/common.mjs'), JSON.stringify(floor));
    } finally { host.done(); }
  }
});

test('a host package.json that isn\'t JSON fails, naming the file', () => {
  const host = hostWith('{ "engines": ');
  try {
    assert.throws(() => bunMeetsHostFloor(host.path, '1.4.3'), (error) => error.message.startsWith(`the host's package.json at ${host.path} can't be read as JSON: `));
  } finally { host.done(); }
});

test('an empty or missing bun -v fails as not a version', () => {
  const host = hostWith(withFloor('>=1.4.3'));
  try {
    for (const bun of ['', null, 'bun 1.4.3']) assert.throws(() => bunMeetsHostFloor(host.path, bun), new RegExp(`^Error: bun -v gave ${JSON.stringify(bun).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, which isn't a version$`), JSON.stringify(bun));
  } finally { host.done(); }
});
