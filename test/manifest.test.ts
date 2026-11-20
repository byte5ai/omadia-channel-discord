import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('package and manifest', () => {
  it('declare the same version', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const manifest = /^\s+version: "([^"]+)"/m.exec(read('manifest.yaml'))?.[1];
    assert.equal(manifest, pkg.version);
  });

  it('declares the agent selection service as an optional requirement and no buttons capability', () => {
    const manifest = read('manifest.yaml');
    assert.match(manifest, /optional_requires:[\s\S]*"agentSelection@1"/);
    assert.ok(!/- "buttons"/.test(manifest));
  });
});
