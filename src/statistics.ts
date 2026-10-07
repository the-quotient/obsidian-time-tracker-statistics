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
    tracked: Map<string, number>
): Map<string, CategoryBalance> {
    const rules = categories.filter(isWorkCategory).map(category => ({
        name: category.name,
        target: getCategoryTarget(category) * targetDays,
        fills: category.fills ?? []
    }));
    return computeCategoryBalances(rules, tracked);
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
    const categories = getCategories(plugin.settings);
    const showTargetColumns = categories.some(isWorkCategory);
    const weekly = showTargetColumns &&
        plugin.settings.targetPeriod === "week";
    const balanceRange = weekly
        ? getWeekToDateRange(day, plugin.settings.firstDayOfWeek)
        : getPeriodRange("day", day, plugin.settings.firstDayOfWeek);

    const pages = await loadPageTrackers(
        context.dataviewApi,
        plugin.app,
        api
    );
    const months = new MonthConfigCache(plugin.app);
    await months.load(balanceRange.days);
    const isTarget = months.isTargetDay(day);
    const dayType = months.getDayType(day);
    const targetDays = balanceRange.days
        .filter(d => months.isTargetDay(d)).length;

    const resultMap = getWorkingTimeMap(
        pages,
        plugin,
        api,
        toDateKey(balanceRange.start),
        date
    );
    const workingTime = resultMap.get(date) || createEmptyResult();
    const dayTotals = getCategoryTotals([workingTime]);
    const balanceTotals = weekly
        ? getCategoryTotals(resultMap.values())
        : dayTotals;
    const balanceTotal = Array.from(balanceTotals.values())
        .reduce((total, time) => total + time, 0);

    let dailyReportMd = "";
    if (showTargetColumns && !isTarget) {
        const reason = dayType ? getDayOffLabel(dayType) : "Weekend";
        dailyReportMd += `_${reason}: no target for this day._\n\n`;
    }

    if (workingTime.totalDuration === 0) {
        dailyReportMd += "_No tracked time found for this day._\n\n";
    }

    if (balanceTotal > 0) {
        const categoryNames = new Set<string>();
        if (targetDays > 0) {
            for (const category of categories.filter(isWorkCategory)) {
                categoryNames.add(category.name);
            }
        }
        for (const name of balanceTotals.keys()) categoryNames.add(name);

        let totalsTable = `| Category | Duration |`;
        if (weekly) {
            totalsTable += ` Week so far | Remaining | Overtime |\n`;
            totalsTable += `|:---|:---|:---|:---|:---|\n`;
        } else if (showTargetColumns) {
            totalsTable += ` Remaining | Overtime |\n`;
            totalsTable += `|:---|:---|:---|:---|\n`;
        } else {
            totalsTable += `\n|:---|:---|\n`;
        }

        const balances = getCategoryBalances(
            categories,
            targetDays,
            balanceTotals
        );

        let work = 0;
        for (const categoryName of categoryNames) {
            const balance = balances.get(categoryName);
            const balanceDur = balanceTotals.get(categoryName) ?? 0;
            if (balance) work += balanceDur;
            let remainingStr = "";
            let overtimeStr = "";
            if (balance?.remaining) {
                remainingStr = api.formatDuration(balance.remaining);
            }
            if (balance?.overtime) {
                overtimeStr = api.formatDuration(balance.overtime);
            }

            const escName = escapeMarkdown(categoryName);
            const fillNote = balance ? getFillNote(api, balance) : "";
            let durFmt = api.formatDuration(dayTotals.get(categoryName) ?? 0);
            if (weekly) {
                durFmt += ` | ${api.formatDuration(balanceDur)}${fillNote}`;
            } else {
                durFmt += fillNote;
            }
            totalsTable += `| **${escName}** | ${durFmt} |`;

            if (showTargetColumns) {
                totalsTable += ` ${remainingStr} | ${overtimeStr} |\n`;
            } else {
                totalsTable += `\n`;
            }
        }

        totalsTable += `| **Total** | `;
        const tDur = api.formatDuration(workingTime.totalDuration);
        totalsTable += `**${tDur}** |`;
        if (weekly) {
            totalsTable += ` **${api.formatDuration(balanceTotal)}** |`;
        }
        if (showTargetColumns) {
            totalsTable += ` | |\n`;
            const deviation = work - getDailyTarget(categories) * targetDays;
            totalsTable += weekly
                ? `| **Deviation** | | `
                : `| **Deviation** | `;
            totalsTable += `**${formatSigned(api, deviation)}** | | |`;
        }

        dailyReportMd += `#### Totals\n\n${totalsTable}\n\n`;
    }

    if (workingTime.totalDuration > 0) {
        let breakdownTable = `| Category | Entry | Duration |\n`;
        breakdownTable += `|:---|:---|:---|\n`;

        workingTime.fileCategories.forEach((category, i) => {
            const pageName = workingTime.pageNames[i]?.toUpperCase()
                || "UNKNOWN";
            const entryName = workingTime.entryNames[i] || "Unknown";
            const duration = workingTime.entryDurations[i] || 0;

            const escPage = escapeMarkdown(pageName);
            const escEntry = escapeMarkdown(entryName);
            const entryKey = `**${escPage}-${escEntry}**`;
            const durStr = api.formatDuration(duration);
            const escCat = escapeMarkdown(category);

            breakdownTable += `| ${escCat} | ${entryKey} `;
            breakdownTable += `| ${durStr} |\n`;
        });

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

function getCategoryTotals(
    results: Iterable<WorkingTimeResult>
): Map<string, number> {
    const totals = new Map<string, number>();
    for (const result of results) {
        result.entryDurations.forEach((duration, i) => {
            const category = result.fileCategories[i] || "Unknown";
            totals.set(category, (totals.get(category) ?? 0) + duration);
        });
    }
    return totals;
}

/** Notes which part of the time filled the target of other categories. */
function getFillNote(api: STT_API, balance: CategoryBalance): string {
    const notes: string[] = [];
    for (const [name, time] of balance.received) {
        notes.push(`+${api.formatDuration(time)} from ${escapeMarkdown(name)}`);
    }
    for (const [name, time] of balance.given) {
        notes.push(`-${api.formatDuration(time)} to ${escapeMarkdown(name)}`);
    }
    return notes.length ? ` (${notes.join(", ")})` : "";
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
    const dailyTarget = getDailyTarget(getCategories(plugin.settings));

    let target = 0;
    const rows = days.map(day => {
        const dateKey = toDateKey(day);
        if (months.isTargetDay(day) && dateKey <= todayKey) {
            target += dailyTarget;
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
        if (isTargetDay(year, monthIndex, day, config) &&
            dateKey <= todayKey) {
            weeklyTarget += dailyTarget;
        }

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
            if (months.isTargetDay(day) && dateKey <= todayKey) {
                target += dailyTarget;
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
