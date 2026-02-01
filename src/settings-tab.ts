import { App, PluginSettingTab, Setting } from "obsidian";
import TimeTrackerStatisticsPlugin from "./main";
import { Category } from "./settings";

export class TimeTrackerStatisticsSettingsTab extends PluginSettingTab {

    plugin: TimeTrackerStatisticsPlugin;

    constructor(app: App, plugin: TimeTrackerStatisticsPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        this.containerEl.empty();
        this.containerEl.createEl("h2", { text: "Time Tracker Statistics Settings" });

        this.plugin.settings.categories.forEach((category: Category, index: number) => {
            new Setting(this.containerEl)
                .addText(text => text
                    .setPlaceholder("Category name")
                    .setValue(category.name)
                    .onChange(async (value) => {
                        category.name = value;
                        await this.plugin.saveSettings();
                    }))
                .addText(text => text
                    .setPlaceholder("Tags (comma-separated)")
                    .setValue(category.tags.join(", "))
                    .onChange(async (value) => {
                        category.tags = value.split(",").map(tag => tag.trim()).filter(tag => tag.length > 0);
                        await this.plugin.saveSettings();
                    }))
                .addText(text => text
                    .setPlaceholder("Target time (HH:mm:ss)")
                    .setValue(category.target)
                    .onChange(async (value) => {
                        category.target = value ? value : "00:00:00"
                        await this.plugin.saveSettings();
                }))
                .addButton(button => button
                    .setButtonText("Remove")
                    .onClick(async () => {
                        this.plugin.settings.categories.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    }));
        });

        new Setting(this.containerEl)
            .addButton(button => button
                .setButtonText("Add New Category")
                .onClick(async () => {
                    this.plugin.settings.categories.push({ name: "", tags: [], target: "00:00:00" });
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(this.containerEl)
            .setName('First Day of Week')
            .setDesc('Set the first day of the week for statistics calculation.')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('0', 'Sunday')
                    .addOption('1', 'Monday')
                    .setValue(String(this.plugin.settings.firstDayOfWeek))
                    .onChange(async (value) => {
                        this.plugin.settings.firstDayOfWeek = Number(value);
                        await this.plugin.saveSettings();
                    });
            });
	}
}
