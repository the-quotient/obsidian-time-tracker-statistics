import {
    App,
    PluginSettingTab,
    Setting,
    TextComponent,
    ToggleComponent,
    ButtonComponent,
    DropdownComponent
} from "obsidian";
import TimeTrackerStatisticsPlugin from "./main";
import { Category } from "./settings";
import { getCategoryTarget } from "./statistics";

interface SafeSetting {
    setName(name: string): SafeSetting;
    setDesc(desc: string): SafeSetting;
    setHeading(): SafeSetting;
    addText(cb: (text: TextComponent) => void): SafeSetting;
    addButton(cb: (button: ButtonComponent) => void): SafeSetting;
    addDropdown(cb: (dropdown: DropdownComponent) => void): SafeSetting;
    addToggle(cb: (toggle: ToggleComponent) => void): SafeSetting;
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
        const container = this.containerEl;
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
                                this.renameFillTarget(category.name, value);
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
                    .addDropdown((dropdown: DropdownComponent) => {
                        dropdown
                            .addOption('day', 'Per day')
                            .addOption('week', 'Per week')
                            .setValue(category.targetPeriod ?? 'day')
                            .onChange(async (value: string) => {
                                category.targetPeriod =
                                    value === 'week' ? 'week' : 'day';
                                await this.plugin.saveSettings();
                            });
                    })
                    .addButton((button: ButtonComponent) => {
                        button.setButtonText("Remove")
                            .onClick(async () => {
                                this.plugin.settings.categories
                                    .splice(index, 1);
                                this.renameFillTarget(category.name, null);
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
            .setName('Target rules')
            .setDesc('Lets the time of one category fill the target of ' +
                'other categories. Turning this off ignores the rules ' +
                'without deleting them.')
            .addToggle((toggle: ToggleComponent) => {
                toggle.setValue(this.plugin.settings.targetRules)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.targetRules = value;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });

        if (this.plugin.settings.targetRules) {
            this.displayTargetRules(container);
        }

        new SafeSettingClass(container)
            .setName('Daily target period')
            .setDesc('What the remaining time, overtime and deviation of a ' +
                'single day are based on: that day only, or the week so ' +
                'far, from the first day of the week up to that day.')
            .addDropdown((dropdown: DropdownComponent) => {
                dropdown
                    .addOption('day', 'Day')
                    .addOption('week', 'Week so far')
                    .setValue(this.plugin.settings.targetPeriod)
                    .onChange(async (value: string) => {
                        this.plugin.settings.targetPeriod =
                            value === 'week' ? 'week' : 'day';
                        await this.plugin.saveSettings();
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

        new SafeSettingClass(container)
            .setName('Monthly notes folder')
            .setDesc('Folder where new monthly notes (e.g. 2026-10.md) are ' +
                'created when you mark days off in the dashboard. Existing ' +
                'monthly notes are found anywhere in the vault.')
            .addText((text: TextComponent) => {
                text.setPlaceholder("Vault root")
                    .setValue(this.plugin.settings.monthlyNotesFolder)
                    .onChange(async (value: string) => {
                        this.plugin.settings.monthlyNotesFolder = value.trim();
                        await this.plugin.saveSettings();
                    });
            });

        new SafeSettingClass(container)
            .setName('Show charts in notes')
            .setDesc('Adds the dashboard charts below the tables of the ' +
                'statistics code blocks. Refresh a block to apply.')
            .addToggle((toggle: ToggleComponent) => {
                toggle.setValue(this.plugin.settings.showChartsInNotes)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.showChartsInNotes = value;
                        await this.plugin.saveSettings();
                    });
            });
    }

    /**
     * One row per category to choose the categories with a target whose
     * remaining target it fills before its own.
     */
    private displayTargetRules(container: HTMLElement): void {
        const categories = this.plugin.settings.categories
            .filter(category => category.name);
        const targetCategories = categories
            .filter(category => getCategoryTarget(category) > 0);

        if (targetCategories.length === 0 || categories.length < 2) {
            new SafeSettingClass(container)
                .setDesc('Target rules need at least two categories, ' +
                    'one of them with a target.');
            return;
        }

        for (const category of categories) {
            const fills = category.fills ?? [];
            const hasTarget = getCategoryTarget(category) > 0;
            const options = targetCategories.filter(other =>
                other !== category && !fills.includes(other.name));
            if (fills.length === 0 && options.length === 0) continue;

            const setting = new SafeSettingClass(container)
                .setName(`${category.name} fills`)
                .setDesc(this.getFillDescription(category.name, fills,
                    hasTarget));

            for (const name of fills) {
                setting.addButton((button: ButtonComponent) => {
                    button.setButtonText(`${name} ×`)
                        .setTooltip(`Stop filling ${name}`)
                        .onClick(async () => {
                            category.fills = fills.filter(n => n !== name);
                            await this.plugin.saveSettings();
                            this.display();
                        });
                });
            }

            if (options.length === 0) continue;
            setting.addDropdown((dropdown: DropdownComponent) => {
                dropdown.addOption("", "Add category…");
                for (const other of options) {
                    dropdown.addOption(other.name, other.name);
                }
                dropdown.onChange(async (value: string) => {
                    if (!value) return;
                    category.fills = [...fills, value];
                    await this.plugin.saveSettings();
                    this.display();
                });
            });
        }
    }

    private getFillDescription(
        name: string,
        fills: string[],
        hasTarget: boolean
    ): string {
        if (fills.length === 0) {
            return hasTarget
                ? `Time of ${name} only counts for itself.`
                : `${name} has no target and counts as other time.`;
        }
        return `Time of ${name} first fills the remaining target of ` +
            `${fills.join(", then ")}. ` +
            (hasTarget
                ? `Only the time left counts for ${name} itself.`
                : `${name} counts as work; the time left is overtime.`);
    }

    private renameFillTarget(oldName: string, newName: string | null): void {
        if (oldName === newName) return;
        for (const category of this.plugin.settings.categories) {
            if (!category.fills) continue;
            category.fills = category.fills.flatMap(name =>
                name !== oldName ? [name] : newName !== null ? [newName] : []);
        }
    }
}
