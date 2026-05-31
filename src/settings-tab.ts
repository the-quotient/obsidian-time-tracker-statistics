import {
    App,
    PluginSettingTab,
    Setting,
    TextComponent,
    ButtonComponent,
    DropdownComponent
} from "obsidian";
import TimeTrackerStatisticsPlugin from "./main";
import { Category } from "./settings";

interface SafeSetting {
    setName(name: string): SafeSetting;
    setDesc(desc: string): SafeSetting;
    setHeading(): SafeSetting;
    addText(cb: (text: TextComponent) => void): SafeSetting;
    addButton(cb: (button: ButtonComponent) => void): SafeSetting;
    addDropdown(cb: (dropdown: DropdownComponent) => void): SafeSetting;
}

interface SettingConstructor {
    new(containerEl: HTMLElement): SafeSetting;
}

const SafeSettingClass = Setting as unknown as SettingConstructor;

export class TimeTrackerStatisticsSettingsTab extends PluginSettingTab {
    plugin: TimeTrackerStatisticsPlugin;

    constructor(app: App, plugin: TimeTrackerStatisticsPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const container = this.containerEl as HTMLElement;
        container.innerHTML = "";

        new SafeSettingClass(container)
            .setName("Configuration")
            .setHeading();

        this.plugin.settings.categories.forEach(
            (category: Category, index: number) => {
                new SafeSettingClass(container)
                    .addText((text: TextComponent) => {
                        text.setPlaceholder("Category name")
                            .setValue(category.name)
                            .onChange(async (value: string) => {
                                category.name = value;
                                await this.plugin.saveSettings();
                            });
                    })
                    .addText((text: TextComponent) => {
                        text.setPlaceholder("Tags (comma-separated)")
                            .setValue(category.tags.join(", "))
                            .onChange(async (value: string) => {
                                category.tags = value
                                    .split(",")
                                    .map((tag: string) => tag.trim())
                                    .filter((tag: string) => tag.length > 0);
                                await this.plugin.saveSettings();
                            });
                    })
                    .addText((text: TextComponent) => {
                        text.setPlaceholder("Target time")
                            .setValue(category.target)
                            .onChange(async (value: string) => {
                                category.target = value ? value : "00:00:00";
                                await this.plugin.saveSettings();
                            });
                    })
                    .addButton((button: ButtonComponent) => {
                        button.setButtonText("Remove")
                            .onClick(async () => {
                                this.plugin.settings.categories
                                    .splice(index, 1);
                                await this.plugin.saveSettings();
                                this.display();
                            });
                    });
            }
        );

        new SafeSettingClass(container)
            .addButton((button: ButtonComponent) => {
                button.setButtonText("Add new category")
                    .onClick(async () => {
                        this.plugin.settings.categories.push({
                            name: "",
                            tags: [],
                            target: "00:00:00"
                        });
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });

        new SafeSettingClass(container)
            .setName('First day of week')
            .setDesc('Set the first day of the week for calculations.')
            .addDropdown((dropdown: DropdownComponent) => {
                dropdown
                    .addOption('0', 'Sunday')
                    .addOption('1', 'Monday')
                    .setValue(String(this.plugin.settings.firstDayOfWeek))
                    .onChange(async (value: string) => {
                        this.plugin.settings.firstDayOfWeek = Number(value);
                        await this.plugin.saveSettings();
                    });
            });
    }
}
