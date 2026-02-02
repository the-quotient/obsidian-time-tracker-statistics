import { MarkdownRenderChild, Plugin } from "obsidian";
import { defaultSettings, TimeTrackerStatisticsSettings } from "./settings";
import { TimeTrackerStatisticsSettingsTab } from "./settings-tab";
import { displayStatisticsDay, displayStatisticsMonth } from "./statistics";

export default class TimeTrackerStatisticsPlugin extends Plugin {

	settings: TimeTrackerStatisticsSettings;

    async onload(): Promise<void> {
        await this.loadSettings();

        this.addSettingTab(new TimeTrackerStatisticsSettingsTab(this.app, this));

        this.registerMarkdownCodeBlockProcessor("simple-time-tracker-statistics-day", (s, e, i) => {
            e.empty();
            const component = new MarkdownRenderChild(e);

            displayStatisticsDay(e, this, i.sourcePath, s, component);

            i.addChild(component);
        });

         this.registerMarkdownCodeBlockProcessor("simple-time-tracker-statistics-month", (s, e, i) => {
            e.empty();
            const component = new MarkdownRenderChild(e);

            displayStatisticsMonth(e, this, i.sourcePath, s, component);

            i.addChild(component);
        });

        this.addCommand({
            id: `insert-stats-day`,
            name: `Insert time tracker statistics day`,
            editorCallback: (e, _) => {
                e.replaceSelection("```simple-time-tracker-statistics-day\n```\n");
            }
        });

        this.addCommand({
            id: `insert-stats-month`,
            name: `Insert time tracker statistics month`,
            editorCallback: (e, _) => {
                const block = `\`\`\`simple-time-tracker-statistics-month
deviation = 0
vacationDays = []
sickDays = []
daysOff = []
\`\`\`
`;
                e.replaceSelection(block);
            }
        });


    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, defaultSettings, (await this.loadData()) as TimeTrackerStatisticsSettings);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
