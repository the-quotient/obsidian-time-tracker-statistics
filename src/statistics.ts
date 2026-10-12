import {
    MarkdownRenderer,
    setIcon,
    App,
    moment,
    Component
} from "obsidian";
import { getAPI } from "obsidian-dataview";
import TimeTrackerStatisticsPlugin from "./main";
import { Category, TimeTrackerStatisticsSettings } from "./settings";
import {
    CategoryBalance,
    TrackedPiece,
    computeCategoryBalances
} from "./target-rules";
import {
    MonthConfig,
    CarryOverResult,
    DayOffType,
    parseMonthConfig,
    getMonthDetails,
    getMonthRange,
    getDayOffType,
    getCountedTarget,
    getDayWorkAndOther,
    isTargetDay,
    resolveCarryOver
} from "./carry-over";
import { ChartTooltip } from "./charts";
import {
    DistributionMode,
    MonthConfigCache,
    PeriodChartsOptions,
    PeriodType,
    computePeriodStats,
    formatEntryTime,
    getAccumulatedDeviation,
    getDayOffLabel,
    getPeriodRange,
    getSeries,
    getWeekStart,
    getWeekToDateRange,
    renderChartGrid,
    renderHeatmapCard,
    toDateKey
} from "./period-view";

interface STTMomentDuration {
    asMilliseconds(): number;
}
interface STTMoment {
    isSameOrAfter(m: STTMoment): boolean;
    isSameOrBefore(m: STTMoment): boolean;
    format(fmt: string): string;
    isValid(): boolean;
    clone(): STTMoment;
    locale(locale: string): STTMoment;
    isoWeek(): number;
    week(): number;
    day(): number;
}
interface STTMomentFactory {
    (input?: string | { year: number; month: number; day: number }): STTMoment;
    duration(target: string): STTMomentDuration;
}
const safeMoment = moment as unknown as STTMomentFactory;

interface SafeRenderer {
    render(
        app: App,
        markdown: string,
        el: HTMLElement,
        sourcePath: string,
        component: Component
    ): Promise<void>;
}
const safeRenderer = MarkdownRenderer as unknown as SafeRenderer;

interface ElementOptions {
    text?: string;
    cls?: string;
    attr?: Record<string, string>;
}
interface ObsidianHTMLElement extends HTMLElement {
    empty(): void;
    createDiv(options?: ElementOptions): HTMLDivElement & ObsidianHTMLElement;
    createEl<K extends keyof HTMLElementTagNameMap>(
        tag: K,
        options?: ElementOptions
    ): HTMLElementTagNameMap[K] & ObsidianHTMLElement;
    addClass(cls: string): void;
}

interface ReportContext {
    plugin: TimeTrackerStatisticsPlugin;
    api: STT_API;
    dataviewApi: MinimalDataviewApi;
    fileName: string;
    sourcePath: string;
    component: Component;
    tooltip: ChartTooltip;
}

type ReportRenderer = (
    container: ObsidianHTMLElement,
    context: ReportContext
) => Promise<void>;

interface SafeTFile {
    name: string;
    basename: string;
}
interface SafeVault {
    getAbstractFileByPath(path: string): SafeTFile | null;
}

export interface Entry {
    id: string;
    name: string;
    startTime: string | null;
    endTime: string | null;
    subEntries: Entry[];
}

export interface Tracker {
    entries: Entry[];
}

export interface STT_API {
    loadAllTrackers: (fileName: string) => Promise<{ tracker: Tracker }[]>;
    getDuration: (entry: Entry) => number;
    getTotalDuration: (entries: Entry[]) => number;
    formatDuration: (totalTime: number) => string;
    isRunning: (tracker: Tracker) => boolean;
}

interface DataviewFile {
    path: string;
    name: string;
    tags?: string[];
}

interface DataviewPage {
    file?: DataviewFile;
}

export interface MinimalDataviewApi {
    pages(query: string): Iterable<DataviewPage>;
}

interface InternalApp extends App {
    plugins: {
        plugins: Record<string, { api?: STT_API } | undefined>;
    };
}

export interface WorkingTimeResult {
    totalDuration: number;
    fileCategories: string[];
    pageNames: string[];
    entryNames: string[];
    entryDurations: number[];
}

export function getSTTApi(app: App): STT_API | null {
    const internalApp = app as unknown as InternalApp;
    const sttPlugin = internalApp.plugins?.plugins?.["simple-time-tracker"];
    if (!sttPlugin || !sttPlugin.api) {
        return null;
    }
    return sttPlugin.api;
}

function extractDate(input: string): string | null {
    if (!input) return null;
    const match = input.match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : null;
}

function getLocalDateKey(timestamp: string | null): string | null {
    if (!timestamp) return null;
    const time = safeMoment(timestamp);
    return time.isValid() ? time.format("YYYY-MM-DD") : null;
}

export function parseTargetTime(target: string): number {
    if (!target) return 0;
    return safeMoment.duration(target).asMilliseconds();
}

const TARGET_DAYS_PER_WEEK = 5;

/** Target of a category per target day; weekly targets are spread evenly. */
export function getCategoryTarget(category: Category): number {
    const target = parseTargetTime(category.target);
    return category.targetPeriod === "week"
        ? Math.round(target / TARGET_DAYS_PER_WEEK)
        : target;
}

/**
 * Categories with a target count as work, and so do categories without one
 * that fill the target of others.
 */
export function isWorkCategory(category: Category): boolean {
    return getCategoryTarget(category) > 0 ||
        (category.fills?.length ?? 0) > 0;
}

export function getDailyTarget(categories: Category[]): number {
    return categories
        .filter(isWorkCategory)
        .reduce((total, c) => total + getCategoryTarget(c), 0);
}

/** The categories of the settings, without fill rules if turned off. */
export function getCategories(
    settings: TimeTrackerStatisticsSettings
): Category[] {
    if (settings.targetRules) return settings.categories;
    return settings.categories.map(category => ({
        ...category,
        fills: []
    }));
}

/**
 * Remaining time and overtime per work category over `targetDays` target
 * days.
 */
export function getCategoryBalances(
    categories: Category[],
    targetDays: number,
    pieces: TrackedPiece[]
): Map<string, CategoryBalance> {
    const rules = categories.filter(isWorkCategory).map(category => ({
        name: category.name,
        target: getCategoryTarget(category) * targetDays,
        fills: category.fills ?? []
    }));
    return computeCategoryBalances(rules, pieces);
}

export function extractYear(inputString: string): number | null {
    const yearMatch = String(inputString).match(/\b\d{4}\b/);
    return yearMatch ? Number(yearMatch[0]) : null;
}

export function extractMonth(inputString: string): number | null {
    const monthMatch = String(inputString).match(/\b-\d{2}\b/);
    return monthMatch ? Number(monthMatch[0].replace("-", "")) : null;
}

function escapeMarkdown(text: string): string {
    return text.replace(/\|/g, '\\|');
}

function createEmptyResult(): WorkingTimeResult {
    return {
        totalDuration: 0,
        fileCategories: [],
        pageNames: [],
        entryNames: [],
        entryDurations: []
    };
}

export interface PageTrackers {
    path: string;
    basename: string;
    tags: string[];
    trackers: Tracker[];
}

export async function loadPageTrackers(
    dataviewApi: MinimalDataviewApi,
    app: App,
    api: STT_API
): Promise<PageTrackers[]> {
    const vault = app.vault as unknown as SafeVault;
    const result: PageTrackers[] = [];

    for (const page of dataviewApi.pages('""')) {
        if (!page.file?.path) continue;

        const filePath = page.file.path;
        const file = vault.getAbstractFileByPath(filePath);

        if (!file || typeof file.basename !== "string") {
            continue;
        }

        const trackers = await api.loadAllTrackers(filePath);
        result.push({
            path: filePath,
            basename: file.basename,
            tags: page.file.tags ?? [],
            trackers: trackers.map(({ tracker }) => tracker)
        });
    }
    return result;
}

export interface TrackedEntry {
    dateKey: string;
    category: string;
    path: string;
    pageName: string;
    name: string;
    duration: number;
    startTime: string;
    endTime: string | null;
}

/** The entries between two days, in the order they were tracked. */
function getTrackedPieces(
    entries: TrackedEntry[],
    startKey: string,
    endKey: string
): TrackedPiece[] {
    return entries
        .filter(e => e.dateKey >= startKey && e.dateKey <= endKey)
        .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
        .map(e => ({ category: e.category, duration: e.duration }));
}

export function getPageCategory(tags: string[], categories: Category[]): string {
    const pageTags = new Set(tags);
    for (const cat of categories) {
        if (cat.tags.some((tag: string) => pageTags.has(tag))) {
            return cat.name;
        }
    }
    return "Other";
}

export function collectTrackedEntries(
    pages: PageTrackers[],
    categories: Category[],
    api: STT_API
): TrackedEntry[] {
    const result: TrackedEntry[] = [];

    function processEntries(
        entries: Entry[],
        page: PageTrackers,
        category: string,
        parentName = ''
    ) {
        entries.forEach(entry => {
            const dateKey = getLocalDateKey(entry.startTime);

            if (dateKey && entry.startTime) {
                let fullName = entry.name;
                if (parentName) {
                    fullName = `${parentName} -> ${entry.name}`;
                }

                result.push({
                    dateKey,
                    category,
                    path: page.path,
                    pageName: page.basename,
                    name: fullName,
                    duration: api.getDuration(entry),
                    startTime: entry.startTime,
                    endTime: entry.endTime
                });
            }

            if (entry.subEntries) {
                let newParentName = entry.name;
                if (parentName) {
                    newParentName = `${parentName} -> ${entry.name}`;
                }
                processEntries(entry.subEntries, page, category, newParentName);
            }
        });
    }

    for (const page of pages) {
        const category = getPageCategory(page.tags, categories);
        for (const tracker of page.trackers) {
            processEntries(tracker.entries, page, category);
        }
    }

    return result;
}

export function getWorkingTimeMap(
    pages: PageTrackers[],
    plugin: TimeTrackerStatisticsPlugin,
    api: STT_API,
    startDate: string,
    endDate: string
): Map<string, WorkingTimeResult> {
    const resultMap = new Map<string, WorkingTimeResult>();
    const entries = collectTrackedEntries(
        pages,
        getCategories(plugin.settings),
        api
    );

    for (const entry of entries) {
        if (entry.dateKey < startDate || entry.dateKey > endDate) continue;

        if (!resultMap.has(entry.dateKey)) {
            resultMap.set(entry.dateKey, createEmptyResult());
        }
        const result = resultMap.get(entry.dateKey)!;
        result.totalDuration += entry.duration;
        result.fileCategories.push(entry.category);
        result.pageNames.push(entry.pageName);
        result.entryNames.push(entry.name);
        result.entryDurations.push(entry.duration);
    }

    return resultMap;
}

function getRunningTrackerMarkdown(
    pages: PageTrackers[],
    api: STT_API
): string {
    for (const { path, basename, trackers } of pages) {
        if (trackers.some(tracker => api.isRunning(tracker))) {
            return `**Currently running:** [[${path}|${basename}]]\n` +
                `\n---\n`;
        }
    }
    return "_No tracker is currently running._\n";
}

function getFileName(app: App, sourcePath: string): string {
    const vault = app.vault as unknown as SafeVault;
    const sourceFile = vault.getAbstractFileByPath(sourcePath);
    if (sourceFile && typeof sourceFile.name === "string") {
        return sourceFile.name;
    }
    const parts = sourcePath.split('/');
    return parts[parts.length - 1] || "";
}

function formatSigned(api: STT_API, ms: number): string {
    return (ms >= 0 ? "+" : "-") + api.formatDuration(Math.abs(ms));
}

async function renderMarkdown(
    container: ObsidianHTMLElement,
    context: ReportContext,
    markdown: string
): Promise<void> {
    await safeRenderer.render(
        context.plugin.app,
        markdown,
        container.createDiv(),
        context.sourcePath,
        context.component
    );
}

function showMessage(container: ObsidianHTMLElement, text: string): void {
    container.innerHTML = "";
    container.createEl("p", { text });
}

/**
 * Builds a statistics code block: title, refresh button and the report
 * rendered by `renderer` from the note's file name.
 */
function displayStatistics(
    container: HTMLElement,
    plugin: TimeTrackerStatisticsPlugin,
    sourcePath: string,
    component: Component,
    title: string,
    renderer: ReportRenderer
): void {
    const cont = container as ObsidianHTMLElement;
    const app = plugin.app;
    const api = getSTTApi(app);

    if (!api) {
        cont.innerHTML = "";
        cont.createEl("p", { text: "Simple time tracker is required." });
        return;
    }

    const tooltip = new ChartTooltip();
    component.register(() => tooltip.destroy());

    const renderReport = async (contentContainer: ObsidianHTMLElement) => {
        const dataviewApi = getAPI(app) as unknown as MinimalDataviewApi;
        if (!dataviewApi) {
            showMessage(contentContainer, "Dataview plugin is not enabled...");
            return;
        }

        try {
            contentContainer.innerHTML = "";
            tooltip.hide();
            await renderer(contentContainer, {
                plugin,
                api,
                dataviewApi,
                fileName: getFileName(app, sourcePath),
                sourcePath,
                component,
                tooltip
            });
        } catch (error) {
            console.error(`Simple Time Tracker (${title}) Error:`, error);
            showMessage(
                contentContainer,
                "An error occurred while generating the report."
            );
        }
    };

    cont.innerHTML = "";
    cont.addClass("simple-time-tracker-stats-container");
    const header = cont.createDiv({
        cls: "simple-time-tracker-stats-header"
    });
    const titleGroup = header.createDiv({ cls: "stt-stats-title-group" });
    titleGroup.createEl("h4", { text: title });

    const refreshButton = titleGroup.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": "Refresh" }
    });

    setIcon(refreshButton, "refresh-cw");

    const contentContainer = cont.createDiv({
        cls: "simple-time-tracker-stats-content"
    });

    refreshButton.addEventListener("click", () => {
        setIcon(refreshButton, "loader");
        refreshButton.disabled = true;
        void renderReport(contentContainer).finally(() => {
            setIcon(refreshButton, "refresh-cw");
            refreshButton.disabled = false;
        });
    });

    void renderReport(contentContainer);
}

/** Dashboard charts below the tables, if enabled in the settings. */
async function renderCharts(
    container: ObsidianHTMLElement,
    context: ReportContext,
    pages: PageTrackers[],
    period: PeriodType,
    anchor: Date
): Promise<void> {
    const { plugin, api, tooltip } = context;
    if (!plugin.settings.showChartsInNotes) return;

    const categories = getCategories(plugin.settings);
    const firstDayOfWeek = plugin.settings.firstDayOfWeek;
    const range = getPeriodRange(period, anchor, firstDayOfWeek);
    const months = new MonthConfigCache(plugin.app);
    await months.load(range.days);

    const dayTargets = months.getDayTargets(range.days, categories);
    const stats = computePeriodStats(
        collectTrackedEntries(pages, categories, api),
        categories,
        range,
        dayTargets
    );
    const chartsEl = container.createDiv({
        cls: "stt-dashboard stt-note-charts"
    });

    const draw = (distributionMode: DistributionMode) => {
        const options: PeriodChartsOptions = {
            period,
            range,
            stats,
            series: getSeries(categories, stats),
            dayTargets,
            firstDayOfWeek,
            tooltip,
            format: (ms: number) => api.formatDuration(ms),
            getDayType: (day: Date) => months.getDayType(day),
            onSelect: (selected: PeriodType, date: Date) =>
                plugin.openDashboard(selected, date),
            distributionMode,
            onDistributionModeChange: draw
        };
        tooltip.hide();
        chartsEl.empty();
        renderHeatmapCard(chartsEl, options);
        renderChartGrid(chartsEl, options);
    };
    draw("note");
}

function getDayLabel(label: string, dayType: DayOffType | null): string {
    return dayType ? `*${label} - ${getDayOffLabel(dayType)}*` : label;
}

interface DayRow {
    cells: string[];
    work: number;
    other: number;
}

function buildDayRow(
    plugin: TimeTrackerStatisticsPlugin,
    api: STT_API,
    label: string,
    workingTime: WorkingTimeResult | undefined
): DayRow {
    const { workDuration, otherDuration } = getDayWorkAndOther(
        workingTime,
        getCategories(plugin.settings)
    );
    return {
        cells: [
            label,
            api.formatDuration(workDuration),
            api.formatDuration(otherDuration),
            workingTime ? printBreakdown(workingTime, api) : ""
        ],
        work: workDuration,
        other: otherDuration
    };
}

/**
 * Table of the days of a week with totals and the weekly deviation. With an
 * `accumulatedDeviation`, a row with the running total is added.
 */
function buildWeekTable(
    api: STT_API,
    rows: DayRow[],
    target: number,
    accumulatedDeviation: number | null
): string {
    let table = `| Day | Work duration | Other duration | Entries |\n`;
    table += `| --- | --- | --- | --- |\n`;

    let work = 0, other = 0;
    rows.forEach(row => {
        table += `| ${row.cells.join(" | ")} |\n`;
        work += row.work;
        other += row.other;
    });

    table += `| **Total** | **${api.formatDuration(work)}** `;
    table += `| **${api.formatDuration(other)}** |  |\n`;
    table += `| **Weekly deviation** | `;
    table += `**${formatSigned(api, work - target)}** |  |  |\n`;
    if (accumulatedDeviation !== null) {
        table += `| **Accumulated deviation** | `;
        table += `**${formatSigned(api, accumulatedDeviation)}** |  |  |\n`;
    }
    return table;
}

function buildNotesTable(
    api: STT_API,
    dataMap: Map<string, WorkingTimeResult>
): string {
    const noteDurations = new Map<string, number>();
    for (const workingTime of dataMap.values()) {
        for (let i = 0; i < workingTime.pageNames.length; i++) {
            const note = workingTime.pageNames[i] || "Unknown";
            const duration = workingTime.entryDurations[i] || 0;
            noteDurations.set(note, (noteDurations.get(note) || 0) + duration);
        }
    }

    const sortedNoteDurations = Array.from(noteDurations.entries())
        .sort((a, b) => b[1] - a[1]);

    let table = `| Note | Duration |\n|:---|:---|\n`;
    for (const [note, duration] of sortedNoteDurations) {
        table += `| ${escapeMarkdown(note)} | `;
        table += `${api.formatDuration(duration)} |\n`;
    }
    return table;
}

export function displayStatisticsDay(
    container: HTMLElement,
    plugin: TimeTrackerStatisticsPlugin,
    sourcePath: string,
    component: Component
): void {
    displayStatistics(
        container,
        plugin,
        sourcePath,
        component,
        "Daily statistics",
        renderDayReport
    );
}

async function renderDayReport(
    container: ObsidianHTMLElement,
    context: ReportContext
): Promise<void> {
    const { plugin, api, fileName } = context;
    const date = extractDate(fileName);
    if (!date) {
        showMessage(container, `Could not extract date (YYYY-MM-DD) ` +
            `from file name: "${fileName}"`);
        return;
    }
    const [year, month, dayOfMonth] = date.split("-").map(Number);
    const day = new Date(year ?? 0, (month ?? 1) - 1, dayOfMonth ?? 1);
    const settings = plugin.settings;
    const categories = getCategories(settings);

    const pages = await loadPageTrackers(
        context.dataviewApi,
        plugin.app,
        api
    );
    const entries = collectTrackedEntries(pages, categories, api);
    const months = new MonthConfigCache(plugin.app);
    await months.load([
        new Date(day.getFullYear(), day.getMonth(), 1),
        ...getWeekToDateRange(day, settings.firstDayOfWeek).days
    ]);
    const totals = computeCategoryTotals(entries, categories, months, day,
        settings);
    const dayEntries = entries
        .filter(entry => entry.dateKey === date)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));

    let dailyReportMd = "";
    if (totals.showTargets && !months.isTargetDay(day)) {
        const dayType = months.getDayType(day);
        const reason = dayType ? getDayOffLabel(dayType) : "Weekend";
        dailyReportMd += `_${reason}: no target for this day._\n\n`;
    }

    if (dayEntries.length === 0) {
        dailyReportMd += "_No tracked time found for this day._\n\n";
    }

    if (totals.tracked > 0) {
        dailyReportMd += `#### Totals\n\n` +
            `${buildCategoryTotalsTable(api, totals)}\n\n`;
    }

    if (getDailyTarget(categories) > 0) {
        const range = getPeriodRange("day", day, settings.firstDayOfWeek);
        const stats = computePeriodStats(entries, categories, range,
            months.getDayTargets(range.days, categories));
        const accumulated = getAccumulatedDeviation(
            entries,
            categories,
            months,
            range,
            stats,
            await getMonthCarryOver(plugin, api, pages, months, day),
            settings.firstDayOfWeek
        );
        dailyReportMd += `**Accumulated deviation** (incl. carry-over` +
            `${stats.targetIsPartial ? ", up to today" : ""}): ` +
            `**${formatSigned(api, accumulated)}**\n\n`;
    }

    if (dayEntries.length > 0) {
        let breakdownTable = `| Time | Category | Entry | Duration |\n`;
        breakdownTable += `|:---|:---|:---|:---|\n`;

        for (const entry of dayEntries) {
            const escPage = escapeMarkdown(entry.pageName.toUpperCase());
            const escEntry = escapeMarkdown(entry.name || "Unknown");
            breakdownTable += `| ${formatEntryTime(entry)} ` +
                `| ${escapeMarkdown(entry.category)} ` +
                `| **${escPage}-${escEntry}** ` +
                `| ${api.formatDuration(entry.duration)} |\n`;
        }

        dailyReportMd += `#### Entries breakdown\n\n${breakdownTable}`;
    }

    const runningTrackerMd = getRunningTrackerMarkdown(pages, api);
    await renderMarkdown(
        container,
        context,
        `${runningTrackerMd}\n${dailyReportMd}`
    );
    await renderCharts(container, context, pages, "day", day);
}

/** Totals per category on a day, with targets and fills if set. */
export interface CategoryTotals {
    rows: {
        name: string;
        /** Tracked on the day itself. */
        duration: number;
        /** Tracked over the day, or the week so far with weekly targets. */
        tracked: number;
        balance?: CategoryBalance;
    }[];
    weekly: boolean;
    showTargets: boolean;
    duration: number;
    tracked: number;
    deviation: number;
}

/** `months` must hold the months of the week up to `day`. */
export function computeCategoryTotals(
    entries: TrackedEntry[],
    categories: Category[],
    months: MonthConfigCache,
    day: Date,
    settings: TimeTrackerStatisticsSettings
): CategoryTotals {
    const showTargets = categories.some(isWorkCategory);
    const weekly = showTargets && settings.targetPeriod === "week";
    const range = weekly
        ? getWeekToDateRange(day, settings.firstDayOfWeek)
        : getPeriodRange("day", day, settings.firstDayOfWeek);
    const dateKey = toDateKey(day);
    const startKey = toDateKey(range.start);

    const durations = new Map<string, number>();
    const tracked = new Map<string, number>();
    for (const entry of entries) {
        if (entry.dateKey < startKey || entry.dateKey > dateKey) continue;
        tracked.set(entry.category,
            (tracked.get(entry.category) ?? 0) + entry.duration);
        if (entry.dateKey === dateKey) {
            durations.set(entry.category,
                (durations.get(entry.category) ?? 0) + entry.duration);
        }
    }

    const targetDays = range.days.filter(d => months.isTargetDay(d)).length;
    const balances = getCategoryBalances(
        categories,
        targetDays,
        getTrackedPieces(entries, startKey, dateKey)
    );
    const names = new Set<string>();
    if (targetDays > 0) {
        for (const category of categories.filter(isWorkCategory)) {
            names.add(category.name);
        }
    }
    for (const name of tracked.keys()) names.add(name);

    const stats = computePeriodStats(entries, categories, range,
        months.getDayTargets(range.days, categories));
    const sum = (map: Map<string, number>) =>
        Array.from(map.values()).reduce((total, time) => total + time, 0);
    return {
        rows: Array.from(names, name => ({
            name,
            duration: durations.get(name) ?? 0,
            tracked: tracked.get(name) ?? 0,
            balance: balances.get(name)
        })),
        weekly,
        showTargets,
        duration: sum(durations),
        tracked: sum(tracked),
        deviation: stats.work - stats.target
    };
}

/** A row of the totals table; `strong` for the total and deviation rows. */
export interface TotalsTableRow {
    cells: string[];
    strong: boolean;
}

/**
 * The totals table as text cells, shared by the day note and the
 * dashboard. `escape` is applied to category names.
 */
export function getCategoryTotalsTable(
    totals: CategoryTotals,
    format: (ms: number) => string,
    escape: (text: string) => string = text => text
): { header: string[]; rows: TotalsTableRow[] } {
    const { weekly, showTargets } = totals;
    const optional = (ms: number) => ms ? format(ms) : "";
    const signed = (ms: number) =>
        (ms >= 0 ? "+" : "-") + format(Math.abs(ms));

    const header = ["Category", "Duration"];
    if (weekly) header.push("Week so far");
    if (showTargets) header.push("Target", "Counted", "Remaining", "Overtime");

    const rows: TotalsTableRow[] = totals.rows.map(row => {
        const balance = row.balance;
        const fillNote = balance ? getFillNote(balance, format, escape) : "";
        const cells = [escape(row.name), format(row.duration)];
        if (weekly) {
            cells.push(format(row.tracked) + fillNote);
        } else {
            cells[1] += fillNote;
        }
        if (showTargets) {
            cells.push(
                optional(balance?.target ?? 0),
                balance ? format(getCountedTime(balance)) : "",
                optional(balance?.remaining ?? 0),
                optional(balance?.overtime ?? 0)
            );
        }
        return { cells, strong: false };
    });

    const blanks = showTargets ? ["", "", "", ""] : [];
    const total = ["Total", format(totals.duration)];
    if (weekly) total.push(format(totals.tracked));
    rows.push({ cells: [...total, ...blanks], strong: true });
    if (showTargets) {
        const deviation = signed(totals.deviation);
        rows.push({
            cells: weekly
                ? ["Deviation", "", deviation, ...blanks]
                : ["Deviation", deviation, ...blanks],
            strong: true
        });
    }
    return { header, rows };
}

function buildCategoryTotalsTable(
    api: STT_API,
    totals: CategoryTotals
): string {
    const { header, rows } = getCategoryTotalsTable(
        totals,
        (ms: number) => api.formatDuration(ms),
        escapeMarkdown
    );
    let table = `| ${header.join(" | ")} |\n`;
    table += `|${header.map(() => ":---").join("|")}|\n`;
    for (const { cells, strong } of rows) {
        const shown = cells.map((cell, i) =>
            cell && (strong || i === 0) ? `**${cell}**` : cell);
        table += `| ${shown.join(" | ")} |\n`;
    }
    return table;
}

/** Time of a category after fills: tracked, plus received, minus given. */
export function getCountedTime(balance: CategoryBalance): number {
    let time = balance.tracked;
    for (const received of balance.received.values()) time += received;
    for (const given of balance.given.values()) time -= given;
    return time;
}

/** Notes which part of the time filled the target of other categories. */
function getFillNote(
    balance: CategoryBalance,
    format: (ms: number) => string,
    escape: (text: string) => string
): string {
    const notes: string[] = [];
    for (const [name, time] of balance.received) {
        notes.push(`+${format(time)} from ${escape(name)}`);
    }
    for (const [name, time] of balance.given) {
        notes.push(`-${format(time)} to ${escape(name)}`);
    }
    return notes.length ? ` (${notes.join(", ")})` : "";
}

/**
 * Deviation carried into the month of `day`: set by hand in its monthly
 * note, or resolved from the months before.
 */
export async function getMonthCarryOver(
    plugin: TimeTrackerStatisticsPlugin,
    api: STT_API,
    pages: PageTrackers[],
    months: MonthConfigCache,
    day: Date
): Promise<number> {
    const { config, path } = months.get(day);
    if (path && config.deviation !== "auto") return config.deviation;
    const result = await resolveCarryOver(
        plugin,
        api,
        pages,
        day.getFullYear(),
        day.getMonth() + 1
    );
    return result.deviation;
}

export function displayStatisticsWeek(
    container: HTMLElement,
    plugin: TimeTrackerStatisticsPlugin,
    sourcePath: string,
    component: Component
): void {
    displayStatistics(
        container,
        plugin,
        sourcePath,
        component,
        "Weekly statistics",
        renderWeekReport
    );
}

async function renderWeekReport(
    container: ObsidianHTMLElement,
    context: ReportContext
): Promise<void> {
    const { plugin, api, fileName } = context;
    const match = fileName.match(/(\d{4})-?W(\d{1,2})/i);
    const year = Number(match?.[1]);
    const week = Number(match?.[2]);
    if (!match || week < 1 || week > 53) {
        showMessage(container, `Could not extract year and week ` +
            `(YYYY-Www) from file name: "${fileName}"`);
        return;
    }

    const firstDayOfWeek = plugin.settings.firstDayOfWeek;
    const start = getWeekStart(year, week, firstDayOfWeek);
    const { days } = getPeriodRange("week", start, firstDayOfWeek);
    const startKey = toDateKey(start);
    const endKey = toDateKey(days[days.length - 1] ?? start);
    const todayKey = toDateKey(new Date());

    const startMoment = safeMoment(startKey);
    const endMoment = safeMoment(endKey);
    container.createEl("h4", {
        text: `Week ${week} · ${startMoment.format("D MMM")} – ` +
            endMoment.format("D MMM YYYY")
    });

    const pages = await loadPageTrackers(
        context.dataviewApi,
        plugin.app,
        api
    );
    const months = new MonthConfigCache(plugin.app);
    await months.load(days);
    const dataMap = getWorkingTimeMap(pages, plugin, api, startKey, endKey);
    const categories = getCategories(plugin.settings);
    const dailyTarget = getDailyTarget(categories);

    let target = 0;
    const rows = days.map(day => {
        const dateKey = toDateKey(day);
        if (months.isTargetDay(day)) {
            target += getCountedTarget(
                dateKey,
                todayKey,
                dailyTarget,
                getDayWorkAndOther(dataMap.get(dateKey), categories)
                    .workDuration
            );
        }
        const label = getDayLabel(
            safeMoment(dateKey).format("D MMM (dd)"),
            months.getDayType(day)
        );
        return buildDayRow(plugin, api, label, dataMap.get(dateKey));
    });

    await renderMarkdown(
        container,
        context,
        buildWeekTable(api, rows, target, null)
    );
    container.createEl("h4", { text: "Notes" });
    await renderMarkdown(container, context, buildNotesTable(api, dataMap));
    await renderCharts(container, context, pages, "week", start);
}

export function displayStatisticsMonth(
    container: HTMLElement,
    plugin: TimeTrackerStatisticsPlugin,
    sourcePath: string,
    blockContent: string,
    component: Component
): void {
    displayStatistics(
        container,
        plugin,
        sourcePath,
        component,
        "Monthly statistics",
        (contentContainer, context) => renderMonthReport(
            contentContainer,
            context,
            parseMonthConfig(blockContent)
        )
    );
}

async function renderMonthReport(
    container: ObsidianHTMLElement,
    context: ReportContext,
    config: MonthConfig
): Promise<void> {
    const { plugin, api, fileName } = context;
    const year = extractYear(fileName);
    const monthIndex = extractMonth(fileName);
    if (!year || !monthIndex) {
        showMessage(container, `Could not extract year and month ` +
            `from file name: "${fileName}"`);
        return;
    }

    const dailyTarget = getDailyTarget(getCategories(plugin.settings));
    const monthDetails = getMonthDetails(year, monthIndex);
    const monthRange = getMonthRange(year, monthIndex);
    if (!monthDetails || !monthRange) throw new Error("Invalid month index");
    const { startDate, endDate } = monthRange;
    const todayKey = toDateKey(new Date());

    container.createEl("h4", { text: monthDetails.name });

    const pages = await loadPageTrackers(
        context.dataviewApi,
        plugin.app,
        api
    );

    let accumulatedDeviation = 0;
    if (config.deviation === "auto") {
        const carryOver = await resolveCarryOver(
            plugin,
            api,
            pages,
            year,
            monthIndex
        );
        accumulatedDeviation = carryOver.deviation;
        await renderMarkdown(
            container,
            context,
            getCarryOverMarkdown(carryOver, api)
        );
    } else {
        accumulatedDeviation = config.deviation;
    }
    const startDeviation = accumulatedDeviation;

    const monthlyDataMap = getWorkingTimeMap(
        pages,
        plugin,
        api,
        startDate,
        endDate
    );

    let weekRows: DayRow[] = [];
    let weeklyTarget = 0;
    const endOfWeekIndex = plugin.settings.firstDayOfWeek === 1 ? 0 : 6;

    for (let day = 1; day <= monthDetails.days; day++) {
        const currentMoment = safeMoment({
            year: year,
            month: monthIndex - 1,
            day: day
        });

        let weekNumber = currentMoment.clone().locale("en").week();
        if (plugin.settings.firstDayOfWeek === 1) {
            weekNumber = currentMoment.isoWeek();
        }

        const dateKey = currentMoment.format("YYYY-MM-DD");
        const row = buildDayRow(
            plugin,
            api,
            getDayLabel(
                `${day} (${currentMoment.format("dd")})`,
                getDayOffType(config, day)
            ),
            monthlyDataMap.get(dateKey)
        );
        weekRows.push(row);
        accumulatedDeviation += row.work;
        if (isTargetDay(year, monthIndex, day, config)) {
            weeklyTarget += getCountedTarget(
                dateKey, todayKey, dailyTarget, row.work
            );
        }

        const isLastDayOfMonth = day === monthDetails.days;
        if (currentMoment.day() === endOfWeekIndex || isLastDayOfMonth) {
            accumulatedDeviation -= weeklyTarget;
            container.createEl("h5", { text: `Week ${weekNumber}` });
            await renderMarkdown(
                container,
                context,
                buildWeekTable(api, weekRows, weeklyTarget, accumulatedDeviation)
            );
            weeklyTarget = 0;
            weekRows = [];
        }
    }

    container.createEl("h4", { text: "End of month summary" });
    await renderMarkdown(
        container,
        context,
        buildMonthSummary(
            api,
            accumulatedDeviation - startDeviation,
            accumulatedDeviation,
            config
        ) + "\n\n" +
            buildNotesTable(api, monthlyDataMap)
    );
    await renderCharts(
        container,
        context,
        pages,
        "month",
        new Date(year, monthIndex - 1, 1)
    );
}

function getCarryOverMarkdown(
    carryOver: CarryOverResult,
    api: STT_API
): string {
    if (!carryOver.source) {
        return "_No previous month note found; starting at 0._";
    }
    const { path, basename } = carryOver.source;
    const value = formatSigned(api, carryOver.deviation);
    return `**Carried over:** ${value} from [[${path}|${basename}]]`;
}

function buildMonthSummary(
    api: STT_API,
    monthlyDeviation: number,
    accumulatedDeviation: number,
    config: MonthConfig
): string {
    let table = `| Metric | Value |\n| --- | --- |\n`;
    table += `| **Monthly deviation** | `;
    table += `**${formatSigned(api, monthlyDeviation)}** |\n`;
    table += `| **Total accumulated deviation** | `;
    table += `**${formatSigned(api, accumulatedDeviation)}** |\n`;
    table += `| **Total accumulated deviation (ms)** | `;
    table += `**${accumulatedDeviation}** |\n`;
    table += `| **Number of days off** | **${config.daysOff.length}** |\n`;
    table += `| **Number of vacation days** | `;
    table += `**${config.vacationDays.length}** |\n`;
    table += `| **Number of sick days** | **${config.sickDays.length}** |\n`;
    return table;
}

export function displayStatisticsYear(
    container: HTMLElement,
    plugin: TimeTrackerStatisticsPlugin,
    sourcePath: string,
    component: Component
): void {
    displayStatistics(
        container,
        plugin,
        sourcePath,
        component,
        "Yearly statistics",
        renderYearReport
    );
}

async function renderYearReport(
    container: ObsidianHTMLElement,
    context: ReportContext
): Promise<void> {
    const { plugin, api, fileName } = context;
    const year = extractYear(fileName);
    if (!year) {
        showMessage(container, `Could not extract year (YYYY) ` +
            `from file name: "${fileName}"`);
        return;
    }

    const categories = getCategories(plugin.settings);
    const dailyTarget = getDailyTarget(categories);
    const { days } = getPeriodRange(
        "year",
        new Date(year, 0, 1),
        plugin.settings.firstDayOfWeek
    );
    const todayKey = toDateKey(new Date());

    container.createEl("h4", { text: String(year) });

    const pages = await loadPageTrackers(
        context.dataviewApi,
        plugin.app,
        api
    );
    const months = new MonthConfigCache(plugin.app);
    await months.load(days);
    const dataMap = getWorkingTimeMap(
        pages,
        plugin,
        api,
        `${year}-01-01`,
        `${year}-12-31`
    );

    let table = `| Month | Work duration | Other duration | Target ` +
        `| Deviation | Days off | Vacation days | Sick days |\n`;
    table += `| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
    const totals = { work: 0, other: 0, target: 0, off: 0, vacation: 0, sick: 0 };

    for (let monthIndex = 1; monthIndex <= 12; monthIndex++) {
        const first = new Date(year, monthIndex - 1, 1);
        const monthDays = days.filter(d => d.getMonth() === monthIndex - 1);
        let work = 0, other = 0, target = 0;
        for (const day of monthDays) {
            const dateKey = toDateKey(day);
            const durations = getDayWorkAndOther(
                dataMap.get(dateKey),
                categories
            );
            work += durations.workDuration;
            other += durations.otherDuration;
            if (months.isTargetDay(day)) {
                target += getCountedTarget(
                    dateKey, todayKey, dailyTarget, durations.workDuration
                );
            }
        }

        const { config, path } = months.get(first);
        const name = getMonthDetails(year, monthIndex)?.name ?? "";
        const label = path ? `[[${path}\\|${name}]]` : name;
        table += `| ${label} | ${api.formatDuration(work)} ` +
            `| ${api.formatDuration(other)} ` +
            `| ${api.formatDuration(target)} ` +
            `| ${formatSigned(api, work - target)} ` +
            `| ${config.daysOff.length} | ${config.vacationDays.length} ` +
            `| ${config.sickDays.length} |\n`;

        totals.work += work;
        totals.other += other;
        totals.target += target;
        totals.off += config.daysOff.length;
        totals.vacation += config.vacationDays.length;
        totals.sick += config.sickDays.length;
    }

    table += `| **Total** | **${api.formatDuration(totals.work)}** ` +
        `| **${api.formatDuration(totals.other)}** ` +
        `| **${api.formatDuration(totals.target)}** ` +
        `| **${formatSigned(api, totals.work - totals.target)}** ` +
        `| **${totals.off}** | **${totals.vacation}** ` +
        `| **${totals.sick}** |\n`;

    await renderMarkdown(container, context, table);
    container.createEl("h4", { text: "Notes" });
    await renderMarkdown(container, context, buildNotesTable(api, dataMap));
    await renderCharts(container, context, pages, "year", new Date(year, 0, 1));
}

function printBreakdown(workingTime: WorkingTimeResult, api: STT_API): string {
    const { pageNames, entryNames, entryDurations } = workingTime;
    return pageNames.map((pageName: string, i: number) => {
        const escName = escapeMarkdown(pageName);
        const escEntry = escapeMarkdown(entryNames[i] ?? "Unknown");
        const durFmt = api.formatDuration(entryDurations[i] ?? 0);
        return `${escName}-${escEntry}: ${durFmt}`;
    }).join('<br>');
}
