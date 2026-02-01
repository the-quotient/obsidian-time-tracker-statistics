# Obsidian Time Tracker Statistics

This is a statistics companion plugin for the **[Super Simple Time Tracker](https://github.com/Ellpeck/ObsidianSimpleTimeTracker)** by [Ellpeck](https://github.com/Ellpeck).
It provides native, high-level visualisations for your time tracking data across your entire vault by leveraging the Dataview API.

## 🚀 Key Features

- Visualises tracked time without the need for custom API scripts or coding.
- Identifies the relevant data based on the file's name.
    - **Daily**: Requires a `YYYY-MM-DD` format (e.g., `2026-02-01.md`).
    - **Monthly**: Requires a year and month index (e.g., `2026-02.md`).
- Automatically groups tracked entries into categories based on file tags defined in your settings.
- You can add a target time for a category and the breakdown will show you how much you deviated from it. You can very easily mark weekends, public holidays, vacation days and sick days and the deviation calculation will take this into account.
- The Daily view displays whether a tracker is currently running anywhere in your vault.

## 📊 Statistics Views

### 1. Daily Statistics

Provides a summary of all time tracked for a specific calendar day.
- **Command**: `Insert time tracker statistics day`.
- **Code Block**: `simple-time-tracker-statistics-day`.

**What it includes:**

- **Totals Table**: Breakdown of duration, remaining time, and overtime per category based on your set targets.
- **Entries Breakdown**: A detailed list of every entry, showing the source file and sub-entry hierarchy.
- **Running Tracker**: Displays a link to any active tracker found in the vault.

### 2. Monthly Statistics

A comprehensive report grouping entries by week and calculating long-term time balances.

- **Command**: `Insert time tracker statistics month`.
- **Code Block**: `simple-time-tracker-statistics-month`.

## 📅 Managing Time Off

The Monthly view allows you to exclude specific days from your standard work obligations to keep your **Accumulated Deviation** accurate.

### Configuration Parameters

Adjust these values directly within the code block:

|Parameter|Type|Description|
|---|---|---|
|**`deviation`**|`number`|Time (in **milliseconds**) to carry over from a previous month.|
|**`vacationDays`**|`number[]`|Days of the month to be excluded from work targets (e.g., `[1, 2, 3]`).|
|**`sickDays`**|`number[]`|Dates marked as sick leave; reduces the work target.|
|**`daysOff`**|`number[]`|General non-working days (e.g. weekends) or public holidays.|

## ⚙️ Setting Up Categories

To make the statistics meaningful, map your vault's tags to categories in the **Plugin Settings**. The plugin comes pre-configured with two default categories: **Work** (target `08:00:00`) and **Leisure** (target `00:00:00`).

1. **Define a Category**: Give it a name.
2. **Assign Tags**: Add the tags you use to indicate the files associated with the category. By default, **Work** looks for `#work` and **Leisure** looks for `#leisure`.
3. **Set Targets**: Enter a daily target in `HH:mm:ss` format. If left blank, the target defaults to `00:00:00`.
4. **Monthly "Work" Tracking**: **Note:** For the Monthly view to calculate deviation, the plugin specifically identifies "Work" by checking for the `#work` tag within a category. Ensure your primary work category includes this tag.

## 🛠 Prerequisites

- **Simple Time Tracker**: Required for the underlying data and API.
- **Dataview**: Required for the plugin to scan and aggregate data.

## 🗺️ Roadmap

- Automate the carry-over of deviation values between months.
- Add yearly summaries. Add yearly summaries.
