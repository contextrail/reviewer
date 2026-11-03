/** Provider payloads are inspected transiently; diagnostic output is a fixed vocabulary and counts. */
export const PROVIDER_FAILURE_CODES = [
    'provider_credit_limit',
    'provider_credential_invalid',
    'provider_rate_limited',
    'provider_permission_denied',
    'provider_schema_invalid',
    'provider_context_limit',
    'provider_request_too_large',
    'provider_parameter_unsupported',
    'provider_model_unavailable',
    'provider_timeout',
    'provider_unavailable',
    'provider_request_failed',
] as const;
export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

const errorBytesLimit = 64 * 1024;
const requestBytesLimit = 4 * 1024 * 1024;
const parameterNames = new Set([
    'tools',
    'response_format',
    'max_tokens',
    'max_completion_tokens',
    'max_output_tokens',
    'reasoning_effort',
    'temperature',
    'top_p',
    'messages',
    'input',
    'model',
    'tool_choice',
    'parallel_tool_calls',
    'stream',
]);
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : null;
}
function parseBody(body: unknown, limit: number) {
    if (body === null || body === undefined || body === '') return { value: null, format: 'empty' as const };
    if (typeof body !== 'string')
        return { value: object(body), format: object(body) ? ('object' as const) : ('non_json' as const) };
    if (Buffer.byteLength(body, 'utf8') > limit) return { value: null, format: 'too_large' as const };
    try {
        return { value: object(JSON.parse(body)), format: 'json' as const };
    } catch {
        return { value: null, format: 'non_json' as const };
    }
}

const rules: ReadonlyArray<{
    code: ProviderFailureCode;
    reason: string;
    codes: readonly string[];
    message: RegExp;
}> = [
    {
        code: 'provider_context_limit',
        reason: 'context_length_exceeded',
        codes: ['context_length_exceeded', 'context_window_exceeded'],
        message: /\b(?:maximum context length|context (?:length|window).{0,40}(?:exceed|limit)|too many tokens)\b/iu,
    },
    {
        code: 'provider_request_too_large',
        reason: 'request_too_large',
        codes: ['request_too_large', 'payload_too_large'],
        message: /\b(?:request|payload|body) (?:is )?too large\b/iu,
    },
    {
        code: 'provider_schema_invalid',
        reason: 'invalid_schema',
        codes: ['invalid_json_schema', 'invalid_function_parameters'],
        message: /\binvalid (?:json |function |tool )?schema\b/iu,
    },
    {
        code: 'provider_parameter_unsupported',
        reason: 'unsupported_parameter',
        codes: ['unsupported_parameter', 'unsupported_value'],
        message: /\b(?:unsupported (?:parameter|value)|(?:parameter|argument).{0,80}(?:not supported|unsupported))\b/iu,
    },
    {
        code: 'provider_model_unavailable',
        reason: 'model_unavailable',
        codes: ['model_not_found', 'model_not_available'],
        message: /\b(?:model.{0,80}(?:not found|does not exist|not available)|no endpoints found)\b/iu,
    },
    {
        code: 'provider_credit_limit',
        reason: 'credit_limit',
        codes: ['insufficient_quota', 'insufficient_credits'],
        message: /\b(?:key spending limit exceeded|insufficient (?:quota|credits))\b/iu,
    },
];

function errorRecords(body: ObjectValue | null): ObjectValue[] {
    const records: ObjectValue[] = [];
    let current = body;
    for (let depth = 0; current && depth < 3; depth++) {
        const error = object(current.error) ?? current;
        records.push(error);
        const raw = object(error.metadata)?.raw;
        current = parseBody(raw, errorBytesLimit).value;
    }
    return records;
}

function classification(status: number, records: ObjectValue[]) {
    const fixed: Record<number, [ProviderFailureCode, string]> = {
        401: ['provider_credential_invalid', 'credential_invalid'],
        402: ['provider_credit_limit', 'credit_limit'],
        408: ['provider_timeout', 'request_timeout'],
        413: ['provider_request_too_large', 'request_too_large'],
        429: ['provider_rate_limited', 'rate_limited'],
    };
    if (fixed[status]) return { code: fixed[status][0], reason: fixed[status][1], evidence: 'http_status' as const };
    if (status >= 500 && status <= 599)
        return {
            code: 'provider_unavailable' as const,
            reason: 'service_unavailable',
            evidence: 'http_status' as const,
        };
    for (const record of records) {
        for (const rule of rules) {
            if (typeof record.code === 'string' && rule.codes.includes(record.code))
                return { code: rule.code, reason: rule.reason, evidence: 'structured_code' as const };
            if (typeof record.message === 'string' && rule.message.test(record.message.slice(0, 4096)))
                return { code: rule.code, reason: rule.reason, evidence: 'message_pattern' as const };
        }
    }
    if (status === 403)
        return {
            code: 'provider_permission_denied' as const,
            reason: 'permission_denied',
            evidence: 'http_status' as const,
        };
    return { code: 'provider_request_failed' as const, reason: 'unknown', evidence: 'unknown' as const };
}

/** Never retain arbitrary provider codes, parameters, messages, metadata, or response bodies. */
export function providerHttpDiagnostics(status: number, body: unknown) {
    const parsed = parseBody(body, errorBytesLimit);
    const records = errorRecords(parsed.value);
    const parameter = records
        .map((record) => record.param)
        .find((value) => typeof value === 'string' && parameterNames.has(value));
    return {
        ...classification(status, records),
        parameter: typeof parameter === 'string' ? parameter : null,
        bodyFormat: parsed.format,
    };
}
export function providerHttpFailure(status: number, body: unknown): ProviderFailureCode {
    return providerHttpDiagnostics(status, body).code;
}

function nonnegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/** Count the serialized wire request without retaining input, tool descriptions, schema properties or model IDs. */
export function providerRequestDiagnostics(body: unknown) {
    const text =
        typeof body === 'string' ? body : body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : null;
    const requestBytes =
        typeof body === 'string'
            ? Buffer.byteLength(body, 'utf8')
            : body instanceof Uint8Array
              ? body.byteLength
              : null;
    const parsed = parseBody(text, requestBytesLimit);
    const value = parsed.value;
    const messages = value?.messages ?? value?.input;
    const tools = value?.tools;
    return {
        requestBytes,
        messageCount: Array.isArray(messages) ? messages.length : null,
        toolCount: Array.isArray(tools) ? tools.length : null,
        toolSchemaBytes: Array.isArray(tools)
            ? Buffer.byteLength(
                  JSON.stringify(
                      tools.map((tool) => {
                          const entry = object(tool);
                          return object(entry?.function)?.parameters ?? entry?.parameters ?? null;
                      }),
                  ),
                  'utf8',
              )
            : null,
        maxOutputTokens: nonnegativeInteger(
            value?.max_output_tokens ?? value?.max_completion_tokens ?? value?.max_tokens,
        ),
        requestFormat: text === null ? 'unavailable' : parsed.format,
    };
}

/** Transport diagnoses are observed exception codes, never inferred from arbitrary error prose. */
export function providerTransportDiagnostics(error: unknown) {
    const known: Record<string, string> = {
        ENOTFOUND: 'dns_not_found',
        EAI_AGAIN: 'dns_temporary_failure',
        ECONNREFUSED: 'connection_refused',
        ECONNRESET: 'connection_reset',
        EPIPE: 'connection_closed',
        ETIMEDOUT: 'timeout',
        UND_ERR_CONNECT_TIMEOUT: 'connect_timeout',
        UND_ERR_HEADERS_TIMEOUT: 'headers_timeout',
        UND_ERR_BODY_TIMEOUT: 'body_timeout',
        UND_ERR_SOCKET: 'socket_failure',
    };
    let current = object(error);
    for (let depth = 0; current && depth < 5; depth++) {
        if (current.name === 'AbortError') return { transport: 'aborted' };
        if (current.name === 'TimeoutError') return { transport: 'timeout' };
        if (typeof current.code === 'string' && Object.hasOwn(known, current.code))
            return { transport: known[current.code] };
        current = object(current.cause);
    }
    return { transport: 'unknown' };
}

/** Inspect a bounded clone; preserve the original response for the SDK and never mask its failure. */
export async function providerResponseDiagnostics(response: Response) {
    const fallback = providerHttpDiagnostics(response.status, null);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        reader = response.clone().body?.getReader();
        if (!reader) return fallback;
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > errorBytesLimit) {
                // A tee cancellation can wait for the SDK's original stream; do not await it here.
                void reader.cancel().catch(() => undefined);
                return { ...fallback, bodyFormat: 'too_large' as const };
            }
            chunks.push(chunk.value);
        }
        return providerHttpDiagnostics(response.status, Buffer.concat(chunks).toString('utf8'));
    } catch {
        return { ...fallback, bodyFormat: 'unreadable' as const };
    } finally {
        reader?.releaseLock();
    }
}
