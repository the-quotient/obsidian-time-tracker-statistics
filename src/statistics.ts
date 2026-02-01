import { MarkdownRenderer, setIcon, TFile, App } from "obsidian";
import moment from "moment";
import TimeTrackerStatisticsPlugin from "./main";
import { Category } from "./settings";

type DataviewApi = any; 

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

function getSTTApi(app: App): STT_API | null {
    const sttPlugin = (app as any).plugins.plugins["simple-time-tracker"];
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
    return moment.duration(target).asMilliseconds();
}

function extractYear(inputString: string): number | null {
    const yearMatch = String(inputString).match(/\b\d{4}\b/);
    return yearMatch ? Number(yearMatch[0]) : null;
}

function extractMonth(inputString: string): number | null {
    const monthMatch = String(inputString).match(/\b-\d{2}\b/);
    return monthMatch ? Number(monthMatch[0].replace("-", "")) : null;
}


async function getWorkingTimeOfDay(dataviewApi: DataviewApi, plugin: TimeTrackerStatisticsPlugin, date: string) {
    const api = getSTTApi(plugin.app);
    if (!api) throw new Error("Simple Time Tracker API not found");

    const fileCategories: string[] = [];
    const pageNames: string[] = [];
    const entryNames: string[] = [];
    const entryDurations: number[] = [];
    const filteredEntries: Entry[] = [];

    function processEntries(entries: Entry[], page: TFile, category: string, parentName = '') {
        entries.forEach(entry => {
            if (extractDate(entry.startTime) === date) {
                filteredEntries.push(entry);
                fileCategories.push(category);
                pageNames.push(page.basename);
                const fullName = parentName ? `${parentName} -> ${entry.name}` : entry.name;
                entryNames.push(fullName);
                entryDurations.push(api!.getDuration(entry));
            }

            if (entry.subEntries) {
                const newParentName = parentName ? `${parentName} -> ${entry.name}` : entry.name;
                processEntries(entry.subEntries, page, category, newParentName);
            }
        });
    }

    for (const page of dataviewApi.pages('""') as any[]) {
        if (!page.file?.path) continue;

        const file = plugin.app.vault.getAbstractFileByPath(page.file.path);
        if (!(file instanceof TFile)) {
            continue;
        }

        const trackers = await api.loadAllTrackers(file.path);
        const pageTags = new Set(page.file.tags || []);

        let category = "Other";
        for (const cat of plugin.settings.categories) {
            if (cat.tags.some((tag: string) => pageTags.has(tag))) {
                category = cat.name;
                break;
            }
        }

        for (const { tracker } of trackers) {
            processEntries(tracker.entries, file, category);
        }
    }

    return {
        totalDuration: api.getTotalDuration(filteredEntries),
        fileCategories,
        pageNames,
        entryNames,
        entryDurations
    };
}

async function getRunningTrackerMarkdown(dataviewApi: DataviewApi, app: App): Promise<string> {
    const api = getSTTApi(app);
    if (!api) return "";

    for (const page of dataviewApi.pages('""') as any[]) {
        if (!page.file?.path) continue;
        const trackers = await api.loadAllTrackers(page.file.path);
        for (const { tracker } of trackers) {
            if (api.isRunning(tracker)) {
                return `**Currently running:** [[${page.file.path}|${page.file.name}]]\n\n---\n`;
            }
        }
    }
    return "_No tracker is currently running._\n";
}

export async function displayStatisticsDay(container: HTMLElement, plugin: TimeTrackerStatisticsPlugin, sourcePath: string, blockContent?: string): Promise<void> {
    const app = plugin.app;
    const api = getSTTApi(app);
    
    if (!api) {
        container.empty();
        container.createEl("p", { text: "Error: 'Simple Time Tracker' plugin is required." });
        return;
    }

    const renderReport = async (contentContainer: HTMLElement) => {
        const dataviewApi = (app as any).plugins.plugins.dataview?.api;
        if (!dataviewApi) {
            contentContainer.empty();
            contentContainer.createEl("p", { text: "Error: Dataview plugin is not enabled..." });
            return;
        }

        const fileName = sourcePath.split('/').pop() || '';
        const date = extractDate(fileName);
        if (!date) {
            contentContainer.empty();
            contentContainer.createEl("p", { text: `Error: Could not extract date (YYYY-MM-DD) from file name: "${fileName}"` });
            return;
        }

        try {
            contentContainer.empty();
            const runningTrackerMd = await getRunningTrackerMarkdown(dataviewApi, app);
            const workingTime = await getWorkingTimeOfDay(dataviewApi, plugin, date);

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

                const showTargetColumns = plugin.settings.categories.some((c: Category) => c.target);

                let totalsTable = `| Category | Duration |`;
                if (showTargetColumns) {
                    totalsTable += ` Remaining | Overtime |\n|:---|:---|:---|:---|\n`;
                } else {
                    totalsTable += `\n|:---|:---|\n`;
                }

                for (const categoryName in categoryTotals) {
                    const category = plugin.settings.categories.find((c: Category) => c.name === categoryName);
                    const trackedDuration = categoryTotals[categoryName] ?? 0;
                    let remainingStr = "";
                    let overtimeStr = "";

                    if (category && category.target) {
                        const targetMs = parseTargetTime(category.target);
                        if (targetMs > 0) {
                            const diffMs = trackedDuration - targetMs;
                            if (diffMs < 0) {
                                remainingStr = api.formatDuration(-diffMs);
                            } else {
                                overtimeStr = api.formatDuration(diffMs);
                            }
                        }
                    }

                    totalsTable += `| **${categoryName}** | ${api.formatDuration(trackedDuration)} |`;
                    if (showTargetColumns) {
                        totalsTable += ` ${remainingStr} | ${overtimeStr} |\n`;
                    } else {
                        totalsTable += `\n`;
                    }
                }

                totalsTable += `| **Total** | **${api.formatDuration(workingTime.totalDuration)}** |`;
                if (showTargetColumns) {
                    totalsTable += ` | |`;
                }

                let breakdownTable = `| Category | Entry | Duration |\n|:---|:---|:---|\n`;
                workingTime.fileCategories.forEach((category, i) => {
                    const pageName = workingTime.pageNames[i]?.toUpperCase() || "UNKNOWN";
                    const entryName = workingTime.entryNames[i] || "Unknown";
                    const duration = workingTime.entryDurations[i] || 0;

                    const entryKey = `**${pageName}-${entryName}**`;
                    const durStr = api.formatDuration(duration);
                    breakdownTable += `| ${category} | ${entryKey} | ${durStr} |\n`;
                });
                dailyReportMd = `#### Totals\n\n${totalsTable}\n\n#### Entries Breakdown\n\n${breakdownTable}`;
            }

            const finalMarkdown = `${runningTrackerMd}\n${dailyReportMd}`;
            contentContainer.empty();
            await MarkdownRenderer.render(app, finalMarkdown, contentContainer, sourcePath, plugin);

        } catch (error) {
            console.error("Simple Time Tracker (Statistics) Error:", error);
            contentContainer.empty();
            contentContainer.createEl("p", { text: "An error occurred while generating the report." });
        }
    };

    container.empty();
    container.addClass("simple-time-tracker-stats-container");
    const header = container.createDiv({ cls: "simple-time-tracker-stats-header" });
    const titleGroup = header.createDiv({ attr: { style: "display: flex; align-items: center; gap: 0.5em;" } });
    titleGroup.createEl("h4", { text: "Daily Statistics" });
    const refreshButton = titleGroup.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Refresh" } });
    setIcon(refreshButton, "refresh-cw");

    const contentContainer = container.createDiv({ cls: "simple-time-tracker-stats-content" });

    refreshButton.addEventListener("click", () => {
        setIcon(refreshButton, "loader");
        refreshButton.disabled = true;
        renderReport(contentContainer).finally(() => {
            setIcon(refreshButton, "refresh-cw");
            refreshButton.disabled = false;
        });
    });

    renderReport(contentContainer);
}

export async function displayStatisticsMonth(container: HTMLElement, plugin: TimeTrackerStatisticsPlugin, sourcePath: string, blockContent: string): Promise<void> {
    const app = plugin.app;
    const api = getSTTApi(app);
    if (!api) {
        container.empty();
        container.createEl("p", { text: "Error: 'Simple Time Tracker' plugin is required." });
        return;
    }

    const renderReport = async (contentContainer: HTMLElement) => {
        const dataviewApi = (app as any).plugins.plugins.dataview?.api;
        if (!dataviewApi) {
            contentContainer.empty();
            contentContainer.createEl("p", { text: "Error: Dataview plugin is not enabled..." });
            return;
        }

        const settings: any = {};
        blockContent.split('\n').forEach(line => {
            const parts = line.split('=');
            if (parts.length === 2) {
                const key = parts[0]?.trim() || "";
                const value = parts[1]?.trim() || "";
                try {
                    settings[key] = JSON.parse(value);
                } catch (e) {
                    settings[key] = value;
                }
            }
        });

        const deviation = settings.deviation || 0;
        const daysOff = settings.daysOff || [];
        const vacationDays = settings.vacationDays || [];
        const sickDays = settings.sickDays || [];

        const fileName = sourcePath.split('/').pop() || '';
        const year = extractYear(fileName);
        const monthIndex = extractMonth(fileName);

        if (!year || !monthIndex) {
            contentContainer.empty();
            contentContainer.createEl("p", { text: `Error: Could not extract year and month from file name: "${fileName}"` });
            return;
        }

        try {
            contentContainer.empty();
            await printWorkingTimeOfMonth(contentContainer, dataviewApi, plugin, api, year, monthIndex, deviation, daysOff, vacationDays, sickDays);
        } catch (error) {
            console.error("Simple Time Tracker (Monthly Statistics) Error:", error);
            contentContainer.empty();
            contentContainer.createEl("p", { text: "An error occurred while generating the monthly report." });
        }
    };

    container.empty();
    container.addClass("simple-time-tracker-stats-container");
    const header = container.createDiv({ cls: "simple-time-tracker-stats-header" });
    const titleGroup = header.createDiv({ attr: { style: "display: flex; align-items: center; gap: 0.5em;" } });
    titleGroup.createEl("h4", { text: "Monthly Statistics" });
    const refreshButton = titleGroup.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Refresh" } });
    setIcon(refreshButton, "refresh-cw");
    const contentContainer = container.createDiv({ cls: "simple-time-tracker-stats-content" });

    refreshButton.addEventListener("click", () => {
        setIcon(refreshButton, "loader");
        refreshButton.disabled = true;
        renderReport(contentContainer).finally(() => {
            setIcon(refreshButton, "refresh-cw");
            refreshButton.disabled = false;
        });
    });

    renderReport(contentContainer);
}

async function printWorkingTimeOfMonth(
    container: HTMLElement, 
    dataviewApi: DataviewApi, 
    plugin: TimeTrackerStatisticsPlugin, 
    api: STT_API, 
    year: number, 
    monthIndex: number, 
    deviation: number, 
    daysOff: number[], 
    vacationDays: number[], 
    sickDays: number[]
) {
    moment.updateLocale('en', { week: { dow: plugin.settings.firstDayOfWeek } });

    const monthLookupTable = [
        { name: "January", days: 31 }, { name: "February", days: 28 }, { name: "March", days: 31 },
        { name: "April", days: 30 }, { name: "May", days: 31 }, { name: "June", days: 30 },
        { name: "July", days: 31 }, { name: "August", days: 31 }, { name: "September", days: 30 },
        { name: "October", days: 31 }, { name: "November", days: 30 }, { name: "December", days: 31 }
    ];
    const HOURS_PER_DAY_OFF = 8 * 60 * 60 * 1000;
    const allDaysOff = new Set([...daysOff, ...vacationDays, ...sickDays]);

    const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);

    const getMonthDetails = (year: number, monthIndex: number) => {
        if (monthIndex < 1 || monthIndex > 12) return null;
        let details = monthLookupTable[monthIndex - 1];
        if (!details) return null;

        if (monthIndex === 2 && isLeapYear(year)) {
            return { name: details.name, days: 29 };
        }
        return details;
    };

    const monthDetails = getMonthDetails(year, monthIndex);
    if (!monthDetails) throw new Error("Invalid month index");

    container.createEl("h4", { text: monthDetails.name });

    let promises = [];
    for (let i = 1; i <= monthDetails.days; i++) {
        let day = i < 10 ? "0" + i : String(i);
        let month = monthIndex < 10 ? "0" + monthIndex : String(monthIndex);
        let date = `${year}-${month}-${day}`;
        promises.push(getWorkingTimeOfDay(dataviewApi, plugin, date));
    }
    let results = await Promise.all(promises);

    let weekRows: any[][] = [];
    let weeklyWorkTotal = 0;
    let weeklyOtherTotal = 0;
    let accumulatedDeviation = deviation;
    let weekStartDay = 1;

    for (let i = 0; i < results.length; i++) {
        const workingTime = results[i];
        if(!workingTime) continue;

        let day = i + 1;
        let currentMoment = moment({ year: year, month: monthIndex - 1, day: day });
        let dayOfWeek = currentMoment.format("dd");
        let weekNumber = currentMoment.week();

        let workDuration = 0, otherDuration = 0;

        workingTime.fileCategories.forEach((category, index) => {
            const isWork = plugin.settings.categories.find((c: Category) => c.name === category)?.tags.includes("#work");
            const duration = workingTime.entryDurations[index] || 0;

            if (isWork) {
                workDuration += duration;
            } else {
                otherDuration += duration;
            }
        });

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
            printBreakdown(workingTime, api)
        ]);

        const dayOfWeekIndex = currentMoment.weekday();
        const isLastDayOfMonth = day === monthDetails.days;

        if (dayOfWeekIndex === 6 || isLastDayOfMonth) {
            const targetTimeForWeek = calculateTargetTime(weekStartDay, day, allDaysOff, HOURS_PER_DAY_OFF);
            accumulatedDeviation = renderWeekTableWithApp(plugin.app, container, api, weekRows, weeklyWorkTotal, weeklyOtherTotal, targetTimeForWeek, accumulatedDeviation, weekNumber, plugin);
            weeklyWorkTotal = 0;
            weeklyOtherTotal = 0;
            weekRows = [];
            weekStartDay = day + 1;
        }
    }

    container.createEl("h4", { text: "End of Month Summary" });
    renderEndOfMonthSummaryWithApp(plugin.app, container, api, accumulatedDeviation, daysOff, vacationDays, sickDays, plugin);
}

function renderEndOfMonthSummaryWithApp(
    app: App,
    container: HTMLElement, 
    api: STT_API, 
    accumulatedDeviation: number, 
    daysOff: number[], 
    vacationDays: number[], 
    sickDays: number[],
    plugin: TimeTrackerStatisticsPlugin
) {
    let headers = ["Metric", "Value"];
    let table = `| ${headers[0]} | ${headers[1]} |\n| --- | --- |\n`;
    let accumulatedDeviationFormatted = `${(accumulatedDeviation >= 0 ? "+" : "-")}${api.formatDuration(Math.abs(accumulatedDeviation))}`;
    table += `| **Total Accumulated Deviation** | **${accumulatedDeviationFormatted}** |\n`;
    table += `| **Total Accumulated Deviation (ms)** | **${accumulatedDeviation}** |\n`;
    table += `| **Number of Days Off** | **${daysOff.length}** |\n`;
    table += `| **Number of Vacation Days** | **${vacationDays.length}** |\n`;
    table += `| **Number of Sick Days** | **${sickDays.length}** |\n`;

    MarkdownRenderer.render(app, table, container, "", plugin);
}

function calculateTargetTime(weekStartDay: number, weekEndDay: number, daysOff: Set<number>, HOURS_PER_DAY_OFF: number): number {
    let daysInWeek = weekEndDay - weekStartDay + 1;
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
    container: HTMLElement, 
    api: STT_API, 
    rows: any[][], 
    weeklyWorkTotal: number, 
    weeklyOtherTotal: number, 
    targetTimeForWeek: number, 
    accumulatedDeviation: number, 
    weekNumber: number,
    plugin: TimeTrackerStatisticsPlugin
): number {
    container.createEl("h5", {text: `Week ${weekNumber}`})
    let headers = ["Day", "Work Duration", "Other Duration", "Entries"];
    let table = `| ${headers[0]} | ${headers[1]} | ${headers[2]} | ${headers[3]} |\n| --- | --- | --- | --- |\n`;
    rows.forEach(row => { table += `| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} |\n`; });

    let workTotalFormatted = api.formatDuration(weeklyWorkTotal);
    let otherTotalFormatted = api.formatDuration(weeklyOtherTotal);

    let weeklyDeviation = weeklyWorkTotal - targetTimeForWeek;
    accumulatedDeviation += weeklyDeviation;

    let weeklyDeviationFormatted = api.formatDuration(Math.abs(weeklyDeviation));
    weeklyDeviationFormatted = (weeklyDeviation >= 0 ? "+" : "-") + weeklyDeviationFormatted;

    let accumulatedDeviationFormatted = api.formatDuration(Math.abs(accumulatedDeviation));
    accumulatedDeviationFormatted = (accumulatedDeviation >= 0 ? "+" : "-") + accumulatedDeviationFormatted;

    table += `| **Total** | **${workTotalFormatted}** | **${otherTotalFormatted}** |  |\n`;
    table += `| **Weekly Deviation** | **${weeklyDeviationFormatted}** |  |  |\n`;
    table += `| **Accumulated Deviation** | **${accumulatedDeviationFormatted}** |  |  |\n`;

    MarkdownRenderer.render(app, table, container, "", plugin);
    return accumulatedDeviation;
}

function printBreakdown(workingTime: any, api: STT_API): string {
    let { pageNames, entryNames, entryDurations } = workingTime;
    return pageNames.map((pageName: string, i: number) =>
        `${pageName}-${entryNames[i]}: ${api.formatDuration(entryDurations[i])}`
    ).join('<br>');
}
