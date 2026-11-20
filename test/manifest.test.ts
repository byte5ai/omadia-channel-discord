import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('package and manifest', () => {
  it('declare the same version', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const manifest = /^\s+version: "([^"]+)"/m.exec(read('manifest.yaml'))?.[1];
    assert.equal(manifest, pkg.version);
  });

  it('requires the kernel with the S1 routing contract (placeholder floor)', () => {
    assert.match(read('manifest.yaml'), /^\s+core: ">=1\.75\.0 <2\.0"/m);
  });

  it('declares no agent selection service: /agent, /agents are plain text for the resolver\'s ChatAgent', () => {
    const manifest = read('manifest.yaml');
    assert.ok(!/agentSelection/.test(manifest.replace(/^\s*#.*$/gm, '')));
    assert.match(manifest, /optional_requires:\s*\n\s*- "channelResolver@1"/);
    assert.ok(!/- "buttons"/.test(manifest));
  });

  it('no source calls an agent-selection service or parses the agent command itself', () => {
    const src = new URL('../src/', import.meta.url);
    for (const file of readdirSync(src).filter((f) => f.endsWith('.ts'))) {
      const code = readFileSync(new URL(file, src), 'utf8').replace(/^\s*(\*|\/\/|\/\*).*$/gm, '');
      assert.ok(!/agentSelection|AGENT_SELECTION|parseAgentCommand/.test(code), file);
    }
  });
});
