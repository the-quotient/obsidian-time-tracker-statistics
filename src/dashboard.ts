import { App, Modal, moment, setIcon } from "obsidian";
import { getAPI } from "obsidian-dataview";
import TimeTrackerStatisticsPlugin from "./main";
import { Category } from "./settings";
import {
    STT_API,
    MinimalDataviewApi,
    TrackedEntry,
    getSTTApi,
    loadPageTrackers,
    collectTrackedEntries,
    getDailyTarget,
    isWorkCategory
} from "./statistics";
import { MonthConfig, isTargetDay, loadMonthConfig } from "./carry-over";
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
type DistributionMode = "category" | "note";

interface DashboardMoment {
    format(fmt: string): string;
    locale(locale: string): DashboardMoment;
    isoWeek(): number;
    week(): number;
}
type DashboardMomentFactory = (input: Date) => DashboardMoment;
const toMoment = moment as unknown as DashboardMomentFactory;

interface DashboardWorkspace {
    openLinkText(
        linktext: string,
        sourcePath: string,
        newLeaf?: boolean
    ): Promise<void>;
}

interface PeriodRange {
    start: Date;
    end: Date;
    days: Date[];
}

interface PeriodStats {
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

function pad(value: number): string {
    return value < 10 ? "0" + value : String(value);
}

function toDateKey(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-` +
        pad(date.getDate());
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date: Date, firstDayOfWeek: number): Date {
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

function getPeriodRange(
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

function getWeekNumber(date: Date, firstDayOfWeek: number): number {
    const m = toMoment(date);
    return firstDayOfWeek === 1 ? m.isoWeek() : m.locale("en").week();
}

function hourKey(dateKey: string, hour: number, category: string): string {
    return `${dateKey}|${hour}|${category}`;
}

function getEmptyMonthConfig(): MonthConfig {
    return { deviation: 0, daysOff: [], vacationDays: [], sickDays: [] };
}

export class StatisticsDashboardModal extends Modal {
    private plugin: TimeTrackerStatisticsPlugin;
    private api: STT_API | null = null;
    private period: PeriodType = "day";
    private anchor: Date = startOfDay(new Date());
    private distributionMode: DistributionMode = "category";
    private entries: TrackedEntry[] = [];
    private running: { path: string; basename: string } | null = null;
    private monthConfigs = new Map<string, MonthConfig>();
    private renderToken = 0;
    private loaded = false;

    private tooltip: ChartTooltip;
    private tabsEl: HTMLElement;
    private periodLabelEl: HTMLElement;
    private runningEl: HTMLElement;
    private refreshButton: HTMLButtonElement;
    private bodyEl: HTMLElement;

    constructor(
        app: App,
        plugin: TimeTrackerStatisticsPlugin,
        period: PeriodType = "day"
    ) {
        super(app);
        this.plugin = plugin;
        this.period = period;
    }

    onOpen(): void {
        this.modalEl.addClass("stt-dashboard-modal");
        this.setTitle("Time tracker statistics");
        this.contentEl.addClass("stt-dashboard");

        this.buildToolbar();
        this.bodyEl = this.contentEl.createDiv({ cls: "stt-dashboard-body" });
        this.tooltip = new ChartTooltip();

        this.scope.register([], "ArrowLeft", () => {
            this.shift(-1);
            return false;
        });
        this.scope.register([], "ArrowRight", () => {
            this.shift(1);
            return false;
        });

        void this.reload();
    }

    onClose(): void {
        this.renderToken++;
        this.tooltip.destroy();
        this.contentEl.empty();
    }

    private buildToolbar(): void {
        const toolbar = this.contentEl.createDiv({ cls: "stt-toolbar" });

        this.tabsEl = toolbar.createDiv({ cls: "stt-tabs" });
        for (const { type, label } of PERIODS) {
            const tab = this.tabsEl.createEl("button", {
                cls: "stt-tab",
                text: label
            });
            tab.dataset.period = type;
            tab.addEventListener("click", () => this.setPeriod(type));
        }

        const nav = toolbar.createDiv({ cls: "stt-nav" });
        const prev = nav.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Previous" }
        });
        setIcon(prev, "chevron-left");
        prev.addEventListener("click", () => this.shift(-1));

        this.periodLabelEl = nav.createDiv({ cls: "stt-period-label" });

        const next = nav.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Next" }
        });
        setIcon(next, "chevron-right");
        next.addEventListener("click", () => this.shift(1));

        const today = nav.createEl("button", { text: "Today" });
        today.addEventListener("click", () => {
            this.anchor = startOfDay(new Date());
            void this.render();
        });

        const actions = toolbar.createDiv({ cls: "stt-actions" });
        this.runningEl = actions.createDiv({ cls: "stt-running" });
        this.refreshButton = actions.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Refresh" }
        });
        setIcon(this.refreshButton, "refresh-cw");
        this.refreshButton.addEventListener("click", () => {
            void this.reload();
        });
    }

    private setPeriod(period: PeriodType, anchor?: Date): void {
        this.period = period;
        if (anchor) this.anchor = anchor;
        void this.render();
    }

    private shift(direction: number): void {
        const a = this.anchor;
        switch (this.period) {
            case "year":
                this.anchor = new Date(a.getFullYear() + direction, 0, 1);
                break;
            case "month":
                this.anchor = new Date(a.getFullYear(), a.getMonth() + direction, 1);
                break;
            case "week":
                this.anchor = addDays(a, 7 * direction);
                break;
            default:
                this.anchor = addDays(a, direction);
        }
        void this.render();
    }

    private async reload(): Promise<void> {
        const token = ++this.renderToken;
        setIcon(this.refreshButton, "loader");
        this.refreshButton.disabled = true;

        try {
            this.api = getSTTApi(this.app);
            const dataviewApi = getAPI(this.app) as unknown as
                MinimalDataviewApi | undefined;

            if (!this.api) {
                this.showMessage("Simple time tracker is required.");
                return;
            }
            if (!dataviewApi) {
                this.showMessage("Dataview plugin is not enabled...");
                return;
            }

            this.bodyEl.empty();
            this.bodyEl.createDiv({ cls: "stt-loading", text: "Loading…" });

            const api = this.api;
            const pages = await loadPageTrackers(dataviewApi, this.app, api);
            if (token !== this.renderToken) return;

            this.entries = collectTrackedEntries(
                pages,
                this.plugin.settings.categories,
                api
            );
            const runningPage = pages.find(page =>
                page.trackers.some(tracker => api.isRunning(tracker))
            );
            this.running = runningPage
                ? { path: runningPage.path, basename: runningPage.basename }
                : null;
            this.monthConfigs.clear();
            this.loaded = true;
            await this.render();
        } catch (error) {
            console.error("Simple Time Tracker (Dashboard) Error:", error);
            this.showMessage("An error occurred while generating the report.");
        } finally {
            setIcon(this.refreshButton, "refresh-cw");
            this.refreshButton.disabled = false;
        }
    }

    private showMessage(text: string): void {
        this.bodyEl.empty();
        this.bodyEl.createEl("p", { text });
    }

    private format(ms: number): string {
        return this.api ? this.api.formatDuration(ms) : String(ms);
    }

    private formatSigned(ms: number): string {
        return (ms >= 0 ? "+" : "-") + this.format(Math.abs(ms));
    }

    private async getMonthConfig(
        year: number,
        monthIndex: number
    ): Promise<MonthConfig> {
        const key = `${year}-${monthIndex}`;
        let config = this.monthConfigs.get(key);
        if (!config) {
            config = await loadMonthConfig(this.app, year, monthIndex)
                ?? getEmptyMonthConfig();
            this.monthConfigs.set(key, config);
        }
        return config;
    }

    private async getDayTargets(days: Date[]): Promise<Map<string, number>> {
        const dailyTarget = getDailyTarget(this.plugin.settings.categories);
        const targets = new Map<string, number>();
        if (dailyTarget <= 0) return targets;

        for (const day of days) {
            const year = day.getFullYear();
            const monthIndex = day.getMonth() + 1;
            const config = await this.getMonthConfig(year, monthIndex);
            if (isTargetDay(year, monthIndex, day.getDate(), config)) {
                targets.set(toDateKey(day), dailyTarget);
            }
        }
        return targets;
    }

    private getSeries(stats: PeriodStats): ChartSeries[] {
        const categories = this.plugin.settings.categories;
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

    private computeStats(
        range: PeriodRange,
        dayTargets: Map<string, number>
    ): PeriodStats {
        const startKey = toDateKey(range.start);
        const endKey = toDateKey(range.end);
        const todayKey = toDateKey(new Date());
        const categories = this.plugin.settings.categories;
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
        for (const entry of this.entries) {
            if (entry.dateKey >= hourlyStartKey && entry.dateKey <= endKey) {
                this.addHourly(stats.hourly, entry, startKey, endKey);
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

    private addHourly(
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

    private updateToolbar(range: PeriodRange): void {
        this.tabsEl.querySelectorAll<HTMLElement>(".stt-tab").forEach(tab => {
            tab.toggleClass("is-active", tab.dataset.period === this.period);
        });

        const start = toMoment(range.start);
        const end = toMoment(range.end);
        let label: string;
        switch (this.period) {
            case "year":
                label = start.format("YYYY");
                break;
            case "month":
                label = start.format("MMMM YYYY");
                break;
            case "week": {
                const week = getWeekNumber(
                    range.start,
                    this.plugin.settings.firstDayOfWeek
                );
                label = `Week ${week} · ${start.format("D MMM")} – ` +
                    end.format("D MMM YYYY");
                break;
            }
            default:
                label = start.format("dddd, D MMMM YYYY");
        }
        this.periodLabelEl.setText(label);

        this.runningEl.empty();
        if (this.running) {
            const { path, basename } = this.running;
            this.runningEl.createSpan({ cls: "stt-running-dot" });
            this.runningEl.createSpan({ text: "Running: " });
            const link = this.runningEl.createEl("a", {
                text: basename,
                cls: "internal-link"
            });
            link.addEventListener("click", () => this.openNote(path));
        }
    }

    private openNote(path: string): void {
        const workspace = this.app.workspace as unknown as DashboardWorkspace;
        this.close();
        void workspace.openLinkText(path, "", false);
    }

    private async render(): Promise<void> {
        const token = ++this.renderToken;
        const range = getPeriodRange(
            this.period,
            this.anchor,
            this.plugin.settings.firstDayOfWeek
        );
        this.updateToolbar(range);
        if (!this.loaded || !this.api) return;

        const dayTargets = await this.getDayTargets(range.days);
        if (token !== this.renderToken) return;

        const stats = this.computeStats(range, dayTargets);
        const series = this.getSeries(stats);

        this.tooltip.hide();
        this.bodyEl.empty();
        this.renderTiles(stats, range);

        const heatCard = this.createCard(this.getHeatmapTitle());
        this.renderHeatmapForPeriod(heatCard, range, stats, series);

        const grid = this.bodyEl.createDiv({ cls: "stt-grid" });
        const barCard = this.createCard(this.getBarTitle(), grid);
        this.renderBarsForPeriod(barCard, range, stats, series, dayTargets);

        const pieCard = this.createCard("Distribution", grid);
        this.renderDistribution(pieCard, stats, series);

        if (this.period === "day") {
            this.renderEntriesTable(stats);
        } else {
            this.renderNotesTable(stats, series);
        }
    }

    private createCard(title: string, parent?: HTMLElement): HTMLElement {
        const card = (parent ?? this.bodyEl).createDiv({ cls: "stt-card" });
        const header = card.createDiv({ cls: "stt-card-header" });
        header.createEl("h4", { text: title });
        return card;
    }

    private renderTiles(stats: PeriodStats, range: PeriodRange): void {
        const tiles = this.bodyEl.createDiv({ cls: "stt-tiles" });
        const addTile = (label: string, value: string, hint?: string) => {
            const tile = tiles.createDiv({ cls: "stt-tile" });
            tile.createDiv({ cls: "stt-tile-label", text: label });
            tile.createDiv({ cls: "stt-tile-value", text: value });
            if (hint) tile.createDiv({ cls: "stt-tile-hint", text: hint });
        };

        addTile("Total tracked", this.format(stats.total));
        const hasTarget = getDailyTarget(this.plugin.settings.categories) > 0;
        if (hasTarget) {
            addTile("Work", this.format(stats.work));
            addTile(
                "Target",
                this.format(stats.target),
                stats.targetIsPartial ? "Up to today" : undefined
            );
            addTile(
                "Deviation",
                this.formatSigned(stats.work - stats.target),
                stats.targetIsPartial ? "Up to today" : undefined
            );
        }
        if (this.period !== "day") {
            addTile(
                "Active days",
                `${stats.activeDays} / ${range.days.length}`
            );
            addTile(
                "Average per active day",
                this.format(stats.activeDays
                    ? Math.round(stats.total / stats.activeDays) : 0)
            );
        } else {
            addTile("Entries", String(stats.entries.length));
        }
    }

    private getHeatmapTitle(): string {
        switch (this.period) {
            case "year": return "Daily activity";
            case "month": return "Calendar";
            case "week": return "Hours by day";
            default: return "Hours by category";
        }
    }

    private getBarTitle(): string {
        switch (this.period) {
            case "year": return "Time per month";
            case "month":
            case "week": return "Time per day";
            default: return "Time per hour";
        }
    }

    private weekdayLabels(): string[] {
        const first = startOfWeek(new Date(), this.plugin.settings.firstDayOfWeek);
        return [0, 1, 2, 3, 4, 5, 6].map(i =>
            toMoment(addDays(first, i)).format("ddd")
        );
    }

    private dayTotal(stats: PeriodStats, dateKey: string): number {
        const day = stats.byDay.get(dateKey);
        if (!day) return 0;
        let sum = 0;
        for (const value of day.values()) sum += value;
        return sum;
    }

    private renderHeatmapForPeriod(
        card: HTMLElement,
        range: PeriodRange,
        stats: PeriodStats,
        series: ChartSeries[]
    ): void {
        const firstDay = this.plugin.settings.firstDayOfWeek;
        const tooltip = this.tooltip;
        const format = (ms: number) => this.format(ms);
        const hourLabels = Array.from({ length: 24 }, (_, h) =>
            h % 3 === 0 ? pad(h) : "");

        if (this.period === "year" || this.period === "month") {
            const gridStart = startOfWeek(range.start, firstDay);
            const cells: HeatCell[] = range.days.map(day => {
                const index = Math.round(
                    (startOfDay(day).getTime() - gridStart.getTime()) / DAY_MS
                );
                const week = Math.floor(index / 7);
                const weekday = index % 7;
                const isYear = this.period === "year";
                return {
                    row: isYear ? weekday : week,
                    col: isYear ? week : weekday,
                    value: this.dayTotal(stats, toDateKey(day)),
                    title: toMoment(day).format("ddd, D MMM YYYY"),
                    text: isYear ? undefined : String(day.getDate()),
                    onClick: () => this.setPeriod("day", day)
                };
            });
            const weeks = Math.max(...cells.map(c =>
                this.period === "year" ? c.col : c.row)) + 1;
            const weekdays = this.weekdayLabels();

            if (this.period === "year") {
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

        if (this.period === "week") {
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
                        onClick: () => this.setPeriod("day", day)
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

    private renderBarsForPeriod(
        card: HTMLElement,
        range: PeriodRange,
        stats: PeriodStats,
        series: ChartSeries[],
        dayTargets: Map<string, number>
    ): void {
        if (stats.total <= 0) {
            renderEmpty(card, "No tracked time in this period.");
            return;
        }

        let bars: BarDatum[];
        if (this.period === "year") {
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
                    onClick: () => this.setPeriod("month", first)
                };
            });
        } else if (this.period === "day") {
            const dateKey = toDateKey(range.start);
            bars = Array.from({ length: 24 }, (_, hour) => ({
                label: pad(hour),
                title: `${pad(hour)}:00–${pad((hour + 1) % 24)}:00`,
                values: series.map(s =>
                    stats.hourly.get(hourKey(dateKey, hour, s.key)) ?? 0)
            }));
        } else {
            const isWeek = this.period === "week";
            bars = range.days.map(day => {
                const dateKey = toDateKey(day);
                const byCategory = stats.byDay.get(dateKey);
                const m = toMoment(day);
                return {
                    label: isWeek ? m.format("ddd") : String(day.getDate()),
                    title: m.format("ddd, D MMM YYYY"),
                    values: series.map(s => byCategory?.get(s.key) ?? 0),
                    target: dayTargets.get(dateKey),
                    onClick: () => this.setPeriod("day", day)
                };
            });
        }

        renderStackedBarChart(card, {
            series,
            bars,
            tooltip: this.tooltip,
            format: (ms: number) => this.format(ms),
            ariaLabel: this.getBarTitle(),
            maxLabels: this.period === "day" ? 12 : 16
        });
        if (series.length > 1) renderLegend(card, series);
    }

    private renderDistribution(
        card: HTMLElement,
        stats: PeriodStats,
        series: ChartSeries[]
    ): void {
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
                    cls: this.distributionMode === mode ? "is-active" : ""
                });
                button.addEventListener("click", () => {
                    this.distributionMode = mode;
                    void this.render();
                });
            }
        }

        let slices: DonutSlice[];
        if (this.distributionMode === "category") {
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
            this.tooltip,
            (ms: number) => this.format(ms),
            "Distribution of tracked time"
        );
    }

    private renderNotesTable(stats: PeriodStats, series: ChartSeries[]): void {
        const card = this.createCard("Notes");
        const notes = Array.from(stats.byNote.entries())
            .sort((a, b) => b[1].duration - a[1].duration);
        if (notes.length === 0) {
            renderEmpty(card, "No tracked time in this period.");
            return;
        }

        const categoryByPath = new Map<string, string>();
        for (const entry of stats.entries) {
            categoryByPath.set(entry.path, entry.category);
        }
        const max = notes[0]?.[1].duration ?? 1;

        const table = card.createEl("table", { cls: "stt-table" });
        const head = table.createEl("thead").createEl("tr");
        for (const title of ["Note", "Category", "Duration", "Share"]) {
            head.createEl("th", { text: title });
        }
        const body = table.createEl("tbody");
        for (const [path, note] of notes) {
            const row = body.createEl("tr");
            const link = row.createEl("td").createEl("a", {
                text: note.name,
                cls: "internal-link"
            });
            link.addEventListener("click", () => this.openNote(path));

            const category = categoryByPath.get(path) ?? "";
            const s = series.find(x => x.key === category);
            const categoryCell = row.createEl("td");
            if (s) {
                categoryCell.createSpan({ cls: `stt-swatch ${s.colorClass}` });
            }
            categoryCell.createSpan({ text: category });

            row.createEl("td", { text: this.format(note.duration) });
            const shareCell = row.createEl("td", { cls: "stt-share-cell" });
            const bar = shareCell.createDiv({ cls: "stt-share-bar" });
            bar.setCssProps({
                "--stt-share": `${(note.duration / max) * 100}%`
            });
            shareCell.createSpan({
                text: `${((note.duration / stats.total) * 100).toFixed(1)}%`
            });
        }
    }

    private renderEntriesTable(stats: PeriodStats): void {
        const card = this.createCard("Entries");
        if (stats.entries.length === 0) {
            renderEmpty(card, "No tracked time on this day.");
            return;
        }
        const entries = [...stats.entries].sort((a, b) =>
            a.startTime.localeCompare(b.startTime));

        const table = card.createEl("table", { cls: "stt-table" });
        const head = table.createEl("thead").createEl("tr");
        for (const title of ["Time", "Note", "Entry", "Category", "Duration"]) {
            head.createEl("th", { text: title });
        }
        const body = table.createEl("tbody");
        for (const entry of entries) {
            const row = body.createEl("tr");
            const start = new Date(entry.startTime);
            const end = entry.endTime ? new Date(entry.endTime) : null;
            const time = `${pad(start.getHours())}:${pad(start.getMinutes())}` +
                ` – ${end ? `${pad(end.getHours())}:${pad(end.getMinutes())}`
                    : "now"}`;
            row.createEl("td", { text: time });
            const link = row.createEl("td").createEl("a", {
                text: entry.pageName,
                cls: "internal-link"
            });
            link.addEventListener("click", () => this.openNote(entry.path));
            row.createEl("td", { text: entry.name });
            row.createEl("td", { text: entry.category });
            row.createEl("td", { text: this.format(entry.duration) });
        }
    }
}
