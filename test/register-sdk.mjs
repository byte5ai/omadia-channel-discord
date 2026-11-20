// Test-only: resolves the host-provided peers (`@omadia/channel-sdk`,
// `@omadia/plugin-api`) to a built omadia checkout, the same way the
// typecheck `paths` do. Point OMADIA_REPO at the checkout root (default: the
// sibling `../` the tsconfig assumes) and build its channel SDK first.
import { register } from 'node:module';

register('./sdk-resolve-hooks.mjs', import.meta.url);
