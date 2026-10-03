import {
    MarkdownRenderer,
    setIcon,
    App,
    moment,
    Component
} from "obsidian";
import { getAPI } from "obsidian-dataview";
import TimeTrackerStatisticsPlugin from "./main";
import { Category } from "./settings";
import {
    MonthConfig,
    CarryOverResult,
    parseMonthConfig,
    getMonthDetails,
    getMonthRange,
    getDayWorkAndOther,
    isTargetDay,
    resolveCarryOver
} from "./carry-over";

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

interface MinimalDataviewApi {
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

function getSTTApi(app: App): STT_API | null {
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

function parseTargetTime(target: string): number {
    if (!target) return 0;
    return safeMoment.duration(target).asMilliseconds();
}

export function isWorkCategory(category: Category): boolean {
    return parseTargetTime(category.target) > 0;
}

export function getDailyTarget(categories: Category[]): number {
    return categories
        .filter(isWorkCategory)
        .reduce((total, c) => total + parseTargetTime(c.target), 0);
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

async function loadPageTrackers(
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

export function getWorkingTimeMap(
    pages: PageTrackers[],
    plugin: TimeTrackerStatisticsPlugin,
    api: STT_API,
    startDate: string,
    endDate: string
): Map<string, WorkingTimeResult> {
    const resultMap = new Map<string, WorkingTimeResult>();
    const startMoment = safeMoment(startDate);
    const endMoment = safeMoment(endDate);

    function processEntries(
        entries: Entry[],
        pageName: string,
        category: string,
        sttApi: STT_API,
        parentName = ''
    ) {
        entries.forEach(entry => {
            const dateStr = getLocalDateKey(entry.startTime);

            if (dateStr) {
                const entryDate = safeMoment(dateStr);
                const isAfterStart = entryDate.isSameOrAfter(startMoment);
                const isBeforeEnd = entryDate.isSameOrBefore(endMoment);

                if (isAfterStart && isBeforeEnd) {
                    if (!resultMap.has(dateStr)) {
                        resultMap.set(dateStr, createEmptyResult());
                    }
                    const result = resultMap.get(dateStr)!;
                    const duration = sttApi.getDuration(entry);

                    let fullName = entry.name;
                    if (parentName) {
                        fullName = `${parentName} -> ${entry.name}`;
                    }

                    result.totalDuration += duration;
                    result.fileCategories.push(category);
                    result.pageNames.push(pageName);
                    result.entryNames.push(fullName);
                    result.entryDurations.push(duration);
                }
            }

            if (entry.subEntries) {
                let newParentName = entry.name;
                if (parentName) {
                    newParentName = `${parentName} -> ${entry.name}`;
                }
                processEntries(
                    entry.subEntries,
                    pageName,
                    category,
                    sttApi,
                    newParentName
                );
            }
        });
    }

    for (const { basename, tags, trackers } of pages) {
        const pageTags = new Set(tags);

        let category = "Other";
        for (const cat of plugin.settings.categories) {
            if (cat.tags.some((tag: string) => pageTags.has(tag))) {
                category = cat.name;
                break;
            }
        }

        for (const tracker of trackers) {
            processEntries(tracker.entries, basename, category, api);
        }
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

export function displayStatisticsDay(
    container: HTMLElement,
    plugin: TimeTrackerStatisticsPlugin,
    sourcePath: string,
    component: Component
): void {
    const cont = container as ObsidianHTMLElement;
    const app = plugin.app;
    const api = getSTTApi(app);

    if (!api) {
        cont.innerHTML = "";
        cont.createEl("p", { text: "Simple time tracker is required." });
        return;
    }

    const renderReport = async (contentContainer: ObsidianHTMLElement) => {
        const dataviewApi = getAPI(app) as unknown as MinimalDataviewApi;
        if (!dataviewApi) {
            contentContainer.innerHTML = "";
            contentContainer.createEl("p", {
                text: "Dataview plugin is not enabled..."
            });
            return;
        }

        const vault = app.vault as unknown as SafeVault;
        const sourceFile = vault.getAbstractFileByPath(sourcePath);
        let fileName = "";

        if (sourceFile && typeof sourceFile.name === "string") {
            fileName = sourceFile.name;
        } else {
            const parts = sourcePath.split('/');
            fileName = parts[parts.length - 1] || "";
        }

        const date = extractDate(fileName);

        if (!date) {
            contentContainer.innerHTML = "";
            const msg = `Could not extract date (YYYY-MM-DD) from ` +
                `file name: "${fileName}"`;
            contentContainer.createEl("p", { text: msg });
            return;
        }

        try {
            contentContainer.innerHTML = "";
            const pages = await loadPageTrackers(dataviewApi, app, api);
            const runningTrackerMd = getRunningTrackerMarkdown(pages, api);

            const resultMap = getWorkingTimeMap(
                pages,
                plugin,
                api,
                date,
                date
            );
            const workingTime = resultMap.get(date) || createEmptyResult();

            let dailyReportMd = "";
            if (workingTime.totalDuration === 0) {
                dailyReportMd = "_No tracked time found for this day._";
            } else {
                const categoryTotals: { [key: string]: number } = {};
                workingTime.entryDurations.forEach((dur, i) => {
                    const category = workingTime.fileCategories[i] || "Unknown";
                    if (!categoryTotals[category]) {
                        categoryTotals[category] = 0;
                    }
                    categoryTotals[category] += dur;
                });

                const showTargetColumns = plugin.settings.categories.some(
                    isWorkCategory
                );

                let totalsTable = `| Category | Duration |`;
                if (showTargetColumns) {
                    totalsTable += ` Remaining | Overtime |\n`;
                    totalsTable += `|:---|:---|:---|:---|\n`;
                } else {
                    totalsTable += `\n|:---|:---|\n`;
                }

                for (const categoryName in categoryTotals) {
                    const isName = (c: Category) => c.name === categoryName;
                    const category = plugin.settings.categories.find(isName);
                    const trackedDur = categoryTotals[categoryName] ?? 0;
                    let remainingStr = "";
                    let overtimeStr = "";

                    if (category && category.target) {
                        const targetMs = parseTargetTime(category.target);
                        if (targetMs > 0) {
                            const diffMs = trackedDur - targetMs;
                            if (diffMs < 0) {
                                remainingStr = api.formatDuration(-diffMs);
                            } else {
                                overtimeStr = api.formatDuration(diffMs);
                            }
                        }
                    }

                    const escName = escapeMarkdown(categoryName);
                    const durFmt = api.formatDuration(trackedDur);
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
                if (showTargetColumns) {
                    totalsTable += ` | |`;
                }

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

                dailyReportMd = `#### Totals\n\n${totalsTable}\n\n`;
                dailyReportMd += `#### Entries breakdown\n\n${breakdownTable}`;
            }

            const finalMarkdown = `${runningTrackerMd}\n${dailyReportMd}`;
            contentContainer.innerHTML = "";
            await safeRenderer.render(
                app,
                finalMarkdown,
                contentContainer,
                sourcePath,
                component
            );

        } catch (error) {
            console.error("Simple Time Tracker (Statistics) Error:", error);
            contentContainer.innerHTML = "";
            contentContainer.createEl("p", {
                text: "An error occurred while generating the report."
            });
        }
    };

    cont.innerHTML = "";
    cont.addClass("simple-time-tracker-stats-container");
    const header = cont.createDiv({
        cls: "simple-time-tracker-stats-header"
    });
    const titleGroup = header.createDiv({ cls: "stt-stats-title-group" });
    titleGroup.createEl("h4", { text: "Daily statistics" });

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

export function displayStatisticsMonth(
    container: HTMLElement,
    plugin: TimeTrackerStatisticsPlugin,
    sourcePath: string,
    blockContent: string,
    component: Component
): void {
    const cont = container as ObsidianHTMLElement;
    const app = plugin.app;
    const api = getSTTApi(app);

    if (!api) {
        cont.innerHTML = "";
        cont.createEl("p", { text: "Simple time tracker is required." });
        return;
    }

    const renderReport = async (contentContainer: ObsidianHTMLElement) => {
        const dataviewApi = getAPI(app) as unknown as MinimalDataviewApi;
        if (!dataviewApi) {
            contentContainer.innerHTML = "";
            contentContainer.createEl("p", {
                text: "Dataview plugin is not enabled..."
            });
            return;
        }

        const config = parseMonthConfig(blockContent);

        const vault = app.vault as unknown as SafeVault;
        const sourceFile = vault.getAbstractFileByPath(sourcePath);
        let fileName = "";

        if (sourceFile && typeof sourceFile.name === "string") {
            fileName = sourceFile.name;
        } else {
            const parts = sourcePath.split('/');
            fileName = parts[parts.length - 1] || "";
        }

        const year = extractYear(fileName);
        const monthIndex = extractMonth(fileName);

        if (!year || !monthIndex) {
            contentContainer.innerHTML = "";
            const msg = `Could not extract year and month from ` +
                `file name: "${fileName}"`;
            contentContainer.createEl("p", { text: msg });
            return;
        }

        try {
            contentContainer.innerHTML = "";
            await printWorkingTimeOfMonth(
                contentContainer,
                dataviewApi,
                plugin,
                api,
                year,
                monthIndex,
                config,
                sourcePath,
                component
            );
        } catch (error) {
            console.error("Simple Time Tracker (Monthly) Error:", error);
            contentContainer.innerHTML = "";
            contentContainer.createEl("p", {
                text: "An error occurred while generating the report."
            });
        }
    };

    cont.innerHTML = "";
    cont.addClass("simple-time-tracker-stats-container");
    const header = cont.createDiv({
        cls: "simple-time-tracker-stats-header"
    });
    const titleGroup = header.createDiv({ cls: "stt-stats-title-group" });
    titleGroup.createEl("h4", { text: "Monthly statistics" });

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

async function printWorkingTimeOfMonth(
    container: ObsidianHTMLElement,
    dataviewApi: MinimalDataviewApi,
    plugin: TimeTrackerStatisticsPlugin,
    api: STT_API,
    year: number,
    monthIndex: number,
    config: MonthConfig,
    sourcePath: string,
    component: Component
) {
    const { daysOff, vacationDays, sickDays } = config;
    const dailyTarget = getDailyTarget(plugin.settings.categories);

    const monthDetails = getMonthDetails(year, monthIndex);
    const monthRange = getMonthRange(year, monthIndex);
    if (!monthDetails || !monthRange) throw new Error("Invalid month index");
    const { startDate, endDate } = monthRange;

    container.createEl("h4", { text: monthDetails.name });

    const pages = await loadPageTrackers(dataviewApi, plugin.app, api);

    let deviation = 0;
    if (config.deviation === "auto") {
        const carryOver = await resolveCarryOver(
            plugin,
            api,
            pages,
            year,
            monthIndex
        );
        deviation = carryOver.deviation;
        void safeRenderer.render(
            plugin.app,
            getCarryOverMarkdown(carryOver, api),
            container.createDiv(),
            sourcePath,
            component
        );
    } else {
        deviation = config.deviation;
    }

    const monthlyDataMap = getWorkingTimeMap(
        pages,
        plugin,
        api,
        startDate,
        endDate
    );

    let weekRows: string[][] = [];
    let weeklyWorkTotal = 0;
    let weeklyOtherTotal = 0;
    let weeklyTarget = 0;
    let accumulatedDeviation = deviation;

    const endOfWeekIndex = plugin.settings.firstDayOfWeek === 1 ? 0 : 6;

    for (let i = 1; i <= monthDetails.days; i++) {
        const day = i;
        const currentMoment = safeMoment({
            year: year,
            month: monthIndex - 1,
            day: day
        });
        const dayOfWeek = currentMoment.format("dd");

        let weekNumber = currentMoment.clone().locale("en").week();
        if (plugin.settings.firstDayOfWeek === 1) {
            weekNumber = currentMoment.isoWeek();
        }

        const dateKey = currentMoment.format("YYYY-MM-DD");
        const workingTime = monthlyDataMap.get(dateKey);

        const { workDuration, otherDuration } = getDayWorkAndOther(
            workingTime,
            plugin.settings.categories
        );

        weeklyWorkTotal += workDuration;
        weeklyOtherTotal += otherDuration;

        if (isTargetDay(year, monthIndex, day, config)) {
            weeklyTarget += dailyTarget;
        }

        let dayLabel = `${day} (${dayOfWeek})`;
        if (daysOff.includes(day)) {
            dayLabel = `*${day} (${dayOfWeek}) - Day Off*`;
        } else if (vacationDays.includes(day)) {
            dayLabel = `*${day} (${dayOfWeek}) - Vacation*`;
        } else if (sickDays.includes(day)) {
            dayLabel = `*${day} (${dayOfWeek}) - Sick*`;
        }

        weekRows.push([
            dayLabel,
            api.formatDuration(workDuration),
            api.formatDuration(otherDuration),
            workingTime ? printBreakdown(workingTime, api) : ""
        ]);

        const dayOfWeekIndex = currentMoment.day();
        const isLastDayOfMonth = day === monthDetails.days;

        if (dayOfWeekIndex === endOfWeekIndex || isLastDayOfMonth) {
            accumulatedDeviation = renderWeekTableWithApp(
                plugin.app,
                container,
                api,
                weekRows,
                weeklyWorkTotal,
                weeklyOtherTotal,
                weeklyTarget,
                accumulatedDeviation,
                weekNumber,
                sourcePath,
                component
            );
            weeklyWorkTotal = 0;
            weeklyOtherTotal = 0;
            weeklyTarget = 0;
            weekRows = [];
        }
    }

    container.createEl("h4", { text: "End of month summary" });
    renderEndOfMonthSummary(
        plugin.app,
        container,
        api,
        accumulatedDeviation,
        daysOff,
        vacationDays,
        sickDays,
        sourcePath,
        component,
        monthlyDataMap
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
    const sign = carryOver.deviation >= 0 ? "+" : "-";
    const value = api.formatDuration(Math.abs(carryOver.deviation));
    return `**Carried over:** ${sign}${value} from [[${path}|${basename}]]`;
}

function renderEndOfMonthSummary(
    app: App,
    container: ObsidianHTMLElement,
    api: STT_API,
    accumulatedDeviation: number,
    daysOff: number[],
    vacationDays: number[],
    sickDays: number[],
    sourcePath: string,
    component: Component,
    monthlyDataMap: Map<string, WorkingTimeResult>
) {
    const headers = ["Metric", "Value"];
    let table = `| ${headers[0]} | ${headers[1]} |\n| --- | --- |\n`;

    const accDevFmt = api.formatDuration(Math.abs(accumulatedDeviation));
    const sign = accumulatedDeviation >= 0 ? "+" : "-";
    const accumulatedDeviationFormatted = `${sign}${accDevFmt}`;

    table += `| **Total accumulated deviation** | `;
    table += `**${accumulatedDeviationFormatted}** |\n`;
    table += `| **Total accumulated deviation (ms)** | `;
    table += `**${accumulatedDeviation}** |\n`;
    table += `| **Number of days off** | **${daysOff.length}** |\n`;
    table += `| **Number of vacation days** | **${vacationDays.length}** |\n`;
    table += `| **Number of sick days** | **${sickDays.length}** |\n`;

    const noteDurations = new Map<string, number>();
    for (const workingTime of monthlyDataMap.values()) {
        for (let i = 0; i < workingTime.pageNames.length; i++) {
            const note = workingTime.pageNames[i] || "Unknown";
            const duration = workingTime.entryDurations[i] || 0;
            noteDurations.set(note, (noteDurations.get(note) || 0) + duration);
        }
    }

    const sortedNoteDurations = Array.from(noteDurations.entries())
        .sort((a, b) => b[1] - a[1]);

    let breakdownTable = `\n\n| Note | Duration |\n|:---|:---|\n`;
    for (const [note, duration] of sortedNoteDurations) {
        const escNote = escapeMarkdown(note);
        const durFmt = api.formatDuration(duration);
        breakdownTable += `| ${escNote} | ${durFmt} |\n`;
    }

    table += breakdownTable;

    void safeRenderer.render(
        app,
        table,
        container.createDiv(),
        sourcePath,
        component
    );
}

function renderWeekTableWithApp(
    app: App,
    container: ObsidianHTMLElement,
    api: STT_API,
    rows: string[][],
    weeklyWorkTotal: number,
    weeklyOtherTotal: number,
    targetTimeForWeek: number,
    accumulatedDeviation: number,
    weekNumber: number,
    sourcePath: string,
    component: Component
): number {
    container.createEl("h5", { text: `Week ${weekNumber}` });
    const headers = ["Day", "Work duration", "Other duration", "Entries"];
    let table = `| ${headers[0]} | ${headers[1]} `;
    table += `| ${headers[2]} | ${headers[3]} |\n`;
    table += `| --- | --- | --- | --- |\n`;

    rows.forEach(row => {
        table += `| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} |\n`;
    });

    const workTotalFormatted = api.formatDuration(weeklyWorkTotal);
    const otherTotalFormatted = api.formatDuration(weeklyOtherTotal);

    const weeklyDeviation = weeklyWorkTotal - targetTimeForWeek;
    accumulatedDeviation += weeklyDeviation;

    let weeklyDeviationFormatted = api.formatDuration(
        Math.abs(weeklyDeviation)
    );
    weeklyDeviationFormatted = (weeklyDeviation >= 0 ? "+" : "-") +
        weeklyDeviationFormatted;

    let accDeviationFormatted = api.formatDuration(
        Math.abs(accumulatedDeviation)
    );
    accDeviationFormatted = (accumulatedDeviation >= 0 ? "+" : "-") +
        accDeviationFormatted;

    table += `| **Total** | **${workTotalFormatted}** `;
    table += `| **${otherTotalFormatted}** |  |\n`;
    table += `| **Weekly deviation** | **${weeklyDeviationFormatted}** `;
    table += `|  |  |\n`;
    table += `| **Accumulated deviation** | **${accDeviationFormatted}** `;
    table += `|  |  |\n`;

    void safeRenderer.render(
        app,
        table,
        container.createDiv(),
        sourcePath,
        component
    );
    return accumulatedDeviation;
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
