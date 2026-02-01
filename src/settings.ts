export interface Category {
    name: string;
    tags: string[];
    target: string;
}

export const defaultSettings: TimeTrackerStatisticsSettings = {
    firstDayOfWeek: 1, //Monday
    categories : [
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

export interface TimeTrackerStatisticsSettings {
    firstDayOfWeek: number;
    categories: Category[];
}
