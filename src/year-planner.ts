import { App, Modal, Notice, setIcon } from "obsidian";
import TimeTrackerStatisticsPlugin from "./main";
import {
    DAY_OFF_TYPES,
    DayOffType,
    DayTypeChanges,
    setDayTypes
} from "./carry-over";
import {
    MonthConfigCache,
    addDays,
    getDayOffLabel,
    isWeekend,
    startOfWeek,
    toDateKey,
    toMoment
} from "./period-view";
import { HOLIDAY_REGIONS, getPublicHolidays } from "./holidays";
import {
    countVacationDays,
    formatVacationBalance,
    getCarriedVacation
} from "./vacation";

type Brush = DayOffType | null;

interface PlannerCell {
    day: Date;
    el: HTMLElement;
}

function typeClass(type: DayOffType): string {
    return `stt-plan-${type}`;
}

/**
 * Plans the days off, vacation and sick days of a whole year. Changes are
 * held until saved, then written to the monthly notes month by month.
 */
export class DaysOffPlannerModal extends Modal {
    private plugin: TimeTrackerStatisticsPlugin;
    private year: number;
    private onSaved: () => void;
    private months: MonthConfigCache;
    private pending = new Map<string, { day: Date; type: Brush }>();
    private brush: Brush = "vacationDays";
    private paint: { type: Brush } | null = null;
    private cells: PlannerCell[] = [];
    private holidays = new Map<string, string>();
    private carriedVacation = 0;
    private saving = false;
    private saved = false;
    private renderToken = 0;

    private yearLabelEl: HTMLElement;
    private brushEl: HTMLElement;
    private summaryEl: HTMLElement;
    private monthsEl: HTMLElement;
    private fillButton: HTMLButtonElement;
    private saveButton: HTMLButtonElement;

    private readonly stopPainting = (): void => {
        this.paint = null;
    };

    constructor(
        app: App,
        plugin: TimeTrackerStatisticsPlugin,
        year: number,
        onSaved: () => void = () => {}
    ) {
        super(app);
        this.plugin = plugin;
        this.year = year;
        this.onSaved = onSaved;
        this.months = new MonthConfigCache(app);
    }

    onOpen(): void {
        this.modalEl.addClass("stt-planner-modal");
        this.setTitle("Plan days off");
        this.contentEl.addClass("stt-planner");

        this.buildToolbar();
        this.summaryEl = this.contentEl.createDiv({ cls: "stt-planner-summary" });
        this.monthsEl = this.contentEl.createDiv({ cls: "stt-planner-months" });
        this.buildFooter();

        this.scope.register([], "ArrowLeft", () => {
            this.shiftYear(-1);
            return false;
        });
        this.scope.register([], "ArrowRight", () => {
            this.shiftYear(1);
            return false;
        });
        window.addEventListener("pointerup", this.stopPainting);

        void this.render();
    }

    onClose(): void {
        this.renderToken++;
        window.removeEventListener("pointerup", this.stopPainting);
        if (!this.saved && this.pending.size > 0) {
            new Notice(`Discarded ${this.pending.size} unsaved changes.`);
        }
        this.contentEl.empty();
    }

    private buildToolbar(): void {
        const toolbar = this.contentEl.createDiv({ cls: "stt-toolbar" });

        this.brushEl = toolbar.createDiv({ cls: "stt-toggle" });
        const brushes: { type: Brush; label: string }[] = [
            ...DAY_OFF_TYPES,
            { type: null, label: "Workday" }
        ];
        for (const { type, label } of brushes) {
            const button = this.brushEl.createEl("button");
            button.dataset.type = type ?? "";
            if (type) {
                button.createSpan({ cls: `stt-plan-swatch ${typeClass(type)}` });
            }
            button.appendText(label);
            button.addEventListener("click", () => {
                this.brush = type;
                this.updateBrush();
            });
        }
        this.updateBrush();

        this.fillButton = toolbar.createEl("button", {
            text: "Fill public holidays"
        });
        this.fillButton.addEventListener("click", () => this.fillHolidays());

        const nav = toolbar.createDiv({ cls: "stt-nav" });
        const prev = nav.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Previous year" }
        });
        setIcon(prev, "chevron-left");
        prev.addEventListener("click", () => this.shiftYear(-1));
        this.yearLabelEl = nav.createDiv({ cls: "stt-period-label" });
        const next = nav.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Next year" }
        });
        setIcon(next, "chevron-right");
        next.addEventListener("click", () => this.shiftYear(1));
    }

    private buildFooter(): void {
        const footer = this.contentEl.createDiv({ cls: "stt-planner-footer" });
        footer.createDiv({
            cls: "stt-card-hint",
            text: "Click or drag over days to mark them. Marking a day " +
                "again with the same type makes it a workday. Weekends " +
                "never count towards the target."
        });
        const buttons = footer.createDiv({ cls: "stt-planner-buttons" });
        const cancel = buttons.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());
        this.saveButton = buttons.createEl("button", {
            text: "Save",
            cls: "mod-cta"
        });
        this.saveButton.addEventListener("click", () => void this.save());
    }

    private updateBrush(): void {
        this.brushEl.querySelectorAll<HTMLElement>("button").forEach(button => {
            button.toggleClass(
                "is-active",
                button.dataset.type === (this.brush ?? "")
            );
        });
    }

    private shiftYear(direction: number): void {
        this.year += direction;
        void this.render();
    }

    private getType(day: Date): Brush {
        const change = this.pending.get(toDateKey(day));
        return change ? change.type : this.months.getDayType(day);
    }

    private async render(): Promise<void> {
        const token = ++this.renderToken;
        this.yearLabelEl.setText(String(this.year));
        const firstDays = Array.from(
            { length: 12 },
            (_, month) => new Date(this.year, month, 1)
        );
        await this.months.load(firstDays);
        const carried = await getCarriedVacation(
            this.plugin.settings,
            this.year,
            year => this.countVacation(year)
        );
        if (token !== this.renderToken) return;
        this.carriedVacation = carried;

        const region = this.plugin.settings.holidayRegion;
        this.holidays = new Map(getPublicHolidays(this.year, region)
            .map(({ date, name }) => [toDateKey(date), name]));
        const regionLabel = HOLIDAY_REGIONS.find(r => r.id === region)?.label;
        this.fillButton.disabled = this.holidays.size === 0;
        this.fillButton.setAttr("aria-label", region && regionLabel
            ? `Mark the public holidays of ${regionLabel} as days off`
            : "Choose a region for public holidays in the settings");

        this.cells = [];
        this.monthsEl.empty();
        const firstDayOfWeek = this.plugin.settings.firstDayOfWeek;
        const todayKey = toDateKey(new Date());

        for (const first of firstDays) {
            const monthEl = this.monthsEl.createDiv({ cls: "stt-planner-month" });
            monthEl.createDiv({
                cls: "stt-planner-month-name",
                text: toMoment(first).format("MMMM")
            });
            const grid = monthEl.createDiv({ cls: "stt-planner-grid" });

            const weekStart = startOfWeek(first, firstDayOfWeek);
            for (let i = 0; i < 7; i++) {
                grid.createDiv({
                    cls: "stt-planner-weekday",
                    text: toMoment(addDays(weekStart, i)).format("dd")
                });
            }
            const offset = Math.round(
                (first.getTime() - weekStart.getTime()) / 86400000
            );
            for (let i = 0; i < offset; i++) grid.createDiv();

            for (
                let day = first;
                day.getMonth() === first.getMonth();
                day = addDays(day, 1)
            ) {
                const el = grid.createDiv({
                    cls: "stt-planner-day",
                    text: String(day.getDate())
                });
                el.toggleClass("is-weekend", isWeekend(day));
                el.toggleClass("is-today", toDateKey(day) === todayKey);
                el.toggleClass("is-holiday", this.holidays.has(toDateKey(day)));
                const cell = { day, el };
                this.cells.push(cell);
                this.updateCell(cell);

                el.addEventListener("pointerdown", event => {
                    event.preventDefault();
                    this.startPainting(cell);
                });
                el.addEventListener("pointerenter", () => {
                    if (this.paint) this.applyPaint(cell);
                });
            }
        }
        this.updateSummary();
    }

    private startPainting(cell: PlannerCell): void {
        const current = this.getType(cell.day);
        if (isWeekend(cell.day)) {
            // Weekends are never painted, but a mark left there can be removed
            if (current) this.setType(cell, null);
            return;
        }
        const type = current === this.brush ? null : this.brush;
        this.paint = { type };
        this.applyPaint(cell);
    }

    private applyPaint(cell: PlannerCell): void {
        if (!this.paint || isWeekend(cell.day)) return;
        this.setType(cell, this.paint.type);
    }

    private setType(cell: PlannerCell, type: Brush): void {
        const key = toDateKey(cell.day);
        if (this.months.getDayType(cell.day) === type) {
            this.pending.delete(key);
        } else {
            this.pending.set(key, { day: cell.day, type });
        }
        this.updateCell(cell);
        this.updateSummary();
    }

    private updateCell({ day, el }: PlannerCell): void {
        const type = this.getType(day);
        for (const { type: t } of DAY_OFF_TYPES) {
            el.toggleClass(typeClass(t), type === t);
        }
        el.toggleClass("is-pending", this.pending.has(toDateKey(day)));
        const parts = [toMoment(day).format("ddd, D MMM YYYY")];
        const holiday = this.holidays.get(toDateKey(day));
        if (holiday) parts.push(holiday);
        if (type) parts.push(getDayOffLabel(type));
        el.setAttr("aria-label", parts.join(" · "));
    }

    private updateSummary(): void {
        this.summaryEl.empty();
        const counts = new Map<DayOffType, number>();
        for (const { day } of this.cells) {
            const type = this.getType(day);
            if (type && !isWeekend(day)) {
                counts.set(type, (counts.get(type) ?? 0) + 1);
            }
        }
        for (const { type, label } of DAY_OFF_TYPES) {
            const item = this.summaryEl.createDiv({ cls: "stt-planner-count" });
            item.createSpan({ cls: `stt-plan-swatch ${typeClass(type)}` });
            const count = counts.get(type) ?? 0;
            item.createSpan({
                text: `${label}: ` + (type === "vacationDays"
                    ? formatVacationBalance({
                        used: count,
                        allowance: this.plugin.settings.vacationDaysPerYear,
                        carried: this.carriedVacation
                    })
                    : String(count))
            });
        }
        if (this.pending.size > 0) {
            this.summaryEl.createDiv({
                cls: "stt-planner-pending",
                text: `${this.pending.size} unsaved changes`
            });
        }
        this.saveButton.disabled = this.pending.size === 0 || this.saving;
    }

    /** Vacation days of `year`, unsaved changes included. */
    private async countVacation(year: number): Promise<number> {
        await this.months.load(Array.from(
            { length: 12 },
            (_, month) => new Date(year, month, 1)
        ));
        return countVacationDays(year, day => this.getType(day));
    }

    /**
     * Marks the public holidays on weekdays as days off. Days already marked
     * keep their type.
     */
    private fillHolidays(): void {
        let filled = 0, kept = 0;
        for (const cell of this.cells) {
            if (!this.holidays.has(toDateKey(cell.day)) || isWeekend(cell.day)) {
                continue;
            }
            const type = this.getType(cell.day);
            if (type === "daysOff") continue;
            if (type) {
                kept++;
            } else {
                this.setType(cell, "daysOff");
                filled++;
            }
        }
        let message = filled === 0 ? "All public holidays are already marked."
            : `Marked ${filled} public holidays as days off.`;
        if (kept > 0) {
            message += ` ${kept} already marked as vacation or sick were kept.`;
        }
        new Notice(message);
    }

    private async save(): Promise<void> {
        if (this.saving || this.pending.size === 0) return;
        this.saving = true;
        this.saveButton.disabled = true;

        const byMonth = new Map<string, { year: number; month: number;
            changes: DayTypeChanges }>();
        for (const { day, type } of this.pending.values()) {
            const key = `${day.getFullYear()}-${day.getMonth() + 1}`;
            let entry = byMonth.get(key);
            if (!entry) {
                entry = {
                    year: day.getFullYear(),
                    month: day.getMonth() + 1,
                    changes: new Map()
                };
                byMonth.set(key, entry);
            }
            entry.changes.set(day.getDate(), type);
        }

        try {
            for (const { year, month, changes } of byMonth.values()) {
                await setDayTypes(this.plugin, year, month, changes);
                for (const [key, { day }] of this.pending) {
                    if (day.getFullYear() === year &&
                        day.getMonth() + 1 === month) {
                        this.pending.delete(key);
                    }
                }
            }
            this.saved = true;
        } catch (error) {
            console.error("Simple Time Tracker (Planner) Error:", error);
            new Notice("Could not update the monthly notes.");
        }
        this.saving = false;
        this.onSaved();
        if (this.saved) {
            this.close();
        } else {
            // Months already written are no longer pending; show what is stored
            this.months.clear();
            await this.render();
        }
    }
}
