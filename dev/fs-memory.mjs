// File-backed stand-in for the host's `ctx.memory` (a plugin-scoped
// MemoryAccessor), rooted at the given directory. Used by dev/run.mjs and
// dev/history-check.ts. NOT shipped.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export function createFsMemory(root) {
  const abs = (relPath) => {
    const p = resolve(root, relPath);
    if (!p.startsWith(resolve(root))) throw new Error(`path escapes memory root: ${relPath}`);
    return p;
  };
  return {
    readFile: (relPath) => readFile(abs(relPath), 'utf8'),
    async writeFile(relPath, content) {
      const p = abs(relPath);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content);
    },
    exists: (relPath) =>
      access(abs(relPath)).then(
        () => true,
        () => false,
      ),
  };
}

export const DEV_MEMORY_ROOT = join(dirname(new URL(import.meta.url).pathname), 'out', 'memory');
