export type ModelPhase = 'plan' | 'assess' | 'verify';
export type ExecutionLimits = {
    maxTurns: number | null;
    maxOutputTokens: number | null;
    maxTotalTokens: number | null;
    maxTimeMs: number | null;
};
export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
    maxTurns: null,
    maxOutputTokens: null,
    maxTotalTokens: null,
    maxTimeMs: null,
};
export class BudgetStop extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}
/** Synchronous reservations precede transport, including simultaneous workers and failed calls. */
export class ReviewBudget {
    readonly started = Date.now();
    readonly reservedTurns: number;
    private verificationCalls = 0;
    calls = 0;
    totalTokens = 0;
    usageComplete = true;
    constructor(readonly limits: ExecutionLimits) {
        for (const value of Object.values(limits))
            if (value !== null && (!Number.isSafeInteger(value) || value < 1))
                throw new Error('invalid_execution_limit');
        if (limits.maxTimeMs !== null && limits.maxTimeMs > 2147483647)
            throw new Error('invalid_time_limit_node_timer');
        this.reservedTurns = limits.maxTurns === null ? 0 : Math.max(1, Math.ceil(limits.maxTurns * 0.35));
        if (limits.maxTurns !== null && limits.maxTurns - this.reservedTurns < 1)
            throw new Error('insufficient_phase_call_budget');
    }
    remainingMs(phase: ModelPhase) {
        return this.limits.maxTimeMs === null
            ? null
            : Math.max(0, this.started + this.limits.maxTimeMs * (phase === 'verify' ? 1 : 0.65) - Date.now());
    }
    reserve(phase: ModelPhase) {
        const remaining = this.remainingMs(phase);
        if (remaining !== null && remaining <= 0)
            throw new BudgetStop(phase === 'verify' ? 'max_time_ms' : 'verification_time_reserved');
        if (this.limits.maxTotalTokens !== null) {
            if (!this.usageComplete) throw new BudgetStop('total_token_limit_unmeasurable');
            if (this.totalTokens >= this.limits.maxTotalTokens) throw new BudgetStop('max_total_tokens');
        }
        const heldTurns = phase === 'verify' ? 0 : Math.max(0, this.reservedTurns - this.verificationCalls);
        if (this.limits.maxTurns !== null && this.calls >= this.limits.maxTurns - heldTurns)
            throw new BudgetStop(heldTurns === 0 ? 'max_turns' : 'verification_calls_reserved');
        if (phase === 'verify') this.verificationCalls++;
        return ++this.calls;
    }
    record(totalTokens: number | null) {
        if (totalTokens === null) this.usageComplete = false;
        else this.totalTokens += totalTokens;
    }
}
