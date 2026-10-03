import { App, Modal, Notice, setIcon } from "obsidian";
import { getAPI } from "obsidian-dataview";
import TimeTrackerStatisticsPlugin from "./main";
import {
    STT_API,
    MinimalDataviewApi,
    PageTrackers,
    TrackedEntry,
    getSTTApi,
    loadPageTrackers,
    collectTrackedEntries,
    getDailyTarget
} from "./statistics";
import {
    DAY_OFF_TYPES,
    DayOffType,
    resolveCarryOver,
    setDayOffType
} from "./carry-over";
import { ChartSeries, ChartTooltip, renderEmpty } from "./charts";
import {
    DistributionMode,
    MonthConfigCache,
    PERIODS,
    PeriodChartsOptions,
    PeriodRange,
    PeriodStats,
    PeriodType,
    addDays,
    computePeriodStats,
    createCard,
    getDayOffLabel,
    getPeriodRange,
    getSeries,
    getWeekNumber,
    isSameMonth,
    pad,
    renderChartGrid,
    renderHeatmapCard,
    startOfDay,
    toMoment
} from "./period-view";

export { PERIODS };
export type { PeriodType };

interface DashboardWorkspace {
    openLinkText(
        linktext: string,
        sourcePath: string,
        newLeaf?: boolean
    ): Promise<void>;
}

export class StatisticsDashboardModal extends Modal {
    private plugin: TimeTrackerStatisticsPlugin;
    private api: STT_API | null = null;
    private period: PeriodType = "day";
    private anchor: Date = startOfDay(new Date());
    private distributionMode: DistributionMode = "category";
    private pages: PageTrackers[] = [];
    private entries: TrackedEntry[] = [];
    private carryOvers = new Map<string, Promise<number>>();
    private running: { path: string; basename: string } | null = null;
    private months: MonthConfigCache;
    private saving = false;
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
        period: PeriodType = "day",
        anchor?: Date
    ) {
        super(app);
        this.plugin = plugin;
        this.period = period;
        if (anchor) this.anchor = startOfDay(anchor);
        this.months = new MonthConfigCache(app);
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

            this.pages = pages;
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
            this.months.clear();
            this.carryOvers.clear();
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

    private async setDayType(
        day: Date,
        dayType: DayOffType | null
    ): Promise<void> {
        if (this.saving) return;
        this.saving = true;
        try {
            const note = await setDayOffType(
                this.plugin,
                day.getFullYear(),
                day.getMonth() + 1,
                day.getDate(),
                dayType
            );
            this.months.set(day, note);
            this.carryOvers.clear();
        } catch (error) {
            console.error("Simple Time Tracker (Dashboard) Error:", error);
            new Notice("Could not update the monthly note.");
        } finally {
            this.saving = false;
        }
        await this.render();
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

        await this.months.load(range.days);
        if (token !== this.renderToken) return;
        const categories = this.plugin.settings.categories;
        const dayTargets = this.months.getDayTargets(range.days, categories);
        const stats = computePeriodStats(
            this.entries,
            categories,
            range,
            dayTargets
        );
        const accumulated = getDailyTarget(categories) > 0
            ? await this.getAccumulatedDeviation(range, stats)
            : null;
        if (token !== this.renderToken) return;
        const series = getSeries(categories, stats);
        const chartOptions: PeriodChartsOptions = {
            period: this.period,
            range,
            stats,
            series,
            dayTargets,
            firstDayOfWeek: this.plugin.settings.firstDayOfWeek,
            tooltip: this.tooltip,
            format: (ms: number) => this.format(ms),
            getDayType: (day: Date) => this.months.getDayType(day),
            onSelect: (period: PeriodType, anchor: Date) =>
                this.setPeriod(period, anchor),
            distributionMode: this.distributionMode,
            onDistributionModeChange: (mode: DistributionMode) => {
                this.distributionMode = mode;
                void this.render();
            }
        };

        this.tooltip.hide();
        this.bodyEl.empty();
        this.renderTiles(stats, range, accumulated);
        if (this.period === "day") this.renderDayTypeCard(range.start);

        renderHeatmapCard(this.bodyEl, chartOptions);
        if (this.period === "month") this.renderDaysOffCard(range);
        renderChartGrid(this.bodyEl, chartOptions);

        if (this.period === "day") {
            this.renderEntriesTable(stats);
        } else {
            this.renderNotesTable(stats, series);
        }
    }

    private createCard(title: string): HTMLElement {
        return createCard(this.bodyEl, title);
    }

    /** Deviation carried into the month of `day`, as in the monthly note. */
    private getCarryOver(day: Date): Promise<number> {
        const key = `${day.getFullYear()}-${day.getMonth() + 1}`;
        let carryOver = this.carryOvers.get(key);
        if (!carryOver) {
            carryOver = this.resolveCarryOver(day);
            this.carryOvers.set(key, carryOver);
        }
        return carryOver;
    }

    private async resolveCarryOver(day: Date): Promise<number> {
        const { config, path } = this.months.get(day);
        if (path && config.deviation !== "auto") return config.deviation;
        if (!this.api) return 0;
        const result = await resolveCarryOver(
            this.plugin,
            this.api,
            this.pages,
            day.getFullYear(),
            day.getMonth() + 1
        );
        return result.deviation;
    }

    /**
     * Deviation at the end of the period including the carry-over: the
     * carry-over into the first month, the deviation of that month before
     * the period, and the deviation of the period itself.
     */
    private async getAccumulatedDeviation(
        range: PeriodRange,
        stats: PeriodStats
    ): Promise<number> {
        const monthStart = new Date(
            range.start.getFullYear(),
            range.start.getMonth(),
            1
        );
        let deviation = await this.getCarryOver(monthStart) +
            stats.work - stats.target;
        if (monthStart < range.start) {
            const categories = this.plugin.settings.categories;
            const days = getPeriodRange(
                "month",
                monthStart,
                this.plugin.settings.firstDayOfWeek
            ).days.filter(day => day < range.start);
            const before = computePeriodStats(
                this.entries,
                categories,
                { start: monthStart, end: addDays(range.start, -1), days },
                this.months.getDayTargets(days, categories)
            );
            deviation += before.work - before.target;
        }
        return deviation;
    }

    private renderTiles(
        stats: PeriodStats,
        range: PeriodRange,
        accumulated: number | null
    ): void {
        const tiles = this.bodyEl.createDiv({ cls: "stt-tiles" });
        const addTile = (label: string, value: string, hint?: string) => {
            const tile = tiles.createDiv({ cls: "stt-tile" });
            tile.createDiv({ cls: "stt-tile-label", text: label });
            tile.createDiv({ cls: "stt-tile-value", text: value });
            if (hint) tile.createDiv({ cls: "stt-tile-hint", text: hint });
        };

        addTile("Total tracked", this.format(stats.total));
        if (accumulated !== null) {
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
            addTile(
                "Accumulated deviation",
                this.formatSigned(accumulated),
                stats.targetIsPartial ? "Incl. carry-over, up to today"
                    : "Incl. carry-over"
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

    private renderNoteLink(parent: HTMLElement, day: Date): void {
        const path = this.months.get(day).path;
        const hint = parent.createDiv({ cls: "stt-card-hint" });
        if (!path) {
            hint.setText("A monthly note will be created on the first change.");
            return;
        }
        hint.createSpan({ text: "Saved in " });
        const link = hint.createEl("a", {
            text: path.replace(/\.md$/, ""),
            cls: "internal-link"
        });
        link.addEventListener("click", () => this.openNote(path));
    }

    private renderDayTypeCard(day: Date): void {
        const card = this.createCard("Day type");
        const header = card.querySelector(".stt-card-header");
        const current = this.months.getDayType(day);
        if (header) {
            const toggle = header.createDiv({ cls: "stt-toggle" });
            const options: { type: DayOffType | null; label: string }[] = [
                { type: null, label: "Workday" },
                ...DAY_OFF_TYPES
            ];
            for (const { type, label } of options) {
                const button = toggle.createEl("button", {
                    text: label,
                    cls: current === type ? "is-active" : ""
                });
                button.addEventListener("click", () => {
                    if (type !== current) void this.setDayType(day, type);
                });
            }
        }
        const weekday = day.getDay();
        if (weekday === 0 || weekday === 6) {
            card.createDiv({
                cls: "stt-card-hint",
                text: "Weekends never count towards the target."
            });
        }
        this.renderNoteLink(card, day);
    }

    private renderDaysOffCard(range: PeriodRange): void {
        const card = this.createCard("Days off");
        const marked = range.days
            .map(day => ({ day, type: this.months.getDayType(day) }))
            .filter((d): d is { day: Date; type: DayOffType } =>
                d.type !== null);

        if (marked.length === 0) {
            renderEmpty(card, "No days off in this month.");
        } else {
            const list = card.createDiv({ cls: "stt-days-off" });
            for (const { day, type } of marked) {
                const chip = list.createDiv({ cls: "stt-day-off" });
                const label = chip.createEl("a", {
                    text: `${toMoment(day).format("ddd D")} · ` +
                        getDayOffLabel(type)
                });
                label.addEventListener("click", () =>
                    this.setPeriod("day", day));
                const remove = chip.createEl("button", {
                    cls: "clickable-icon",
                    attr: { "aria-label": "Remove" }
                });
                setIcon(remove, "x");
                remove.addEventListener("click", () => {
                    void this.setDayType(day, null);
                });
            }
        }

        const form = card.createDiv({ cls: "stt-day-off-form" });
        const daySelect = form.createEl("select", { cls: "dropdown" });
        for (const day of range.days) {
            daySelect.createEl("option", {
                text: toMoment(day).format("ddd D"),
                value: String(day.getDate())
            });
        }
        const today = new Date();
        if (isSameMonth(today, range.start)) {
            daySelect.value = String(today.getDate());
        }
        const typeSelect = form.createEl("select", { cls: "dropdown" });
        for (const { type, label } of DAY_OFF_TYPES) {
            typeSelect.createEl("option", { text: label, value: type });
        }
        const add = form.createEl("button", { text: "Add", cls: "mod-cta" });
        add.addEventListener("click", () => {
            const day = new Date(
                range.start.getFullYear(),
                range.start.getMonth(),
                Number(daySelect.value)
            );
            void this.setDayType(day, typeSelect.value as DayOffType);
        });

        this.renderNoteLink(card, range.start);
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
