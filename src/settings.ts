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
    /** Region of `HOLIDAY_REGIONS` whose public holidays the planner fills. */
    holidayRegion: string;
    /** Vacation days per year; 0 shows no allowance. */
    vacationDaysPerYear: number;
    /** Whether vacation days left at the end of a year carry over. */
    vacationCarryOver: boolean;
    /** First year whose vacation days are counted for the carry-over. */
    vacationFirstYear: number;
    /** Vacation days carried into the first counted year. */
    vacationCarriedIntoFirstYear: number;
    lastSeenVersion?: string;
}

export const defaultSettings: TimeTrackerStatisticsSettings = {
    firstDayOfWeek: 1, //Monday
    monthlyNotesFolder: "",
    showChartsInNotes: false,
    targetRules: false,
    targetPeriod: "day",
    holidayRegion: "",
    vacationDaysPerYear: 0,
    vacationCarryOver: false,
    vacationFirstYear: 0,
    vacationCarriedIntoFirstYear: 0,
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
