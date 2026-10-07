export interface Category {
    name: string;
    tags: string[];
    target: string;
    fills?: string[];
}

export interface TimeTrackerStatisticsSettings {
    firstDayOfWeek: number;
    categories: Category[];
    monthlyNotesFolder: string;
    showChartsInNotes: boolean;
    targetRules: boolean;
    lastSeenVersion?: string;
}

export const defaultSettings: TimeTrackerStatisticsSettings = {
    firstDayOfWeek: 1, //Monday
    monthlyNotesFolder: "",
    showChartsInNotes: false,
    targetRules: false,
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
