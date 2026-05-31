import {
    MarkdownRenderChild,
    Plugin,
    MarkdownPostProcessorContext,
    Editor
} from "obsidian";
import { defaultSettings, TimeTrackerStatisticsSettings } from "./settings";
import { TimeTrackerStatisticsSettingsTab } from "./settings-tab";
import { displayStatisticsDay, displayStatisticsMonth } from "./statistics";

export default class TimeTrackerStatisticsPlugin extends Plugin {
    settings: TimeTrackerStatisticsSettings;

    async onload(): Promise<void> {
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
                    source,
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
            id: `insert-stats-day`,
            name: `Insert time tracker statistics day`,
            editorCallback: (editor: Editor) => {
                const block = "```simple-time-tracker-statistics-day\n```\n";
                editor.replaceSelection(block);
            }
        });

        this.addCommand({
            id: `insert-stats-month`,
            name: `Insert time tracker statistics month`,
            editorCallback: (editor: Editor) => {
                const block = "```simple-time-tracker-statistics-month\n" +
                    "deviation = 0\n" +
                    "vacationDays = []\n" +
                    "sickDays = []\n" +
                    "daysOff = []\n" +
                    "```\n";
                editor.replaceSelection(block);
            }
        });
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign(
            {},
            defaultSettings,
            (await this.loadData()) as TimeTrackerStatisticsSettings
        );
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
