import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { McpPublishedReader, DEFAULT_MCP_TIMEOUT_MS, mcpTimeoutMs, safeReadFailure } from '../src/mcp.js';

const repository = { status: 'unavailable', reason: 'no_remote' } as const;
async function endpoint(reply: (res: ServerResponse) => void) {
    const paths: string[] = [];
    const server = createServer((req, res) => {
        paths.push(req.url!);
        reply(res);
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        paths,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/company/rail`,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
describe('MCP operational configuration and safe diagnostics', () => {
    it('uses API override, environment and finite operational default without an authored ceiling', () => {
        const saved = process.env.CONTEXTRAIL_MCP_TIMEOUT_MS;
        try {
            delete process.env.CONTEXTRAIL_MCP_TIMEOUT_MS;
            expect(DEFAULT_MCP_TIMEOUT_MS).toBe(30_000);
            expect(mcpTimeoutMs(undefined)).toBe(30_000);
            process.env.CONTEXTRAIL_MCP_TIMEOUT_MS = 'invalid';
            expect(
                () =>
                    new McpPublishedReader('https://example.test/prefix/rail', 'token', 'org', repository, {
                        timeoutMs: 3_600_000,
                    }),
            ).not.toThrow();
            expect(
                () => new McpPublishedReader('https://example.test/prefix/rail', 'token', 'org', repository),
            ).toThrow('timeout');
            for (const value of ['', 0, -1, 0.5, Infinity, NaN]) expect(() => mcpTimeoutMs(value)).toThrow();
            for (const url of [
                'https://user:secret@example.test/rail',
                'https://example.test/rail?secret=x',
                'https://example.test/rail#x',
                'file:///rail',
            ])
                expect(() => new McpPublishedReader(url, 'token', 'org', repository)).toThrow();
        } finally {
            if (saved === undefined) delete process.env.CONTEXTRAIL_MCP_TIMEOUT_MS;
            else process.env.CONTEXTRAIL_MCP_TIMEOUT_MS = saved;
        }
    });
    it.each([401, 403, 429, 503])(
        'keeps HTTP %s and the configured endpoint path without raw response bodies',
        async (status) => {
            const service = await endpoint((res) => {
                res.writeHead(status);
                res.end('Authorization Bearer private-secret');
            });
            const reader = new McpPublishedReader(service.url, 'private-secret', 'org', repository, {
                timeoutMs: 2000,
            });
            try {
                const error = await reader.read('get_skill', { nodeId: 'skill://engineering/test' }).catch((e) => e);
                expect(error.code).toBe(
                    status === 401
                        ? 'mcp_authentication_failed'
                        : status === 403
                          ? 'mcp_authorization_failed'
                          : 'mcp_http_failed',
                );
                expect(error.diagnostic).toMatchObject({ status, phase: 'connect' });
                expect(service.paths).toEqual(['/company/rail']);
                expect(JSON.stringify(error)).not.toMatch(/private-secret|Bearer|Authorization/u);
            } finally {
                await reader.close();
                await service.close();
            }
        },
    );
    it('distinguishes malformed JSON and MCP from timeout and cancellation over HTTP', async () => {
        for (const body of ['{invalid', '{"jsonrpc":"2.0","result":"invalid MCP"}']) {
            const service = await endpoint((res) => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(body);
            });
            const reader = new McpPublishedReader(service.url, 'token', 'org', repository, { timeoutMs: 1000 });
            try {
                await expect(reader.read('get_skill', {})).rejects.toMatchObject({ code: 'invalid_mcp_response' });
            } finally {
                await reader.close();
                await service.close();
            }
        }
        const service = await endpoint(() => undefined);
        const reader = new McpPublishedReader(service.url, 'token', 'org', repository, { timeoutMs: 50 });
        try {
            await expect(reader.read('get_skill', {})).rejects.toMatchObject({
                code: 'mcp_timeout',
                diagnostic: { phase: 'connect' },
            });
        } finally {
            await reader.close();
            await service.close();
        }
        const controller = new AbortController();
        controller.abort('private-secret');
        const cancelled = new McpPublishedReader('https://example.test/rail', 'token', 'org', repository, {
            signal: controller.signal,
        });
        try {
            await expect(cancelled.read('get_skill', {})).rejects.toMatchObject({ code: 'mcp_cancelled' });
        } finally {
            await cancelled.close();
        }
    });
    it('keeps safe numeric provider codes and rejects arbitrary SDK data/messages', () => {
        const error = safeReadFailure({ code: -32603, message: 'secret', data: { body: 'secret' } }, 'read');
        expect(error).toMatchObject({
            code: 'mcp_provider_failed',
            diagnostic: { phase: 'read', upstreamCode: -32603 },
        });
        expect(JSON.stringify(error)).not.toContain('secret');
        expect(safeReadFailure({ code: 'arbitrary-secret', message: 'secret' }, 'read').diagnostic).toEqual({
            phase: 'read',
        });
    });
});
