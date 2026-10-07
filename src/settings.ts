/** Whether targets and deviation of a day count that day or the week so far. */
export type TargetPeriod = "day" | "week";

export interface Category {
    name: string;
    tags: string[];
    target: string;
    /** Whether `target` is per day or per week. Defaults to per day. */
    targetPeriod?: TargetPeriod;
    fills?: string[];
}

export interface TimeTrackerStatisticsSettings {
    firstDayOfWeek: number;
    categories: Category[];
    monthlyNotesFolder: string;
    showChartsInNotes: boolean;
    targetRules: boolean;
    targetPeriod: TargetPeriod;
    lastSeenVersion?: string;
}

export const defaultSettings: TimeTrackerStatisticsSettings = {
    firstDayOfWeek: 1, //Monday
    monthlyNotesFolder: "",
    showChartsInNotes: false,
    targetRules: false,
    targetPeriod: "day",
    categories: [
        {
            name: "Work",
            tags: ['#work'],
            target: "08:00:00"
        },
        {
            name: "Leisure",
            tags: ['#leisure'],
            target: "00:00:00"
        }
    ]
};
