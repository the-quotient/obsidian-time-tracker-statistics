/**
 * Public holidays, computed offline. Germany only for now: the nationwide
 * holidays and those of each state. Holidays that only apply to parts of a
 * state (Corpus Christi in parts of Saxony and Thuringia, Assumption Day in
 * Catholic parts of Bavaria) are left out.
 */

export const HOLIDAY_REGIONS: { id: string; label: string }[] = [
    { id: "", label: "None" },
    { id: "DE", label: "Germany (nationwide only)" },
    { id: "DE-BW", label: "Germany: Baden-Württemberg" },
    { id: "DE-BY", label: "Germany: Bavaria" },
    { id: "DE-BE", label: "Germany: Berlin" },
    { id: "DE-BB", label: "Germany: Brandenburg" },
    { id: "DE-HB", label: "Germany: Bremen" },
    { id: "DE-HH", label: "Germany: Hamburg" },
    { id: "DE-HE", label: "Germany: Hesse" },
    { id: "DE-MV", label: "Germany: Mecklenburg-Vorpommern" },
    { id: "DE-NI", label: "Germany: Lower Saxony" },
    { id: "DE-NW", label: "Germany: North Rhine-Westphalia" },
    { id: "DE-RP", label: "Germany: Rhineland-Palatinate" },
    { id: "DE-SL", label: "Germany: Saarland" },
    { id: "DE-SN", label: "Germany: Saxony" },
    { id: "DE-ST", label: "Germany: Saxony-Anhalt" },
    { id: "DE-SH", label: "Germany: Schleswig-Holstein" },
    { id: "DE-TH", label: "Germany: Thuringia" }
];

export interface Holiday {
    date: Date;
    name: string;
}

/** Easter Sunday by the anonymous Gregorian algorithm. */
export function getEasterSunday(year: number): Date {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
}

function fromEaster(year: number, offset: number): Date {
    const easter = getEasterSunday(year);
    return new Date(year, easter.getMonth(), easter.getDate() + offset);
}

/** The Wednesday before 23 November. */
function repentanceDay(year: number): Date {
    const date = new Date(year, 10, 22);
    while (date.getDay() !== 3) date.setDate(date.getDate() - 1);
    return date;
}

function germanHolidays(year: number, state: string): Holiday[] {
    const fixed = (month: number, day: number): Date =>
        new Date(year, month - 1, day);
    const inStates = (...states: string[]): boolean => states.includes(state);
    const holidays: (Holiday | false)[] = [
        { date: fixed(1, 1), name: "New Year's Day" },
        inStates("BW", "BY", "ST") &&
            { date: fixed(1, 6), name: "Epiphany" },
        ((inStates("BE") && year >= 2019) || (inStates("MV") && year >= 2023)) &&
            { date: fixed(3, 8), name: "International Women's Day" },
        { date: fromEaster(year, -2), name: "Good Friday" },
        inStates("BB") && { date: fromEaster(year, 0), name: "Easter Sunday" },
        { date: fromEaster(year, 1), name: "Easter Monday" },
        { date: fixed(5, 1), name: "Labour Day" },
        { date: fromEaster(year, 39), name: "Ascension Day" },
        inStates("BB") && { date: fromEaster(year, 49), name: "Whit Sunday" },
        { date: fromEaster(year, 50), name: "Whit Monday" },
        inStates("BW", "BY", "HE", "NW", "RP", "SL") &&
            { date: fromEaster(year, 60), name: "Corpus Christi" },
        inStates("SL") && { date: fixed(8, 15), name: "Assumption Day" },
        inStates("TH") && year >= 2019 &&
            { date: fixed(9, 20), name: "World Children's Day" },
        { date: fixed(10, 3), name: "German Unity Day" },
        (year === 2017 ||
            inStates("BB", "MV", "SN", "ST", "TH") ||
            (inStates("HB", "HH", "NI", "SH") && year >= 2018)) &&
            { date: fixed(10, 31), name: "Reformation Day" },
        inStates("BW", "BY", "NW", "RP", "SL") &&
            { date: fixed(11, 1), name: "All Saints' Day" },
        inStates("SN") &&
            { date: repentanceDay(year), name: "Day of Repentance and Prayer" },
        { date: fixed(12, 25), name: "Christmas Day" },
        { date: fixed(12, 26), name: "Second Day of Christmas" }
    ];
    return holidays.filter((h): h is Holiday => h !== false);
}

/** The public holidays of `year` in `region` (an id of `HOLIDAY_REGIONS`). */
export function getPublicHolidays(year: number, region: string): Holiday[] {
    const [country, state = ""] = region.split("-");
    if (country === "DE") return germanHolidays(year, state);
    return [];
}
