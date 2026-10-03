export interface Category {
    name: string;
    tags: string[];
    target: string;
}

export interface TimeTrackerStatisticsSettings {
    firstDayOfWeek: number;
    categories: Category[];
    monthlyNotesFolder: string;
    showChartsInNotes: boolean;
    lastSeenVersion?: string;
}

export const defaultSettings: TimeTrackerStatisticsSettings = {
    firstDayOfWeek: 1, //Monday
    monthlyNotesFolder: "",
    showChartsInNotes: false,
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
