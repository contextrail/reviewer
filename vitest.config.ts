import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Recursive pnpm runs independent Vitest processes concurrently.
        fsModuleCachePath: new URL('./node_modules/.vitest-cache', import.meta.url).pathname,
        environment: 'node',
        pool: 'threads',
        include: ['tests/**/*.test.ts'],
        maxWorkers: 3,
        // Independent test files own their temporary repositories.
        testTimeout: 20_000,
    },
});
