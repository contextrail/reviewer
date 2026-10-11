// /eslint/shared.mjs
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettierPlugin from 'eslint-plugin-prettier';

export default [
    // Global ignores
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/build/**',
            '**/out/**',
            '**/coverage/**',
            '**/generated-api-hooks.ts',
            '**/orval-v2-client.ts',
        ],
    },

    // Base JS
    js.configs.recommended,

    // Shared TS + Prettier (no env/globals here)
    {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
            parser: tsParser,
            parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
        },
        plugins: { '@typescript-eslint': tsPlugin, prettier: prettierPlugin },
        rules: {
            'no-undef': 'off', // TS handles type-space identifiers (NodeJS, RequestInit)
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/no-explicit-any': 'error',
            'no-console': ['warn', { allow: ['warn', 'error', 'debug', 'info'] }],
            'prettier/prettier': 'error',
        },
    },
];
