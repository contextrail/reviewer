import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        pool: 'threads',
        include: ['tests/**/*.test.ts'],
        maxWorkers: 3,
        // Independent test files own their temporary repositories.
        testTimeout: 20_000,
    },
});
