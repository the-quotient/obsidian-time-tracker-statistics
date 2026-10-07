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

export function computeCategoryBalances(
    rules: CategoryRule[],
    tracked: Map<string, number>
): Map<string, CategoryBalance> {
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

    for (const { balance, rule } of fillers) {
        let left = balance.tracked;
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
