import { App, moment } from "obsidian";
import { Category } from "./settings";
import {
    TrackedEntry,
    getDailyTarget,
    isWorkCategory
} from "./statistics";
import {
    DAY_OFF_TYPES,
    DayOffType,
    MonthConfig,
    MonthNote,
    findMonthNote,
    getDayOffType,
    isTargetDay
} from "./carry-over";
import {
    BarDatum,
    ChartSeries,
    ChartTooltip,
    DonutSlice,
    HeatCell,
    renderDonutChart,
    renderEmpty,
    renderHeatmap,
    renderLegend,
    renderStackedBarChart
} from "./charts";

export type PeriodType = "year" | "month" | "week" | "day";
export type DistributionMode = "category" | "note";

interface PeriodMoment {
    format(fmt: string): string;
    locale(locale: string): PeriodMoment;
    isoWeek(): number;
    week(): number;
}
type PeriodMomentFactory = (input: Date) => PeriodMoment;
export const toMoment = moment as unknown as PeriodMomentFactory;

export interface PeriodRange {
    start: Date;
    end: Date;
    days: Date[];
}

export interface PeriodStats {
    entries: TrackedEntry[];
    total: number;
    work: number;
    target: number;
    targetIsPartial: boolean;
    activeDays: number;
    byDay: Map<string, Map<string, number>>;
    byCategory: Map<string, number>;
    byNote: Map<string, { name: string; duration: number }>;
    hourly: Map<string, number>;
}

export const PERIODS: { type: PeriodType; label: string }[] = [
    { type: "year", label: "Year" },
    { type: "month", label: "Month" },
    { type: "week", label: "Week" },
    { type: "day", label: "Day" }
];

const SERIES_SLOTS = 8;
const MAX_NOTE_SLICES = 7;
const DAY_MS = 86400000;

export function pad(value: number): string {
    return value < 10 ? "0" + value : String(value);
}

export function toDateKey(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-` +
        pad(date.getDate());
}

export function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function startOfWeek(date: Date, firstDayOfWeek: number): Date {
    const offset = (date.getDay() - firstDayOfWeek + 7) % 7;
    return addDays(date, -offset);
}

function daysBetween(start: Date, end: Date): Date[] {
    const days: Date[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
        days.push(d);
    }
    return days;
}

export function getPeriodRange(
    period: PeriodType,
    anchor: Date,
    firstDayOfWeek: number
): PeriodRange {
    let start: Date;
    let end: Date;
    switch (period) {
        case "year":
            start = new Date(anchor.getFullYear(), 0, 1);
            end = new Date(anchor.getFullYear(), 11, 31);
            break;
        case "month":
            start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
            end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
            break;
        case "week":
            start = startOfWeek(anchor, firstDayOfWeek);
            end = addDays(start, 6);
            break;
        default:
            start = startOfDay(anchor);
            end = start;
    }
    return { start, end, days: daysBetween(start, end) };
}

/** The days of the week of `day` up to and including `day`. */
export function getWeekToDateRange(
    day: Date,
    firstDayOfWeek: number
): PeriodRange {
    const start = startOfWeek(startOfDay(day), firstDayOfWeek);
    const end = startOfDay(day);
    return { start, end, days: daysBetween(start, end) };
}

export function getWeekNumber(date: Date, firstDayOfWeek: number): number {
    const m = toMoment(date);
    return firstDayOfWeek === 1 ? m.isoWeek() : m.locale("en").week();
}

/**
 * First day of the given week, numbered like getWeekNumber: ISO weeks
 * (week 1 contains 4 January) when weeks start on Monday, otherwise US weeks
 * (week 1 contains 1 January).
 */
export function getWeekStart(
    year: number,
    week: number,
    firstDayOfWeek: number
): Date {
    const reference = new Date(year, 0, firstDayOfWeek === 1 ? 4 : 1);
    return addDays(startOfWeek(reference, firstDayOfWeek), (week - 1) * 7);
}

export function hourKey(dateKey: string, hour: number, category: string): string {
    return `${dateKey}|${hour}|${category}`;
}

export function getDayOffLabel(type: DayOffType): string {
    return DAY_OFF_TYPES.find(t => t.type === type)?.label ?? type;
}

function getEmptyMonthConfig(): MonthConfig {
    return { deviation: 0, daysOff: [], vacationDays: [], sickDays: [] };
}

function monthKey(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth() + 1}`;
}

export function isSameMonth(a: Date, b: Date): boolean {
    return monthKey(a) === monthKey(b);
}

export interface CachedMonth {
    config: MonthConfig;
    path: string | null;
}

/** Month configs (days off, vacation, sick days) read from the monthly notes. */
export class MonthConfigCache {
    private months = new Map<string, CachedMonth>();

    constructor(private app: App) {}

    clear(): void {
        this.months.clear();
    }

    async load(days: Date[]): Promise<void> {
        for (const day of days) {
            const key = monthKey(day);
            if (this.months.has(key)) continue;
            const note = await findMonthNote(
                this.app,
                day.getFullYear(),
                day.getMonth() + 1
            );
            this.months.set(key, note
                ? { config: note.config, path: note.file.path }
                : { config: getEmptyMonthConfig(), path: null });
        }
    }

    get(day: Date): CachedMonth {
        return this.months.get(monthKey(day)) ??
            { config: getEmptyMonthConfig(), path: null };
    }

    set(day: Date, note: MonthNote): void {
        this.months.set(monthKey(day), {
            config: note.config,
            path: note.file.path
        });
    }

    getDayType(day: Date): DayOffType | null {
        return getDayOffType(this.get(day).config, day.getDate());
    }

    isTargetDay(day: Date): boolean {
        return isTargetDay(
            day.getFullYear(),
            day.getMonth() + 1,
            day.getDate(),
            this.get(day).config
        );
    }

    /** Daily target per date key for every target day in `days`. */
    getDayTargets(days: Date[], categories: Category[]): Map<string, number> {
        const dailyTarget = getDailyTarget(categories);
        const targets = new Map<string, number>();
        if (dailyTarget <= 0) return targets;

        for (const day of days) {
            if (this.isTargetDay(day)) {
                targets.set(toDateKey(day), dailyTarget);
            }
        }
        return targets;
    }
}

function addHourly(
    hourly: Map<string, number>,
    entry: TrackedEntry,
    startKey: string,
    endKey: string
): void {
    const start = new Date(entry.startTime).getTime();
    const end = entry.endTime
        ? new Date(entry.endTime).getTime()
        : Date.now();
    if (isNaN(start) || isNaN(end) || end <= start) return;

    let cursor = start;
    while (cursor < end) {
        const current = new Date(cursor);
        const nextHour = new Date(current);
        nextHour.setHours(current.getHours() + 1, 0, 0, 0);
        const sliceEnd = Math.min(end, nextHour.getTime());
        const dateKey = toDateKey(current);
        if (dateKey > endKey) break;
        if (dateKey >= startKey) {
            const key = hourKey(dateKey, current.getHours(), entry.category);
            hourly.set(key, (hourly.get(key) ?? 0) + sliceEnd - cursor);
        }
        cursor = sliceEnd;
    }
}

export function computePeriodStats(
    entries: TrackedEntry[],
    categories: Category[],
    range: PeriodRange,
    dayTargets: Map<string, number>
): PeriodStats {
    const startKey = toDateKey(range.start);
    const endKey = toDateKey(range.end);
    const todayKey = toDateKey(new Date());
    const workCategories = new Set(
        categories.filter(isWorkCategory).map(c => c.name)
    );

    const stats: PeriodStats = {
        entries: [],
        total: 0,
        work: 0,
        target: 0,
        targetIsPartial: endKey > todayKey,
        activeDays: 0,
        byDay: new Map(),
        byCategory: new Map(),
        byNote: new Map(),
        hourly: new Map()
    };

    for (const [dateKey, target] of dayTargets) {
        if (dateKey <= todayKey) stats.target += target;
    }

    const hourlyStartKey = toDateKey(addDays(range.start, -1));
    for (const entry of entries) {
        if (entry.dateKey >= hourlyStartKey && entry.dateKey <= endKey) {
            addHourly(stats.hourly, entry, startKey, endKey);
        }
        if (entry.dateKey < startKey || entry.dateKey > endKey) continue;

        stats.entries.push(entry);
        stats.total += entry.duration;
        if (workCategories.has(entry.category)) {
            stats.work += entry.duration;
        }

        let day = stats.byDay.get(entry.dateKey);
        if (!day) {
            day = new Map();
            stats.byDay.set(entry.dateKey, day);
        }
        day.set(entry.category, (day.get(entry.category) ?? 0) +
            entry.duration);

        stats.byCategory.set(
            entry.category,
            (stats.byCategory.get(entry.category) ?? 0) + entry.duration
        );

        const note = stats.byNote.get(entry.path) ??
            { name: entry.pageName, duration: 0 };
        note.duration += entry.duration;
        stats.byNote.set(entry.path, note);
    }

    for (const day of stats.byDay.values()) {
        let sum = 0;
        for (const value of day.values()) sum += value;
        if (sum > 0) stats.activeDays++;
    }
    return stats;
}

export function getSeries(
    categories: Category[],
    stats: PeriodStats
): ChartSeries[] {
    const series: ChartSeries[] = [];
    categories.forEach((category: Category, index: number) => {
        if (!stats.byCategory.get(category.name)) return;
        if (series.some(s => s.key === category.name)) return;
        series.push({
            key: category.name,
            label: category.name || "Unnamed",
            colorClass: index < SERIES_SLOTS
                ? `stt-series-${index + 1}` : "stt-series-other"
        });
    });
    for (const name of stats.byCategory.keys()) {
        if (series.some(s => s.key === name)) continue;
        series.push({
            key: name,
            label: name,
            colorClass: "stt-series-other"
        });
    }
    return series;
}

export function createCard(parent: HTMLElement, title: string): HTMLElement {
    const card = parent.createDiv({ cls: "stt-card" });
    const header = card.createDiv({ cls: "stt-card-header" });
    header.createEl("h4", { text: title });
    return card;
}

export interface PeriodChartsOptions {
    period: PeriodType;
    range: PeriodRange;
    stats: PeriodStats;
    series: ChartSeries[];
    dayTargets: Map<string, number>;
    firstDayOfWeek: number;
    tooltip: ChartTooltip;
    format: (ms: number) => string;
    getDayType: (day: Date) => DayOffType | null;
    onSelect: (period: PeriodType, anchor: Date) => void;
    distributionMode: DistributionMode;
    onDistributionModeChange: (mode: DistributionMode) => void;
}

function getHeatmapTitle(period: PeriodType): string {
    switch (period) {
        case "year": return "Daily activity";
        case "month": return "Calendar";
        case "week": return "Hours by day";
        default: return "Hours by category";
    }
}

function getBarTitle(period: PeriodType): string {
    switch (period) {
        case "year": return "Time per month";
        case "month":
        case "week": return "Time per day";
        default: return "Time per hour";
    }
}

function weekdayLabels(firstDayOfWeek: number): string[] {
    const first = startOfWeek(new Date(), firstDayOfWeek);
    return [0, 1, 2, 3, 4, 5, 6].map(i =>
        toMoment(addDays(first, i)).format("ddd")
    );
}

function dayTotal(stats: PeriodStats, dateKey: string): number {
    const day = stats.byDay.get(dateKey);
    if (!day) return 0;
    let sum = 0;
    for (const value of day.values()) sum += value;
    return sum;
}

/** Heatmap card of the period: calendar, hours by day or hours by category. */
export function renderHeatmapCard(
    parent: HTMLElement,
    options: PeriodChartsOptions
): void {
    const { period, range, stats, series, tooltip, format } = options;
    const card = createCard(parent, getHeatmapTitle(period));
    const firstDay = options.firstDayOfWeek;
    const hourLabels = Array.from({ length: 24 }, (_, h) =>
        h % 3 === 0 ? pad(h) : "");

    if (period === "year" || period === "month") {
        const isYear = period === "year";
        const gridStart = startOfWeek(range.start, firstDay);
        const cells: HeatCell[] = range.days.map(day => {
            const index = Math.round(
                (startOfDay(day).getTime() - gridStart.getTime()) / DAY_MS
            );
            const week = Math.floor(index / 7);
            const weekday = index % 7;
            const dayType = options.getDayType(day);
            return {
                row: isYear ? weekday : week,
                col: isYear ? week : weekday,
                value: dayTotal(stats, toDateKey(day)),
                title: toMoment(day).format("ddd, D MMM YYYY"),
                text: isYear ? undefined : String(day.getDate()),
                detail: dayType ? getDayOffLabel(dayType) : undefined,
                marked: dayType !== null,
                onClick: () => options.onSelect("day", day)
            };
        });
        const weeks = Math.max(...cells.map(c => isYear ? c.col : c.row)) + 1;
        const weekdays = weekdayLabels(firstDay);

        if (isYear) {
            const colLabels = Array.from({ length: weeks }, () => "");
            for (let month = 0; month < 12; month++) {
                const first = new Date(range.start.getFullYear(), month, 1);
                const index = Math.round(
                    (first.getTime() - gridStart.getTime()) / DAY_MS
                );
                const col = Math.floor(index / 7);
                colLabels[col] = toMoment(first).format("MMM");
            }
            renderHeatmap(card, {
                rowLabels: weekdays.map((d, i) => i % 2 === 0 ? d : ""),
                colLabels,
                cells,
                cellSize: 12,
                tooltip,
                format,
                ariaLabel: "Tracked time per day of the year"
            });
        } else {
            const rowLabels = Array.from({ length: weeks }, (_, w) =>
                `W${getWeekNumber(addDays(gridStart, w * 7), firstDay)}`);
            renderHeatmap(card, {
                rowLabels,
                colLabels: weekdays,
                cells,
                cellSize: 40,
                tooltip,
                format,
                ariaLabel: "Tracked time per day of the month"
            });
        }
        return;
    }

    if (period === "week") {
        const cells: HeatCell[] = [];
        range.days.forEach((day, row) => {
            const dateKey = toDateKey(day);
            for (let hour = 0; hour < 24; hour++) {
                const value = series.reduce((sum, s) => sum +
                    (stats.hourly.get(hourKey(dateKey, hour, s.key)) ?? 0), 0);
                cells.push({
                    row,
                    col: hour,
                    value,
                    title: `${toMoment(day).format("ddd, D MMM")} · ` +
                        `${pad(hour)}:00–${pad((hour + 1) % 24)}:00`,
                    onClick: () => options.onSelect("day", day)
                });
            }
        });
        renderHeatmap(card, {
            rowLabels: range.days.map(d => toMoment(d).format("ddd D")),
            colLabels: hourLabels,
            cells,
            cellSize: 20,
            tooltip,
            format,
            ariaLabel: "Tracked time per hour of the week",
            rowLabelWidth: 52
        });
        return;
    }

    if (series.length === 0) {
        renderEmpty(card, "No tracked time on this day.");
        return;
    }
    const dateKey = toDateKey(range.start);
    const cells: HeatCell[] = [];
    series.forEach((s, row) => {
        for (let hour = 0; hour < 24; hour++) {
            cells.push({
                row,
                col: hour,
                value: stats.hourly.get(hourKey(dateKey, hour, s.key)) ?? 0,
                title: `${s.label} · ${pad(hour)}:00–` +
                    `${pad((hour + 1) % 24)}:00`
            });
        }
    });
    renderHeatmap(card, {
        rowLabels: series.map(s => s.label.length > 12
            ? s.label.slice(0, 11) + "…" : s.label),
        colLabels: hourLabels,
        cells,
        cellSize: 20,
        tooltip,
        format,
        ariaLabel: "Tracked time per hour and category",
        rowLabelWidth: 80
    });
}

function renderBarsCard(
    parent: HTMLElement,
    options: PeriodChartsOptions
): void {
    const { period, range, stats, series, dayTargets } = options;
    const card = createCard(parent, getBarTitle(period));
    if (stats.total <= 0) {
        renderEmpty(card, "No tracked time in this period.");
        return;
    }

    let bars: BarDatum[];
    if (period === "year") {
        const year = range.start.getFullYear();
        bars = Array.from({ length: 12 }, (_, month) => {
            const values = series.map(() => 0);
            let target = 0;
            for (const day of range.days) {
                if (day.getMonth() !== month) continue;
                const dateKey = toDateKey(day);
                target += dayTargets.get(dateKey) ?? 0;
                const byCategory = stats.byDay.get(dateKey);
                if (!byCategory) continue;
                series.forEach((s, i) => {
                    values[i] = (values[i] ?? 0) +
                        (byCategory.get(s.key) ?? 0);
                });
            }
            const first = new Date(year, month, 1);
            return {
                label: toMoment(first).format("MMM"),
                title: toMoment(first).format("MMMM YYYY"),
                values,
                target,
                onClick: () => options.onSelect("month", first)
            };
        });
    } else if (period === "day") {
        const dateKey = toDateKey(range.start);
        bars = Array.from({ length: 24 }, (_, hour) => ({
            label: pad(hour),
            title: `${pad(hour)}:00–${pad((hour + 1) % 24)}:00`,
            values: series.map(s =>
                stats.hourly.get(hourKey(dateKey, hour, s.key)) ?? 0)
        }));
    } else {
        const isWeek = period === "week";
        bars = range.days.map(day => {
            const dateKey = toDateKey(day);
            const byCategory = stats.byDay.get(dateKey);
            const m = toMoment(day);
            return {
                label: isWeek ? m.format("ddd") : String(day.getDate()),
                title: m.format("ddd, D MMM YYYY"),
                values: series.map(s => byCategory?.get(s.key) ?? 0),
                target: dayTargets.get(dateKey),
                onClick: () => options.onSelect("day", day)
            };
        });
    }

    renderStackedBarChart(card, {
        series,
        bars,
        tooltip: options.tooltip,
        format: options.format,
        ariaLabel: getBarTitle(period),
        maxLabels: period === "day" ? 12 : 16
    });
    if (series.length > 1) renderLegend(card, series);
}

function renderDistributionCard(
    parent: HTMLElement,
    options: PeriodChartsOptions
): void {
    const { stats, series, distributionMode } = options;
    const card = createCard(parent, "Distribution");
    const header = card.querySelector(".stt-card-header");
    if (header) {
        const toggle = header.createDiv({ cls: "stt-toggle" });
        const modes: { mode: DistributionMode; label: string }[] = [
            { mode: "category", label: "By category" },
            { mode: "note", label: "By note" }
        ];
        for (const { mode, label } of modes) {
            const button = toggle.createEl("button", {
                text: label,
                cls: distributionMode === mode ? "is-active" : ""
            });
            button.addEventListener("click", () => {
                if (mode !== distributionMode) {
                    options.onDistributionModeChange(mode);
                }
            });
        }
    }

    let slices: DonutSlice[];
    if (distributionMode === "category") {
        slices = series.map(s => ({
            label: s.label,
            value: stats.byCategory.get(s.key) ?? 0,
            colorClass: s.colorClass
        }));
    } else {
        const notes = Array.from(stats.byNote.values())
            .sort((a, b) => b.duration - a.duration);
        slices = notes.slice(0, MAX_NOTE_SLICES).map((note, i) => ({
            label: note.name,
            value: note.duration,
            colorClass: `stt-series-${i + 1}`
        }));
        const rest = notes.slice(MAX_NOTE_SLICES)
            .reduce((sum, note) => sum + note.duration, 0);
        if (rest > 0) {
            slices.push({
                label: "Other notes",
                value: rest,
                colorClass: "stt-series-other"
            });
        }
    }

    renderDonutChart(
        card,
        slices,
        options.tooltip,
        options.format,
        "Distribution of tracked time"
    );
}

/** Bar chart and distribution side by side. */
export function renderChartGrid(
    parent: HTMLElement,
    options: PeriodChartsOptions
): void {
    const grid = parent.createDiv({ cls: "stt-grid" });
    renderBarsCard(grid, options);
    renderDistributionCard(grid, options);
}
