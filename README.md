# Obsidian Time Tracker Statistics

This is a statistics companion plugin for the **[Super Simple Time Tracker](https://github.com/Ellpeck/ObsidianSimpleTimeTracker)** by [Ellpeck](https://github.com/Ellpeck).
It collects the time tracked in all notes of your vault and summarises it in daily and monthly reports: time per category, per entry and per note, compared against your daily targets.

- Summarises tracked time without the need for custom scripts or coding.
- Identifies the relevant data based on the file's name.
    - **Daily**: Requires a `YYYY-MM-DD` format (e.g., `2026-02-01.md`).
    - **Monthly**: Requires a year and month index (e.g., `2026-02.md`).
- Automatically groups tracked entries into categories based on file tags defined in your settings.
- You can add a target time for a category and the breakdown will show you how much you deviated from it. Weekends are excluded from the target automatically, and you can easily mark public holidays, vacation days and sick days so the deviation calculation takes them into account.
- The Daily view displays whether a tracker is currently running anywhere in your vault.

## Different Views

### 1. Daily Statistics

Provides a summary of all time tracked for a specific calendar day.
- **Command**: `Insert daily statistics`.
- **Code Block**: `simple-time-tracker-statistics-day`.

**Includes:**

- **Totals Table**: Breakdown of duration, remaining time, and overtime per category based on your set targets.
- **Entries Breakdown**: A detailed list of every entry, showing the source file and sub-entry hierarchy.
- **Running Tracker**: Displays a link to any active tracker found in the vault.

Entries are assigned to the day on which they were started, in your local time zone.

<img width="774" height="670" alt="image" src="https://github.com/user-attachments/assets/3d78b2a8-9c71-4db9-a0ae-475aa3d85213" />

### 2. Monthly Statistics

A comprehensive report grouping entries by week and calculating long-term time balances.

- **Command**: `Insert monthly statistics`.
- **Code Block**: `simple-time-tracker-statistics-month`.

<img width="857" height="578" alt="image" src="https://github.com/user-attachments/assets/9e690e5d-b395-4c4f-b52d-c334f3fe6e6f" />


## Managing Time Off

The Monthly view counts the daily work target for Monday to Friday only. Saturdays and Sundays never add to the target. You can exclude further days from your standard work obligations to keep your **Accumulated Deviation** accurate.

### Configuration Parameters

Adjust these values directly within the code block:

|Parameter|Type|Description|
|---|---|---|
|**`deviation`**|`number`|Time (in **milliseconds**) to carry over from a previous month. Copy it from the *Total accumulated deviation (ms)* row of the previous month's summary.|
|**`vacationDays`**|`number[]`|Days of the month to be excluded from work targets (e.g., `[1, 2, 3]`).|
|**`sickDays`**|`number[]`|Dates marked as sick leave; reduces the work target.|
|**`daysOff`**|`number[]`|Public holidays or other non-working days. Weekends don't need to be listed.|

## Setting Up Categories

To make the statistics meaningful, map your vault's tags to categories in the **Plugin Settings**. The plugin comes pre-configured with two default categories: **Work** (target `08:00:00`) and **Leisure** (target `00:00:00`).

1. **Define a Category**: Give it a name.
2. **Assign Tags**: Add the tags you use to indicate the files associated with the category. By default, **Work** looks for `#work` and **Leisure** looks for `#leisure`.
3. **Set Targets**: Enter a daily target in `HH:mm:ss` format. If left blank, the target defaults to `00:00:00`.
4. **Monthly "Work" Tracking**: Every category with a target above `00:00:00` counts as work in the Monthly view. The daily target is the sum of these targets. Categories without a target are shown as "Other duration".

## Prerequisites

- **Simple Time Tracker**: Required for the underlying data and API.
- **Dataview**: Required for the plugin to scan and aggregate data.

## Roadmap

- Automate the carry-over of deviation values between months.
- Add yearly summaries.
