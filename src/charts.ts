const SVG_NS = "http://www.w3.org/2000/svg";
const HOUR = 3600000;
const HEAT_LEVELS = 5;

export interface ChartSeries {
    key: string;
    label: string;
    colorClass: string;
}

export type ValueFormatter = (ms: number) => string;

export class ChartTooltip {
    private el: HTMLElement;

    constructor() {
        this.el = document.body.createDiv({ cls: "stt-chart-tooltip" });
    }

    destroy(): void {
        this.el.remove();
    }

    show(event: MouseEvent, title: string, lines: string[]): void {
        this.el.empty();
        this.el.createDiv({ cls: "stt-chart-tooltip-title", text: title });
        for (const line of lines) {
            this.el.createDiv({ text: line });
        }
        this.el.addClass("is-visible");
        this.move(event);
    }

    move(event: MouseEvent): void {
        const offset = 14;
        const width = this.el.offsetWidth;
        const height = this.el.offsetHeight;
        let x = event.clientX + offset;
        let y = event.clientY + offset;
        if (x + width > window.innerWidth - 8) {
            x = event.clientX - offset - width;
        }
        if (y + height > window.innerHeight - 8) {
            y = event.clientY - offset - height;
        }
        this.el.setCssProps({
            "--stt-tooltip-x": `${Math.max(8, x)}px`,
            "--stt-tooltip-y": `${Math.max(8, y)}px`
        });
    }

    hide(): void {
        this.el.removeClass("is-visible");
    }
}

function svgEl<K extends keyof SVGElementTagNameMap>(
    parent: Element,
    tag: K,
    attrs: Record<string, string | number> = {},
    cls?: string
): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
        el.setAttribute(name, String(value));
    }
    if (cls) el.setAttribute("class", cls);
    parent.appendChild(el);
    return el;
}

function createSvgRoot(
    parent: HTMLElement,
    width: number,
    height: number,
    label: string
): SVGSVGElement {
    const svg = svgEl(parent, "svg", {
        viewBox: `0 0 ${width} ${height}`,
        role: "img",
        "aria-label": label
    }, "stt-chart-svg");
    return svg;
}

function bindTooltip(
    target: Element,
    tooltip: ChartTooltip,
    title: string,
    lines: string[],
    onClick?: () => void
): void {
    target.addEventListener("mouseenter", (event: Event) => {
        tooltip.show(event as MouseEvent, title, lines);
    });
    target.addEventListener("mousemove", (event: Event) => {
        tooltip.move(event as MouseEvent);
    });
    target.addEventListener("mouseleave", () => tooltip.hide());
    if (onClick) {
        target.classList.add("is-clickable");
        target.addEventListener("click", () => {
            tooltip.hide();
            onClick();
        });
    }
}

export function formatHours(ms: number): string {
    if (ms <= 0) return "0h";
    const hours = ms / HOUR;
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

function niceStep(maxHours: number, tickCount: number): number {
    const steps = [0.25, 0.5, 1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500];
    for (const step of steps) {
        if (maxHours / step <= tickCount) return step;
    }
    return Math.ceil(maxHours / tickCount / 1000) * 1000;
}

export function renderEmpty(parent: HTMLElement, text: string): void {
    parent.createDiv({ cls: "stt-chart-empty", text });
}

export function renderLegend(
    parent: HTMLElement,
    series: ChartSeries[]
): void {
    const legend = parent.createDiv({ cls: "stt-chart-legend" });
    for (const s of series) {
        const item = legend.createDiv({ cls: "stt-chart-legend-item" });
        item.createSpan({ cls: `stt-swatch ${s.colorClass}` });
        item.createSpan({ text: s.label });
    }
}

export interface BarDatum {
    label: string;
    title: string;
    values: number[];
    target?: number;
    onClick?: () => void;
}

export interface BarChartOptions {
    series: ChartSeries[];
    bars: BarDatum[];
    tooltip: ChartTooltip;
    format: ValueFormatter;
    ariaLabel: string;
    maxLabels?: number;
}

export function renderStackedBarChart(
    parent: HTMLElement,
    options: BarChartOptions
): void {
    const { series, bars, tooltip, format } = options;
    const width = 640;
    const height = 240;
    const margin = { top: 10, right: 8, bottom: 24, left: 40 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;

    const maxValue = Math.max(
        HOUR / 4,
        ...bars.map(bar => Math.max(
            bar.values.reduce((sum, v) => sum + v, 0),
            bar.target ?? 0
        ))
    );
    const step = niceStep(maxValue / HOUR, 4);
    const ticks = Math.ceil(maxValue / HOUR / step);
    const axisMax = ticks * step * HOUR;
    const yScale = (value: number) =>
        margin.top + plotHeight - (value / axisMax) * plotHeight;

    const svg = createSvgRoot(parent, width, height, options.ariaLabel);

    for (let i = 0; i <= ticks; i++) {
        const value = i * step * HOUR;
        const y = yScale(value);
        svgEl(svg, "line", {
            x1: margin.left, x2: width - margin.right, y1: y, y2: y
        }, i === 0 ? "stt-axis-line" : "stt-grid-line");
        const label = svgEl(svg, "text", {
            x: margin.left - 6, y: y + 3, "text-anchor": "end"
        }, "stt-axis-text");
        label.textContent = formatHours(value);
    }

    const band = plotWidth / Math.max(bars.length, 1);
    const barWidth = Math.min(28, Math.max(band * 0.7, 2));
    const labelEvery = Math.ceil(bars.length / (options.maxLabels ?? 16));

    bars.forEach((bar, index) => {
        const x = margin.left + index * band;
        const barX = x + (band - barWidth) / 2;
        const group = svgEl(svg, "g", {}, "stt-bar-group");

        svgEl(group, "rect", {
            x, y: margin.top, width: band, height: plotHeight
        }, "stt-bar-hover");

        let stacked = 0;
        const total = bar.values.reduce((sum, v) => sum + v, 0);
        bar.values.forEach((value, seriesIndex) => {
            if (value <= 0) return;
            const s = series[seriesIndex];
            if (!s) return;
            const y0 = yScale(stacked);
            const y1 = yScale(stacked + value);
            stacked += value;
            svgEl(group, "rect", {
                x: barX,
                y: y1,
                width: barWidth,
                height: Math.max(y0 - y1, 1),
                rx: Math.min(2, barWidth / 4)
            }, `stt-bar ${s.colorClass}`);
        });

        if (bar.target && bar.target > 0) {
            const y = yScale(bar.target);
            svgEl(group, "line", {
                x1: barX - 3, x2: barX + barWidth + 3, y1: y, y2: y
            }, "stt-target-line");
        }

        if (index % labelEvery === 0) {
            const label = svgEl(svg, "text", {
                x: x + band / 2,
                y: height - margin.bottom + 15,
                "text-anchor": "middle"
            }, "stt-axis-text");
            label.textContent = bar.label;
        }

        const lines = series
            .map((s, i) => ({ s, value: bar.values[i] ?? 0 }))
            .filter(({ value }) => value > 0)
            .map(({ s, value }) => `${s.label}: ${format(value)}`);
        lines.push(`Total: ${format(total)}`);
        if (bar.target && bar.target > 0) {
            lines.push(`Target: ${format(bar.target)}`);
        }
        bindTooltip(group, tooltip, bar.title, lines, bar.onClick);
    });

    if (bars.some(bar => bar.target && bar.target > 0)) {
        const legend = parent.createDiv({ cls: "stt-chart-note" });
        legend.createSpan({ cls: "stt-target-swatch" });
        legend.createSpan({ text: "Target" });
    }
}

export interface DonutSlice {
    label: string;
    value: number;
    colorClass: string;
}

function polar(cx: number, cy: number, r: number, angle: number) {
    return {
        x: cx + r * Math.sin(angle),
        y: cy - r * Math.cos(angle)
    };
}

function arcPath(
    cx: number,
    cy: number,
    outer: number,
    inner: number,
    start: number,
    end: number
): string {
    const large = end - start > Math.PI ? 1 : 0;
    const p1 = polar(cx, cy, outer, start);
    const p2 = polar(cx, cy, outer, end);
    const p3 = polar(cx, cy, inner, end);
    const p4 = polar(cx, cy, inner, start);
    return [
        `M ${p1.x} ${p1.y}`,
        `A ${outer} ${outer} 0 ${large} 1 ${p2.x} ${p2.y}`,
        `L ${p3.x} ${p3.y}`,
        `A ${inner} ${inner} 0 ${large} 0 ${p4.x} ${p4.y}`,
        "Z"
    ].join(" ");
}

export function renderDonutChart(
    parent: HTMLElement,
    slices: DonutSlice[],
    tooltip: ChartTooltip,
    format: ValueFormatter,
    ariaLabel: string
): void {
    const visible = slices.filter(slice => slice.value > 0);
    const total = visible.reduce((sum, slice) => sum + slice.value, 0);
    if (total <= 0) {
        renderEmpty(parent, "No tracked time in this period.");
        return;
    }

    const wrapper = parent.createDiv({ cls: "stt-donut" });
    const size = 200;
    const center = size / 2;
    const outer = 92;
    const inner = 58;
    const svg = createSvgRoot(wrapper, size, size, ariaLabel);
    svg.addClass("stt-donut-svg");

    const percent = (value: number) =>
        `${((value / total) * 100).toFixed(1)}%`;

    let angle = 0;
    for (const slice of visible) {
        const sweep = (slice.value / total) * Math.PI * 2;
        let mark: SVGElement;
        if (visible.length === 1) {
            mark = svgEl(svg, "circle", {
                cx: center,
                cy: center,
                r: (outer + inner) / 2,
                "stroke-width": outer - inner
            }, `stt-donut-ring ${slice.colorClass}`);
        } else {
            mark = svgEl(svg, "path", {
                d: arcPath(center, center, outer, inner, angle, angle + sweep)
            }, `stt-donut-slice ${slice.colorClass}`);
        }
        bindTooltip(mark, tooltip, slice.label, [
            `${format(slice.value)} (${percent(slice.value)})`
        ]);
        angle += sweep;
    }

    const totalLabel = svgEl(svg, "text", {
        x: center, y: center - 4, "text-anchor": "middle"
    }, "stt-donut-total");
    totalLabel.textContent = formatHours(total);
    const caption = svgEl(svg, "text", {
        x: center, y: center + 16, "text-anchor": "middle"
    }, "stt-axis-text");
    caption.textContent = "Total";

    const legend = wrapper.createDiv({ cls: "stt-donut-legend" });
    for (const slice of visible) {
        const row = legend.createDiv({ cls: "stt-donut-legend-row" });
        row.createSpan({ cls: `stt-swatch ${slice.colorClass}` });
        row.createSpan({ cls: "stt-donut-legend-label", text: slice.label });
        row.createSpan({
            cls: "stt-donut-legend-value",
            text: formatHours(slice.value)
        });
        row.createSpan({
            cls: "stt-donut-legend-percent",
            text: percent(slice.value)
        });
    }
}

export interface HeatCell {
    row: number;
    col: number;
    value: number;
    title: string;
    text?: string;
    onClick?: () => void;
}

export interface HeatmapOptions {
    rowLabels: string[];
    colLabels: string[];
    cells: HeatCell[];
    cellSize: number;
    tooltip: ChartTooltip;
    format: ValueFormatter;
    ariaLabel: string;
    rowLabelWidth?: number;
}

export function renderHeatmap(
    parent: HTMLElement,
    options: HeatmapOptions
): void {
    const { rowLabels, colLabels, cells, cellSize, tooltip, format } = options;
    const gap = 3;
    const left = options.rowLabelWidth ?? 40;
    const top = 16;
    const pitch = cellSize + gap;
    const width = left + colLabels.length * pitch;
    const height = top + rowLabels.length * pitch;
    const max = Math.max(0, ...cells.map(cell => cell.value));

    const wrapper = parent.createDiv({ cls: "stt-heatmap" });
    const svg = createSvgRoot(wrapper, width, height, options.ariaLabel);
    svg.setAttribute("width", String(width));

    rowLabels.forEach((label, row) => {
        if (!label) return;
        const text = svgEl(svg, "text", {
            x: left - 6,
            y: top + row * pitch + cellSize / 2 + 3,
            "text-anchor": "end"
        }, "stt-axis-text");
        text.textContent = label;
    });

    colLabels.forEach((label, col) => {
        if (!label) return;
        const text = svgEl(svg, "text", {
            x: left + col * pitch,
            y: top - 5
        }, "stt-axis-text");
        text.textContent = label;
    });

    for (const cell of cells) {
        const level = cell.value > 0 && max > 0
            ? Math.max(1, Math.ceil((cell.value / max) * HEAT_LEVELS))
            : 0;
        const x = left + cell.col * pitch;
        const y = top + cell.row * pitch;
        const group = svgEl(svg, "g", {}, "stt-heat-group");
        svgEl(group, "rect", {
            x, y, width: cellSize, height: cellSize, rx: 2
        }, `stt-heat-cell stt-heat-${level}`);
        if (cell.text) {
            const text = svgEl(group, "text", {
                x: x + cellSize / 2,
                y: y + cellSize / 2 + 4,
                "text-anchor": "middle"
            }, `stt-heat-text${level >= 4 ? " is-strong" : ""}`);
            text.textContent = cell.text;
        }
        bindTooltip(
            group,
            tooltip,
            cell.title,
            [cell.value > 0 ? format(cell.value) : "No tracked time"],
            cell.onClick
        );
    }

    const scale = parent.createDiv({ cls: "stt-heat-scale" });
    scale.createSpan({ text: "Less" });
    for (let level = 0; level <= HEAT_LEVELS; level++) {
        scale.createSpan({ cls: `stt-heat-scale-cell stt-heat-${level}` });
    }
    scale.createSpan({ text: "More" });
    if (max > 0) {
        scale.createSpan({
            cls: "stt-heat-scale-max",
            text: `Max: ${format(max)}`
        });
    }
}
