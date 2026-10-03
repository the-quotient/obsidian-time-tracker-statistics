import {
    Component,
    MarkdownRenderChild,
    MarkdownRenderer,
    Notice,
    Plugin,
    requestUrl,
    MarkdownPostProcessorContext,
    Editor
} from "obsidian";
import { defaultSettings, TimeTrackerStatisticsSettings } from "./settings";
import { TimeTrackerStatisticsSettingsTab } from "./settings-tab";
import {
    displayStatisticsDay,
    displayStatisticsWeek,
    displayStatisticsMonth,
    displayStatisticsYear
} from "./statistics";
import { PERIODS, PeriodType, StatisticsDashboardModal } from "./dashboard";

const README_URL =
    "https://github.com/the-quotient/obsidian-time-tracker-statistics#readme";
const RELEASES_API_URL =
    "https://api.github.com/repos/the-quotient/obsidian-time-tracker-statistics/releases";

export default class TimeTrackerStatisticsPlugin extends Plugin {
    settings: TimeTrackerStatisticsSettings;

    async onload(): Promise<void> {
        const isFreshInstall = (await this.loadData()) === null;
        await this.loadSettings();

        this.addSettingTab(
            new TimeTrackerStatisticsSettingsTab(this.app, this)
        );

        this.registerMarkdownCodeBlockProcessor(
            "simple-time-tracker-statistics-day",
            (
                source: string,
                el: HTMLElement,
                ctx: MarkdownPostProcessorContext
            ) => {
                el.innerHTML = "";
                const component = new MarkdownRenderChild(el);

                displayStatisticsDay(
                    el,
                    this,
                    ctx.sourcePath,
                    component
                );

                ctx.addChild(component);
            }
        );

        this.registerMarkdownCodeBlockProcessor(
            "simple-time-tracker-statistics-week",
            (
                source: string,
                el: HTMLElement,
                ctx: MarkdownPostProcessorContext
            ) => {
                el.innerHTML = "";
                const component = new MarkdownRenderChild(el);

                displayStatisticsWeek(
                    el,
                    this,
                    ctx.sourcePath,
                    component
                );

                ctx.addChild(component);
            }
        );

        this.registerMarkdownCodeBlockProcessor(
            "simple-time-tracker-statistics-year",
            (
                source: string,
                el: HTMLElement,
                ctx: MarkdownPostProcessorContext
            ) => {
                el.innerHTML = "";
                const component = new MarkdownRenderChild(el);

                displayStatisticsYear(
                    el,
                    this,
                    ctx.sourcePath,
                    component
                );

                ctx.addChild(component);
            }
        );

        this.registerMarkdownCodeBlockProcessor(
            "simple-time-tracker-statistics-month",
            (
                source: string,
                el: HTMLElement,
                ctx: MarkdownPostProcessorContext
            ) => {
                el.innerHTML = "";
                const component = new MarkdownRenderChild(el);

                displayStatisticsMonth(
                    el,
                    this,
                    ctx.sourcePath,
                    source,
                    component
                );

                ctx.addChild(component);
            }
        );

        this.addCommand({
            id: "open-statistics-dashboard",
            name: "Open statistics dashboard",
            callback: () => this.openDashboard()
        });

        for (const { type, label } of PERIODS) {
            this.addCommand({
                id: `open-statistics-dashboard-${type}`,
                name: `Open statistics dashboard: ${label.toLowerCase()} view`,
                callback: () => this.openDashboard(type)
            });
        }

        this.addRibbonIcon(
            "bar-chart-3",
            "Open time tracker statistics",
            () => this.openDashboard()
        );

        this.addCommand({
            id: "insert-stats-day",
            name: "Insert daily statistics",
            editorCallback: (editor: Editor) => {
                const block = "```simple-time-tracker-statistics-day\n```\n";
                editor.replaceSelection(block);
            }
        });

        this.addCommand({
            id: "insert-stats-week",
            name: "Insert weekly statistics",
            editorCallback: (editor: Editor) => {
                const block = "```simple-time-tracker-statistics-week\n```\n";
                editor.replaceSelection(block);
            }
        });

        this.addCommand({
            id: "insert-stats-year",
            name: "Insert yearly statistics",
            editorCallback: (editor: Editor) => {
                const block = "```simple-time-tracker-statistics-year\n```\n";
                editor.replaceSelection(block);
            }
        });

        this.addCommand({
            id: "insert-stats-month",
            name: "Insert monthly statistics",
            editorCallback: (editor: Editor) => {
                const block = "```simple-time-tracker-statistics-month\n" +
                    "deviation = auto\n" +
                    "vacationDays = []\n" +
                    "sickDays = []\n" +
                    "daysOff = []\n" +
                    "```\n";
                editor.replaceSelection(block);
            }
        });

        this.app.workspace.onLayoutReady(() => {
            void this.showUpdateNotice(isFreshInstall);
        });
    }

    private async showUpdateNotice(isFreshInstall: boolean): Promise<void> {
        const currentVersion = this.manifest.version;
        if (this.settings.lastSeenVersion === currentVersion) return;

        // Versions before 2.0.0 did not store lastSeenVersion
        const previousVersion = this.settings.lastSeenVersion ?? "1.0.0";
        const majorOf = (version: string): number =>
            parseInt(version.split(".")[0] ?? "0", 10);

        if (!isFreshInstall && majorOf(currentVersion) > majorOf(previousVersion)) {
            const fragment = document.createDocumentFragment();
            fragment.createEl("strong", {
                text: `Time Tracker Statistics ${currentVersion}: new features have arrived!`
            });

            const releaseNotes = await this.fetchReleaseNotes(currentVersion);
            if (releaseNotes) {
                const notesEl = fragment.createDiv();
                const component = new Component();
                component.load();
                await MarkdownRenderer.render(
                    this.app, releaseNotes, notesEl, "", component
                );
                component.unload();
            }

            const linkEl = fragment.createDiv();
            linkEl.createEl("a", {
                text: "Check out the readme for details",
                href: README_URL
            });
            new Notice(fragment, 0);
        }

        this.settings.lastSeenVersion = currentVersion;
        await this.saveSettings();
    }

    private async fetchReleaseNotes(version: string): Promise<string | null> {
        try {
            const response = await requestUrl({
                url: `${RELEASES_API_URL}/tags/${version}`
            });
            const body = (response.json as { body?: string }).body;
            return body?.trim() || null;
        } catch {
            return null;
        }
    }

    openDashboard(period?: PeriodType, anchor?: Date): void {
        new StatisticsDashboardModal(this.app, this, period, anchor).open();
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign(
            {},
            defaultSettings,
            {
                categories: defaultSettings.categories.map(category => ({
                    ...category,
                    tags: [...category.tags]
                }))
            },
            (await this.loadData()) as TimeTrackerStatisticsSettings
        );
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
