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

interface STTMomentDuration {
    asMilliseconds(): number;
}
interface STTMoment {
    isSameOrAfter(m: STTMoment): boolean;
    isSameOrBefore(m: STTMoment): boolean;
    format(fmt: string): string;
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
    startTime: string;
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

interface WorkingTimeResult {
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

function parseTargetTime(target: string): number {
    if (!target) return 0;
    return safeMoment.duration(target).asMilliseconds();
}

function extractYear(inputString: string): number | null {
    const yearMatch = String(inputString).match(/\b\d{4}\b/);
    return yearMatch ? Number(yearMatch[0]) : null;
}

function extractMonth(inputString: string): number | null {
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

async function getWorkingTimeMap(
    dataviewApi: MinimalDataviewApi,
    plugin: TimeTrackerStatisticsPlugin,
    startDate: string,
    endDate: string
): Promise<Map<string, WorkingTimeResult>> {
    const api = getSTTApi(plugin.app);
    if (!api) throw new Error("Simple time tracker API not found");

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
            const dateStr = extractDate(entry.startTime);

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

    for (const page of dataviewApi.pages('""')) {
        if (!page.file?.path) continue;

        const filePath = page.file.path;
        const vault = plugin.app.vault as unknown as SafeVault;
        const file = vault.getAbstractFileByPath(filePath);

        if (!file || typeof file.basename !== "string") {
            continue;
        }

        const trackers = await api.loadAllTrackers(filePath);
        const pageTags = new Set(page.file.tags ?? []);

        let category = "Other";
        for (const cat of plugin.settings.categories) {
            if (cat.tags.some((tag: string) => pageTags.has(tag))) {
                category = cat.name;
                break;
            }
        }

        for (const { tracker } of trackers) {
            processEntries(tracker.entries, file.basename, category, api);
        }
    }

    return resultMap;
}

async function getRunningTrackerMarkdown(
    dataviewApi: MinimalDataviewApi,
    app: App
): Promise<string> {
    const api = getSTTApi(app);
    if (!api) return "";

    for (const page of dataviewApi.pages('""')) {
        if (!page.file?.path) continue;

        const filePath = page.file.path;
        const trackers = await api.loadAllTrackers(filePath);
        for (const { tracker } of trackers) {
            if (api.isRunning(tracker)) {
                const name = page.file.name ?? 'Untitled';
                return `**Currently running:** [[${filePath}|${name}]]\n` +
                    `\n---\n`;
            }
        }
    }
    return "_No tracker is currently running._\n";
}

export function displayStatisticsDay(
    container: HTMLElement,
    plugin: TimeTrackerStatisticsPlugin,
    sourcePath: string,
    _blockContent: string | undefined,
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
            const runningTrackerMd = await getRunningTrackerMarkdown(
                dataviewApi,
                app
            );

            const resultMap = await getWorkingTimeMap(
                dataviewApi,
                plugin,
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
                    (c: Category) => c.target
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

        const deviation = typeof settings.deviation === 'number'
            ? settings.deviation : 0;
        const daysOff = Array.isArray(settings.daysOff)
            ? (settings.daysOff as number[]) : [];
        const vacationDays = Array.isArray(settings.vacationDays)
            ? (settings.vacationDays as number[]) : [];
        const sickDays = Array.isArray(settings.sickDays)
            ? (settings.sickDays as number[]) : [];

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
                deviation,
                daysOff,
                vacationDays,
                sickDays,
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
    deviation: number,
    daysOff: number[],
    vacationDays: number[],
    sickDays: number[],
    component: Component
) {
    const monthLookupTable: { name: string, days: number }[] = [
        { name: "January", days: 31 }, { name: "February", days: 28 },
        { name: "March", days: 31 }, { name: "April", days: 30 },
        { name: "May", days: 31 }, { name: "June", days: 30 },
        { name: "July", days: 31 }, { name: "August", days: 31 },
        { name: "September", days: 30 }, { name: "October", days: 31 },
        { name: "November", days: 30 }, { name: "December", days: 31 }
    ];

    const HOURS_PER_DAY_OFF = 8 * 60 * 60 * 1000;
    const allDaysOff = new Set([...daysOff, ...vacationDays, ...sickDays]);

    const isLeapYear = (y: number) => {
        return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
    };

    const getMonthDetails = (y: number, mIdx: number) => {
        if (mIdx < 1 || mIdx > 12) return null;
        const details = monthLookupTable[mIdx - 1];
        if (!details) return null;

        if (mIdx === 2 && isLeapYear(y)) {
            return { name: details.name, days: 29 };
        }
        return details;
    };

    const monthDetails = getMonthDetails(year, monthIndex);
    if (!monthDetails) throw new Error("Invalid month index");

    container.createEl("h4", { text: monthDetails.name });

    const monthStr = monthIndex < 10 ? "0" + monthIndex : String(monthIndex);
    let lastDayStr = String(monthDetails.days);
    if (monthDetails.days < 10) lastDayStr = "0" + lastDayStr;

    const startDate = `${year}-${monthStr}-01`;
    const endDate = `${year}-${monthStr}-${lastDayStr}`;

    const monthlyDataMap = await getWorkingTimeMap(
        dataviewApi,
        plugin,
        startDate,
        endDate
    );

    let weekRows: string[][] = [];
    let weeklyWorkTotal = 0;
    let weeklyOtherTotal = 0;
    let accumulatedDeviation = deviation;
    let weekStartDay = 1;

    const endOfWeekIndex = plugin.settings.firstDayOfWeek === 1 ? 0 : 6;

    for (let i = 1; i <= monthDetails.days; i++) {
        const day = i;
        const currentMoment = safeMoment({
            year: year,
            month: monthIndex - 1,
            day: day
        });
        const dayOfWeek = currentMoment.format("dd");

        let weekNumber = currentMoment.week();
        if (plugin.settings.firstDayOfWeek === 1) {
            weekNumber = currentMoment.isoWeek();
        }

        const dateKey = currentMoment.format("YYYY-MM-DD");
        const workingTime = monthlyDataMap.get(dateKey);

        let workDuration = 0, otherDuration = 0;

        if (workingTime) {
            workingTime.fileCategories.forEach((category, index) => {
                const isWorkCat = (c: Category) => c.name === category;
                const isWork = plugin.settings.categories
                    .find(isWorkCat)?.tags.includes("#work");
                const duration = workingTime.entryDurations[index] || 0;

                if (isWork) {
                    workDuration += duration;
                } else {
                    otherDuration += duration;
                }
            });
        }

        weeklyWorkTotal += workDuration;
        weeklyOtherTotal += otherDuration;

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
            const targetTimeForWeek = calculateTargetTime(
                weekStartDay,
                day,
                allDaysOff,
                HOURS_PER_DAY_OFF
            );
            accumulatedDeviation = renderWeekTableWithApp(
                plugin.app,
                container,
                api,
                weekRows,
                weeklyWorkTotal,
                weeklyOtherTotal,
                targetTimeForWeek,
                accumulatedDeviation,
                weekNumber,
                component
            );
            weeklyWorkTotal = 0;
            weeklyOtherTotal = 0;
            weekRows = [];
            weekStartDay = day + 1;
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
        component,
        monthlyDataMap
    );
}

function renderEndOfMonthSummary(
    app: App,
    container: ObsidianHTMLElement,
    api: STT_API,
    accumulatedDeviation: number,
    daysOff: number[],
    vacationDays: number[],
    sickDays: number[],
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

    void safeRenderer.render(app, table, container, "", component);
}

function calculateTargetTime(
    weekStartDay: number,
    weekEndDay: number,
    daysOff: Set<number>,
    HOURS_PER_DAY_OFF: number
): number {
    const daysInWeek = weekEndDay - weekStartDay + 1;
    let totalTarget = daysInWeek * 8 * 60 * 60 * 1000;
    daysOff.forEach(day => {
        if (day >= weekStartDay && day <= weekEndDay) {
            totalTarget -= HOURS_PER_DAY_OFF;
        }
    });
    return totalTarget;
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

    void safeRenderer.render(app, table, container, "", component);
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
