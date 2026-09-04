export type Failpoint = (point: string, context?: Readonly<Record<string, unknown>>) => void;

export interface FailpointPlan {
    readonly point: string;
    readonly occurrence?: number;
    readonly error?: Error;
}

/** Deterministic crash/failure injection for state-machine and process recovery tests. */
export class DeterministicFailpoints {
    readonly #plans: FailpointPlan[];
    readonly #counts = new Map<string, number>();
    readonly trace: Array<{ point: string; occurrence: number }> = [];

    constructor(plans: readonly FailpointPlan[]) {
        this.#plans = [...plans];
    }

    readonly hit: Failpoint = (point) => {
        const occurrence = (this.#counts.get(point) ?? 0) + 1;
        this.#counts.set(point, occurrence);
        this.trace.push({ point, occurrence });
        const plan = this.#plans.find(
            (candidate) => candidate.point === point && (candidate.occurrence ?? 1) === occurrence,
        );
        if (plan !== undefined) {
            throw plan.error ?? new Error(`Injected failure at ${point}#${occurrence}`);
        }
    };
}
