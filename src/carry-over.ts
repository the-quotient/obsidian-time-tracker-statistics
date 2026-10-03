import { App, TFile, normalizePath } from "obsidian";
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

export type DayOffType = "daysOff" | "vacationDays" | "sickDays";

export const DAY_OFF_TYPES: { type: DayOffType; label: string }[] = [
    { type: "daysOff", label: "Day off" },
    { type: "vacationDays", label: "Vacation" },
    { type: "sickDays", label: "Sick" }
];

export interface MonthNote {
    file: CarryOverFile;
    config: MonthConfig;
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
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-` +
        pad(now.getDate());
    let deviation = startDeviation;

    for (let day = 1; day <= details.days; day++) {
        const dateKey = `${year}-${pad(monthIndex)}-${pad(day)}`;
        const { workDuration } = getDayWorkAndOther(
            dataMap.get(dateKey),
            categories
        );
        deviation += workDuration;
        if (isTargetDay(year, monthIndex, day, config) &&
            dateKey <= todayKey) {
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

function locateMonthBlock(
    content: string
): { start: number; end: number } | null {
    const fence = content.indexOf(MONTH_BLOCK_START);
    if (fence === -1) return null;
    const bodyStart = content.indexOf("\n", fence);
    if (bodyStart === -1) return null;
    const end = content.indexOf("```", bodyStart);
    return { start: bodyStart + 1, end: end === -1 ? content.length : end };
}

function extractMonthBlock(content: string): string | null {
    const block = locateMonthBlock(content);
    return block ? content.slice(block.start, block.end) : null;
}

export async function findMonthNote(
    app: App,
    year: number,
    monthIndex: number
): Promise<MonthNote | null> {
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

export function getDayOffType(
    config: MonthConfig,
    day: number
): DayOffType | null {
    const match = DAY_OFF_TYPES.find(({ type }) => config[type].includes(day));
    return match ? match.type : null;
}

function formatDayList(days: number[]): string {
    return `[${days.join(", ")}]`;
}

function writeDayLists(body: string, config: MonthConfig): string {
    const lines = body.split("\n");
    const missing = new Set<DayOffType>(DAY_OFF_TYPES.map(({ type }) => type));
    const updated = lines.map(line => {
        const parts = line.split("=");
        const key = parts[0]?.trim() as DayOffType;
        if (parts.length !== 2 || !missing.has(key)) return line;
        missing.delete(key);
        return `${key} = ${formatDayList(config[key])}`;
    });

    let insertAt = updated.length;
    while (insertAt > 0 && updated[insertAt - 1]?.trim() === "") insertAt--;
    updated.splice(
        insertAt,
        0,
        ...Array.from(missing, key => `${key} = ${formatDayList(config[key])}`)
    );
    return updated.join("\n");
}

function createMonthBlock(config: MonthConfig): string {
    return MONTH_BLOCK_START + "\n" +
        writeDayLists("deviation = auto\n", config) + "```\n";
}

function writeMonthConfig(content: string, config: MonthConfig): string {
    const block = locateMonthBlock(content);
    if (!block) {
        const separator = content === "" || content.endsWith("\n\n") ? ""
            : content.endsWith("\n") ? "\n" : "\n\n";
        return content + separator + createMonthBlock(config);
    }
    let body = writeDayLists(content.slice(block.start, block.end), config);
    if (!body.endsWith("\n")) body += "\n";
    const closing = block.end === content.length ? "```\n" : "";
    return content.slice(0, block.start) + body + closing +
        content.slice(block.end);
}

async function ensureFolder(app: App, folder: string): Promise<void> {
    if (folder === "/" || app.vault.getAbstractFileByPath(folder)) return;
    await app.vault.createFolder(folder);
}

export async function setDayOffType(
    plugin: TimeTrackerStatisticsPlugin,
    year: number,
    monthIndex: number,
    day: number,
    dayType: DayOffType | null
): Promise<MonthNote> {
    const app = plugin.app;
    const note = await findMonthNote(app, year, monthIndex);
    const base: MonthConfig = note?.config ??
        { deviation: "auto", daysOff: [], vacationDays: [], sickDays: [] };

    const config: MonthConfig = { ...base };
    for (const { type } of DAY_OFF_TYPES) {
        const days = base[type].filter(d => d !== day);
        if (type === dayType) days.push(day);
        config[type] = days.sort((a, b) => a - b);
    }

    const folder = normalizePath(plugin.settings.monthlyNotesFolder || "/");
    const name = `${year}-${pad(monthIndex)}.md`;
    const path = note?.file.path ??
        normalizePath(folder === "/" ? name : `${folder}/${name}`);

    const existing = app.vault.getAbstractFileByPath(path);
    let file: TFile;
    if (existing instanceof TFile) {
        await app.vault.process(existing, content =>
            writeMonthConfig(content, config));
        file = existing;
    } else if (existing) {
        throw new Error(`"${path}" is not a file.`);
    } else {
        await ensureFolder(app, folder);
        file = await app.vault.create(path, createMonthBlock(config));
    }
    return { file, config };
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
