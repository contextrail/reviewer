import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewBudget, DEFAULT_EXECUTION_LIMITS } from '../src/budget.js';
afterEach(() => vi.useRealTimers());
describe('shared phase budget', () => {
    it('reserves calls synchronously across parallel workers for verification', () => {
        const budget = new ReviewBudget({ ...DEFAULT_EXECUTION_LIMITS, maxTurns: 10 });
        expect(budget.reservedTurns).toBe(4);
        for (let i = 0; i < 6; i++) expect(budget.reserve(i === 0 ? 'plan' : 'assess')).toBe(i + 1);
        expect(() => budget.reserve('assess')).toThrow('verification_calls_reserved');
        for (let i = 0; i < 4; i++) budget.reserve('verify');
        expect(() => budget.reserve('verify')).toThrow('max_turns');
    });
    it('rejects a configuration unable to start all phases', () => {
        expect(() => new ReviewBudget({ ...DEFAULT_EXECUTION_LIMITS, maxTurns: 1 })).toThrow(
            'insufficient_phase_call_budget',
        );
    });
    it('permits one investigation call and one independent check with the minimal two-call budget', () => {
        const budget = new ReviewBudget({ ...DEFAULT_EXECUTION_LIMITS, maxTurns: 2 });
        expect(budget.reserve('assess')).toBe(1);
        expect(() => budget.reserve('assess')).toThrow('verification_calls_reserved');
        expect(budget.reserve('verify')).toBe(2);
        expect(() => budget.reserve('verify')).toThrow('max_turns');
    });
    it('releases verification capacity as pipelined tasks spend it without exceeding the total cap', () => {
        const budget = new ReviewBudget({ ...DEFAULT_EXECUTION_LIMITS, maxTurns: 10 });
        expect(budget.reserve('plan')).toBe(1);
        for (let task = 0; task < 4; task++) {
            expect(budget.reserve('assess')).toBe(2 + task * 2);
            expect(budget.reserve('verify')).toBe(3 + task * 2);
        }
        expect(budget.calls).toBe(9);
        expect(budget.reserve('assess')).toBe(10);
        for (const phase of ['plan', 'assess', 'verify'] as const)
            expect(() => budget.reserve(phase)).toThrow('max_turns');
        expect(budget.calls).toBe(10);
    });
    it('counts a reserved failed verification attempt as spent capacity without waiting for usage', () => {
        const budget = new ReviewBudget({ ...DEFAULT_EXECUTION_LIMITS, maxTurns: 10 });
        for (let call = 0; call < 6; call++) budget.reserve(call === 0 ? 'plan' : 'assess');
        expect(() => budget.reserve('assess')).toThrow('verification_calls_reserved');
        // Transport can fail after reserve succeeds; no record call is required to spend this attempt.
        expect(budget.reserve('verify')).toBe(7);
        expect(() => budget.reserve('assess')).toThrow('verification_calls_reserved');
        expect(budget.reserve('verify')).toBe(8);
        expect(budget.reserve('verify')).toBe(9);
        expect(budget.reserve('verify')).toBe(10);
        expect(() => budget.reserve('verify')).toThrow('max_turns');
        expect(budget.calls).toBe(10);
    });
    it('preserves a verification deadline window without resetting elapsed time', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const budget = new ReviewBudget({ ...DEFAULT_EXECUTION_LIMITS, maxTimeMs: 1000 });
        vi.advanceTimersByTime(650);
        expect(() => budget.reserve('assess')).toThrow('verification_time_reserved');
        expect(budget.reserve('verify')).toBe(1);
        vi.advanceTimersByTime(350);
        expect(() => budget.reserve('verify')).toThrow('max_time_ms');
    });
    it('does not invent zero usage or allow a token cutoff when reporting is absent', () => {
        const budget = new ReviewBudget({ ...DEFAULT_EXECUTION_LIMITS, maxTotalTokens: 100 });
        budget.reserve('plan');
        budget.record(null);
        expect(budget.usageComplete).toBe(false);
        expect(() => budget.reserve('verify')).toThrow('total_token_limit_unmeasurable');
    });
    it('charges all completed in-flight responses and discloses an observed-token overshoot', () => {
        const budget = new ReviewBudget({ ...DEFAULT_EXECUTION_LIMITS, maxTotalTokens: 100 });
        budget.reserve('assess');
        budget.reserve('assess');
        budget.record(70);
        budget.record(70);
        expect(budget.totalTokens).toBe(140);
        expect(() => budget.reserve('verify')).toThrow('max_total_tokens');
    });
});
