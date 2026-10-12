export interface CategoryRule {
    name: string;
    target: number;
    fills: string[];
}

export interface CategoryBalance {
    tracked: number;
    target: number;
    remaining: number;
    overtime: number;
    given: Map<string, number>;
    received: Map<string, number>;
}

/** Tracked time of one category, as one piece in the order it was tracked. */
export interface TrackedPiece {
    category: string;
    duration: number;
}

/**
 * Remaining time and overtime per category. Fillers give their time in the
 * order it was tracked, so a target filled earlier is not taken over by time
 * tracked later.
 */
export function computeCategoryBalances(
    rules: CategoryRule[],
    pieces: TrackedPiece[]
): Map<string, CategoryBalance> {
    const tracked = new Map<string, number>();
    for (const { category, duration } of pieces) {
        tracked.set(category, (tracked.get(category) ?? 0) + duration);
    }
    const balances = new Map<string, CategoryBalance>();
    for (const rule of rules) {
        if (balances.has(rule.name)) continue;
        balances.set(rule.name, {
            tracked: tracked.get(rule.name) ?? 0,
            target: rule.target,
            remaining: rule.target,
            overtime: 0,
            given: new Map(),
            received: new Map()
        });
    }

    const fillers: { balance: CategoryBalance; rule: CategoryRule }[] = [];
    for (const rule of rules) {
        const balance = balances.get(rule.name);
        if (!balance || fillers.some(f => f.balance === balance)) continue;
        if (rule.fills.some(name => name !== rule.name && balances.has(name))) {
            fillers.push({ balance, rule });
        } else {
            credit(balance, balance.tracked);
        }
    }

    for (const { category, duration } of pieces) {
        const filler = fillers.find(f => f.rule.name === category);
        if (!filler) continue;
        const { balance, rule } = filler;
        let left = duration;
        for (const name of rule.fills) {
            const target = balances.get(name);
            if (!target || target === balance) continue;
            const used = Math.min(left, target.remaining);
            if (used <= 0) continue;
            target.remaining -= used;
            target.received.set(rule.name,
                (target.received.get(rule.name) ?? 0) + used);
            balance.given.set(name, (balance.given.get(name) ?? 0) + used);
            left -= used;
        }
        credit(balance, left);
    }
    return balances;
}

function credit(balance: CategoryBalance, time: number): void {
    const used = Math.min(time, balance.remaining);
    balance.remaining -= used;
    balance.overtime += time - used;
}
