import { DayOffType } from "./carry-over";
import { isWeekend } from "./period-view";
import { TimeTrackerStatisticsSettings } from "./settings";

const MAX_CARRY_OVER_YEARS = 100;

export interface VacationBalance {
    used: number;
    allowance: number;
    /** Days left from the years before, negative if they were overdrawn. */
    carried: number;
}

/** Counts the vacation days of `year` that fall on weekdays. */
export function countVacationDays(
    year: number,
    getType: (day: Date) => DayOffType | null
): number {
    let count = 0;
    for (
        let day = new Date(year, 0, 1);
        day.getFullYear() === year;
        day = new Date(year, day.getMonth(), day.getDate() + 1)
    ) {
        if (!isWeekend(day) && getType(day) === "vacationDays") {
            count++;
        }
    }
    return count;
}

/**
 * Vacation days carried into `year`: from the first counted year on, each
 * year passes on its allowance plus what it received minus what it used.
 */
export async function getCarriedVacation(
    settings: TimeTrackerStatisticsSettings,
    year: number,
    countUsed: (year: number) => Promise<number>
): Promise<number> {
    const allowance = settings.vacationDaysPerYear;
    const first = settings.vacationFirstYear;
    if (!settings.vacationCarryOver || allowance <= 0 || year < first) {
        return 0;
    }
    let carried = settings.vacationCarriedIntoFirstYear;
    const from = Math.max(first, year - MAX_CARRY_OVER_YEARS);
    for (let y = from; y < year; y++) {
        carried = allowance + carried - await countUsed(y);
    }
    return carried;
}

/** "6", "6 of 30 · 24 left" or "6 of 35 (30 + 5 carried over) · 29 left". */
export function formatVacationBalance(balance: VacationBalance): string {
    const { used, allowance, carried } = balance;
    if (allowance <= 0) return String(used);
    const total = allowance + carried;
    const left = total - used;
    const parts = carried === 0 ? "" : ` (${allowance} ` +
        (carried > 0 ? `+ ${carried}` : `− ${-carried}`) + " carried over)";
    return `${used} of ${total}${parts} · ` +
        (left >= 0 ? `${left} left` : `${-left} over`);
}
