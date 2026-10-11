import { readFileSync } from 'node:fs';

// Both src/ and dist/ resolve the prepared package manifest at the public root.
export const packageVersion: string = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
