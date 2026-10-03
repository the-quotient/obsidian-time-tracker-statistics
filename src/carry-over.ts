import { App } from "obsidian";
import TimeTrackerStatisticsPlugin from "./main";
import { Category } from "./settings";
import {
    STT_API,
    PageTrackers,
    WorkingTimeResult,
    getWorkingTimeMap,
    getDailyTarget,
    isWorkCategory,
    extractYear,
    extractMonth
} from "./statistics";

const MONTH_BLOCK_START = "```simple-time-tracker-statistics-month";
const MAX_CARRY_OVER_MONTHS = 240;

export interface MonthConfig {
    deviation: number | "auto";
    daysOff: number[];
    vacationDays: number[];
    sickDays: number[];
}

export interface MonthDetails {
    name: string;
    days: number;
}

export interface CarryOverFile {
    path: string;
    basename: string;
}

export interface CarryOverResult {
    deviation: number;
    source: CarryOverFile | null;
}

interface MarkdownFile extends CarryOverFile {
    name: string;
}
interface CarryOverVault {
    getMarkdownFiles(): MarkdownFile[];
    cachedRead(file: MarkdownFile): Promise<string>;
}

interface ChainLink {
    year: number;
    monthIndex: number;
    config: MonthConfig;
}

const monthLookupTable: MonthDetails[] = [
    { name: "January", days: 31 }, { name: "February", days: 28 },
    { name: "March", days: 31 }, { name: "April", days: 30 },
    { name: "May", days: 31 }, { name: "June", days: 30 },
    { name: "July", days: 31 }, { name: "August", days: 31 },
    { name: "September", days: 30 }, { name: "October", days: 31 },
    { name: "November", days: 30 }, { name: "December", days: 31 }
];

function isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function pad(value: number): string {
    return value < 10 ? "0" + value : String(value);
}

function parseDayList(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
        (day): day is number => typeof day === "number" && Number.isInteger(day)
    );
}

export function parseMonthConfig(blockContent: string): MonthConfig {
    const settings: Record<string, unknown> = {};
    blockContent.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length === 2) {
            const key = parts[0]?.trim() || "";
            const value = parts[1]?.trim() || "";
            try {
                settings[key] = JSON.parse(value);
            } catch {
                settings[key] = value;
            }
        }
    });

    let deviation: number | "auto" = 0;
    if (typeof settings.deviation === 'number') {
        deviation = settings.deviation;
    } else if (settings.deviation === "auto") {
        deviation = "auto";
    }

    return {
        deviation,
        daysOff: parseDayList(settings.daysOff),
        vacationDays: parseDayList(settings.vacationDays),
        sickDays: parseDayList(settings.sickDays)
    };
}

export function getMonthDetails(
    year: number,
    monthIndex: number
): MonthDetails | null {
    if (monthIndex < 1 || monthIndex > 12) return null;
    const details = monthLookupTable[monthIndex - 1];
    if (!details) return null;

    if (monthIndex === 2 && isLeapYear(year)) {
        return { name: details.name, days: 29 };
    }
    return details;
}

export function getMonthRange(
    year: number,
    monthIndex: number
): { startDate: string; endDate: string } | null {
    const details = getMonthDetails(year, monthIndex);
    if (!details) return null;
    const monthStr = pad(monthIndex);
    return {
        startDate: `${year}-${monthStr}-01`,
        endDate: `${year}-${monthStr}-${pad(details.days)}`
    };
}

export function getDayWorkAndOther(
    workingTime: WorkingTimeResult | undefined,
    categories: Category[]
): { workDuration: number; otherDuration: number } {
    let workDuration = 0, otherDuration = 0;
    if (!workingTime) return { workDuration, otherDuration };

    workingTime.fileCategories.forEach((category, index) => {
        const categorySettings = categories.find(c => c.name === category);
        const isWork = categorySettings
            ? isWorkCategory(categorySettings) : false;
        const duration = workingTime.entryDurations[index] || 0;

        if (isWork) {
            workDuration += duration;
        } else {
            otherDuration += duration;
        }
    });
    return { workDuration, otherDuration };
}

export function isTargetDay(
    year: number,
    monthIndex: number,
    day: number,
    config: MonthConfig
): boolean {
    const weekday = new Date(year, monthIndex - 1, day).getDay();
    const isWeekday = weekday !== 0 && weekday !== 6;
    return isWeekday &&
        !config.daysOff.includes(day) &&
        !config.vacationDays.includes(day) &&
        !config.sickDays.includes(day);
}

function computeMonthDeviation(
    dataMap: Map<string, WorkingTimeResult>,
    categories: Category[],
    year: number,
    monthIndex: number,
    config: MonthConfig,
    startDeviation: number
): number {
    const details = getMonthDetails(year, monthIndex);
    if (!details) return startDeviation;

    const dailyTarget = getDailyTarget(categories);
    let deviation = startDeviation;

    for (let day = 1; day <= details.days; day++) {
        const dateKey = `${year}-${pad(monthIndex)}-${pad(day)}`;
        const { workDuration } = getDayWorkAndOther(
            dataMap.get(dateKey),
            categories
        );
        deviation += workDuration;
        if (isTargetDay(year, monthIndex, day, config)) {
            deviation -= dailyTarget;
        }
    }
    return deviation;
}

function getPreviousMonth(
    year: number,
    monthIndex: number
): { year: number; monthIndex: number } {
    if (monthIndex === 1) return { year: year - 1, monthIndex: 12 };
    return { year, monthIndex: monthIndex - 1 };
}

function extractMonthBlock(content: string): string | null {
    const start = content.indexOf(MONTH_BLOCK_START);
    if (start === -1) return null;
    const bodyStart = content.indexOf("\n", start);
    if (bodyStart === -1) return null;
    const end = content.indexOf("```", bodyStart);
    return content.slice(bodyStart + 1, end === -1 ? undefined : end);
}

async function findMonthNote(
    app: App,
    year: number,
    monthIndex: number
): Promise<{ file: CarryOverFile; config: MonthConfig } | null> {
    const vault = app.vault as unknown as CarryOverVault;
    const candidates = vault.getMarkdownFiles()
        .filter(file =>
            extractYear(file.name) === year &&
            extractMonth(file.name) === monthIndex
        )
        .sort((a, b) => a.path.localeCompare(b.path));

    for (const file of candidates) {
        const block = extractMonthBlock(await vault.cachedRead(file));
        if (block !== null) {
            return { file, config: parseMonthConfig(block) };
        }
    }
    return null;
}

export async function loadMonthConfig(
    app: App,
    year: number,
    monthIndex: number
): Promise<MonthConfig | null> {
    const note = await findMonthNote(app, year, monthIndex);
    return note ? note.config : null;
}

export async function resolveCarryOver(
    plugin: TimeTrackerStatisticsPlugin,
    api: STT_API,
    pages: PageTrackers[],
    year: number,
    monthIndex: number
): Promise<CarryOverResult> {
    const chain: ChainLink[] = [];
    let anchor = 0;
    let source: CarryOverFile | null = null;
    let current = getPreviousMonth(year, monthIndex);

    for (let i = 0; i < MAX_CARRY_OVER_MONTHS; i++) {
        const note = await findMonthNote(
            plugin.app,
            current.year,
            current.monthIndex
        );
        if (!note) break;
        if (i === 0) source = note.file;

        chain.unshift({ ...current, config: note.config });
        if (note.config.deviation !== "auto") {
            anchor = note.config.deviation;
            break;
        }
        current = getPreviousMonth(current.year, current.monthIndex);
    }

    const first = chain[0];
    const last = chain[chain.length - 1];
    if (!first || !last) return { deviation: 0, source };

    const firstRange = getMonthRange(first.year, first.monthIndex);
    const lastRange = getMonthRange(last.year, last.monthIndex);
    if (!firstRange || !lastRange) return { deviation: 0, source };

    const dataMap = getWorkingTimeMap(
        pages,
        plugin,
        api,
        firstRange.startDate,
        lastRange.endDate
    );

    let deviation = anchor;
    for (const link of chain) {
        deviation = computeMonthDeviation(
            dataMap,
            plugin.settings.categories,
            link.year,
            link.monthIndex,
            link.config,
            deviation
        );
    }
    return { deviation, source };
}
