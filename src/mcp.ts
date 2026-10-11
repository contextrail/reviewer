import { packageVersion } from './version.js';
import type { ReviewReportInput } from './report-contract.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PreparationReadError, type PublishedReader } from './contracts.js';
import type { RepositoryEnvironment } from './git.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
/** Operational default per connect/read, not a measured deployment requirement. */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
export function mcpTimeoutMs(value: number | string | undefined): number {
    const timeout = value === undefined ? DEFAULT_MCP_TIMEOUT_MS : Number(value);
    // The maintained SDK and Node timers use a signed 32-bit millisecond interval.
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)
        throw new Error('MCP timeout must be an integer in milliseconds, 1..2147483647 (Node timer range).');
    return timeout;
}

export class McpPublishedReader implements PublishedReader {
    private readonly client = new Client(
        { name: 'v2-review-agent', version: packageVersion },
        { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
    );
    private connected = false;
    private connection: Promise<void> | null = null;
    private responseStatus: number | undefined;
    private readonly transport: StreamableHTTPClientTransport;
    private readonly timeoutMs: number;
    constructor(
        url: string,
        token: string,
        orgId: string,
        private readonly repository: RepositoryEnvironment,
        private readonly options: { timeoutMs?: number; signal?: AbortSignal; repositoryAttribution?: boolean } = {},
    ) {
        const endpoint = new URL(url);
        if (
            !['http:', 'https:'].includes(endpoint.protocol) ||
            endpoint.username ||
            endpoint.password ||
            endpoint.search ||
            endpoint.hash
        )
            throw new Error('Use an HTTP(S) MCP URL without credentials, query or fragment.');
        if (!token.trim() || !orgId.trim() || /[\r\n\0]/u.test(token + orgId))
            throw new Error('A valid MCP bearer token and organization ID are required.');
        this.timeoutMs = mcpTimeoutMs(options.timeoutMs ?? process.env.CONTEXTRAIL_MCP_TIMEOUT_MS);
        this.transport = new StreamableHTTPClientTransport(endpoint, {
            fetch: async (input, init) => {
                const response = await fetch(input, init);
                this.responseStatus = response.status;
                return response;
            },
            requestInit: { headers: { Authorization: `Bearer ${token}`, 'x-v2-org-id': orgId } },
        });
    }
    async read(name: Parameters<PublishedReader['read']>[0], args: Record<string, unknown>): Promise<unknown> {
        return this.call(name, args);
    }
    async submitReport(report: ReviewReportInput): Promise<unknown> {
        return this.call('submit_feedback', report);
    }
    private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
        let phase = 'connect';
        this.responseStatus = undefined;
        const requestOptions = () => ({
            timeout: this.timeoutMs,
            signal: this.options.signal
                ? AbortSignal.any([this.options.signal, AbortSignal.timeout(this.timeoutMs)])
                : AbortSignal.timeout(this.timeoutMs),
        });
        try {
            this.options.signal?.throwIfAborted();
            if (!this.connected) {
                this.connection ??= this.client.connect(this.transport, requestOptions());
                await this.connection;
                this.connected = true;
            }
            phase = 'read';
            this.responseStatus = undefined;
            const result = await this.client.callTool(
                {
                    name,
                    arguments: {
                        ...args,
                        environment: {
                            repository: this.options.repositoryAttribution
                                ? this.repository
                                : { status: 'unavailable', reason: 'withheld' },
                            harness: { status: 'reported', name: 'v2-review-agent' },
                            model: { status: 'unavailable', reason: 'not_exposed' },
                        },
                    },
                },
                requestOptions(),
            );
            if (result.isError) {
                const error = (result.structuredContent as { error?: { code?: unknown } } | undefined)?.error;
                const code =
                    typeof error?.code === 'string' && /^[a-z_]{3,80}$/u.test(error.code)
                        ? error.code
                        : 'mcp_read_rejected';
                throw new PreparationReadError(code, { phase, category: serviceCategory(code) });
            }
            phase = 'decode';
            if (result.content.length !== 1 || result.content[0]?.type !== 'text')
                throw new PreparationReadError('invalid_mcp_response', { phase });
            return JSON.parse(result.content[0].text);
        } catch (error) {
            if (error instanceof PreparationReadError) throw error;
            throw safeReadFailure(error, phase, this.options.signal?.aborted, this.responseStatus);
        }
    }
    async close(): Promise<void> {
        await this.client.close().catch(() => undefined);
    }
}
function serviceCategory(code: string): string {
    if (['graph_node_not_found', 'graph_node_unpublished', 'graph_node_published_version_missing'].includes(code))
        return 'missing_publication';
    if (
        [
            'forbidden',
            'unauthorized',
            'org_membership_required',
            'graph_node_read_forbidden',
            'graph_node_forbidden',
            'org_access_denied',
        ].includes(code)
    )
        return 'authorization';
    return 'contract_or_service_rejection';
}
/** Only controlled categories, numeric HTTP/RPC codes and recognized SDK codes survive. */
export function safeReadFailure(
    error: unknown,
    phase: string,
    cancelled = false,
    responseStatus?: number,
): PreparationReadError {
    const source =
        error && typeof error === 'object'
            ? (error as { name?: unknown; code?: unknown; status?: unknown; data?: { status?: unknown } })
            : {};
    const statusValue =
        source.status ?? source.data?.status ?? (responseStatus && responseStatus >= 400 ? responseStatus : undefined);
    const status =
        typeof statusValue === 'number' && Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599
            ? statusValue
            : undefined;
    const sdkCodes = [
        'REQUEST_TIMEOUT',
        'CLIENT_HTTP_AUTHENTICATION',
        'CLIENT_HTTP_FORBIDDEN',
        'CLIENT_HTTP_NOT_IMPLEMENTED',
        'CLIENT_HTTP_UNEXPECTED_CONTENT',
        'INVALID_RESULT',
        'CONNECTION_CLOSED',
        'ERA_NEGOTIATION_FAILED',
    ];
    const upstreamCode =
        (typeof source.code === 'string' && sdkCodes.includes(source.code)) ||
        (typeof source.code === 'number' &&
            Number.isInteger(source.code) &&
            source.code >= -32768 &&
            source.code <= 32767)
            ? (source.code as string | number)
            : undefined;
    let cause = error;
    let invalidResponse = false;
    for (let depth = 0; depth < 4 && cause && typeof cause === 'object'; depth++) {
        const nested = cause as { name?: unknown; code?: unknown; cause?: unknown };
        if (
            ['SyntaxError', 'ZodError'].includes(String(nested.name)) ||
            ['CLIENT_HTTP_UNEXPECTED_CONTENT', 'INVALID_RESULT'].includes(String(nested.code))
        )
            invalidResponse = true;
        cause = nested.cause;
    }
    const code =
        cancelled || source.name === 'AbortError'
            ? 'mcp_cancelled'
            : source.name === 'TimeoutError' || source.code === 'REQUEST_TIMEOUT'
              ? 'mcp_timeout'
              : status === 401 || source.code === 'CLIENT_HTTP_AUTHENTICATION'
                ? 'mcp_authentication_failed'
                : status === 403 || source.code === 'CLIENT_HTTP_FORBIDDEN'
                  ? 'mcp_authorization_failed'
                  : status
                    ? 'mcp_http_failed'
                    : invalidResponse || source.code === -32700
                      ? 'invalid_mcp_response'
                      : typeof source.code === 'number'
                        ? 'mcp_provider_failed'
                        : 'mcp_transport_failed';
    return new PreparationReadError(code, {
        phase,
        ...(status ? { status } : {}),
        ...(upstreamCode !== undefined ? { upstreamCode } : {}),
    });
}
