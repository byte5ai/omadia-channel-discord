import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = process.env.OMADIA_REPO ?? fileURLToPath(new URL('../../', import.meta.url));
const TARGETS = {
  '@omadia/channel-sdk': 'middleware/packages/harness-channel-sdk/dist/index.js',
  '@omadia/plugin-api': 'middleware/packages/plugin-api/dist/index.js',
};

export async function resolve(specifier, context, next) {
  const target = TARGETS[specifier];
  if (!target) return next(specifier, context);
  const file = resolvePath(repo, target);
  if (!existsSync(file)) {
    throw new Error(
      `${specifier}: ${file} not found. Build the omadia channel SDK and set OMADIA_REPO to the checkout root.`,
    );
  }
  return { url: pathToFileURL(file).href, shortCircuit: true };
}
