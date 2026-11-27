import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type MouseHandlerDataParam } from "recharts";
import type { AccountScope, TxDateBounds, TxRange } from "@mbm/shared";
import { useFlows, useSeries } from "../lib/queries";
import { dateText, dayLabel, fmt, monthYear, shortDate, shortEuro } from "../lib/format";
import { axisLayout, groupFlows, groupPointLabel, groupSeries, niceScale, periodLabel, periodOf, type ChartStyle, type FlowGroupPoint, type GroupPoint, type SeriesGroup } from "../lib/seriesGroups";

type ChartPoint = { date: string; balance?: number; forecast?: number; group?: GroupPoint; income?: number; expenses?: number; net?: number; flow?: FlowGroupPoint };
/** The days a picked value covers. */
export type ChartPeriod = { from: string; to: string };
type PickHandler = (period: ChartPeriod) => void;

const AXIS_WIDTH = 64;
const MARGIN = { top: 8, right: 0, bottom: 0, left: 0 };
const TICK = { fill: "var(--faint)", fontSize: 11 };
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Balance as an area with the Iris → Glacier line; `range` replaces `days`, a `span` with an end replaces both.
 * `height: "fill"` takes the room left in a flex column (a card of fixed height).
 * With `group` every value has its own place, as a bar or a point of the line (`chartStyle`): daily balances
 * or averages per month, quarter or year; when they do not fit, the plot scrolls sideways under a fixed amount axis.
 * `chartStyle` "flow" shows instead the income and expenses of each period as bars, their total as a line.
 * `onPick` gets the days of the value clicked, anywhere in its column; a value of the forecast is not picked.
 */
export function BalanceChart(props: {
    scope: AccountScope;
    days?: number;
    range?: TxRange;
    span?: TxDateBounds;
    height?: number | "fill";
    forecastDays?: number;
    group?: SeriesGroup;
    chartStyle?: ChartStyle;
    onPick?: PickHandler;
}) {
    return props.chartStyle === "flow" ? <FlowChart {...props} group={props.group ?? "day"} /> : <BalanceSeriesChart {...props} />;
}

/** Income and expenses per period as bars up and down, the total of each period as a line; own transfers left out. */
function FlowChart({
    scope,
    days = 90,
    range,
    span,
    height = 210,
    group,
    onPick,
}: {
    scope: AccountScope;
    days?: number;
    range?: TxRange;
    span?: TxDateBounds;
    height?: number | "fill";
    group: SeriesGroup;
    onPick?: PickHandler;
}) {
    const flows = useFlows(scope, days, range, span);
    const id = useId().replace(/:/g, "");
    const points = useMemo<ChartPoint[]>(
        () => groupFlows(flows.data?.points ?? [], group).map((f) => ({ date: f.date, income: f.income, expenses: f.expenses, net: f.net, flow: f })),
        [flows.data, group],
    );
    const style = height === "fill" ? undefined : ({ "--ch": `${height}px` } as React.CSSProperties);
    return (
        <div className={`chart-wrap amt ${onPick ? "pick" : ""}`} style={style}>
            {points.length > 0 && <ScrollingChart id={id} points={points} group={group} chartStyle="flow" hasForecast={false} onPick={onPick} />}
        </div>
    );
}

function BalanceSeriesChart({
    scope,
    days = 90,
    range,
    span,
    height = 210,
    forecastDays = 0,
    group,
    chartStyle = "bar",
    onPick,
}: {
    scope: AccountScope;
    days?: number;
    range?: TxRange;
    span?: TxDateBounds;
    height?: number | "fill";
    forecastDays?: number;
    group?: SeriesGroup;
    chartStyle?: ChartStyle;
    onPick?: PickHandler;
}) {
    // Averages leave out the forecast: it would mix into the running period
    const series = useSeries(scope, days, range, span, group && group !== "day" ? 0 : forecastDays);
    const id = useId().replace(/:/g, "");
    const points = useMemo<ChartPoint[]>(() => {
        const past = series.data?.points ?? [];
        if (group && group !== "day") return groupSeries(past, group).map((g) => ({ date: g.date, balance: g.balance, group: g }));
        const future = series.data?.forecast ?? [];
        // As bars the forecast gets its own places after the past
        if (group && chartStyle === "bar") return [...past, ...future.map((p) => ({ date: p.date, forecast: p.balance }))];
        // The forecast continues the line: its first point is the last day of the past
        return future.length === 0 ? past : [...past.slice(0, -1), ...past.slice(-1).map((p) => ({ ...p, forecast: p.balance })), ...future.map((p) => ({ date: p.date, forecast: p.balance }))];
    }, [series.data, group, chartStyle]);
    const hasForecast = points.some((p) => p.forecast !== undefined);
    const style = height === "fill" ? undefined : ({ "--ch": `${height}px` } as React.CSSProperties);

    if (group) {
        return (
            <div className={`chart-wrap amt ${onPick ? "pick" : ""}`} style={style}>
                {points.length > 0 && <ScrollingChart id={id} points={points} group={group} chartStyle={chartStyle} hasForecast={hasForecast} onPick={onPick} />}
            </div>
        );
    }

    // Over more than about a year the axis shows months with the year
    const tick = points.length > 400 ? monthYear : shortDate;
    return (
        <div className={`chart-wrap amt ${height === "fill" ? "fill" : ""} ${onPick ? "pick" : ""}`} style={style}>
            {points.length > 0 && (
                <ResponsiveContainer width="100%" height="100%">
                    {/* No accessibility layer: it makes the chart a tab stop (tabIndex 0) that takes focus on click */}
                    <AreaChart data={points} margin={MARGIN} accessibilityLayer={false} onClick={onPick && pickFrom(points, "day", onPick)}>
                        {chartDefs(id)}
                        <XAxis dataKey="date" tickFormatter={tick} tickLine={false} axisLine={false} minTickGap={40} tick={TICK} />
                        <YAxis orientation="right" tickFormatter={shortEuro} tickLine={false} axisLine={false} width={AXIS_WIDTH} domain={["auto", "auto"]} tick={TICK} />
                        {chartTooltip("day", { stroke: "var(--faint)" })}
                        {balanceArea(id, "day")}
                        {hasForecast && forecastArea()}
                    </AreaChart>
                </ResponsiveContainer>
            )}
        </div>
    );
}

/** Bars or a line with fixed room per value in a sideways scroller, the amount axis beside it; starts at the newest value. */
function ScrollingChart({
    id,
    points,
    group,
    chartStyle,
    hasForecast,
    onPick,
}: {
    id: string;
    points: ChartPoint[];
    group: SeriesGroup;
    chartStyle: ChartStyle;
    hasForecast: boolean;
    onPick?: PickHandler;
}) {
    const scroller = useRef<HTMLDivElement>(null);
    const [box, setBox] = useState({ width: 0, height: 0 });
    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el) return;
        // The content box leaves out a scrollbar that takes room
        const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Narrow values name only some of them (days the 1st and 15th, months each quarter, quarters each year)
    const { slot, edge, sparse, tick: tickText } = useMemo(() => axisLayout(group, points.map((p) => p.date)), [group, points]);
    const radius: [number, number, number, number] = sparse ? [2, 2, 0, 0] : [4, 4, 0, 0];
    const width = Math.max(box.width, points.length * slot + 2 * edge);
    const scale = useMemo(() => {
        const values = points.flatMap((p) => [p.balance, p.forecast, p.income, p.expenses, p.net]).filter((v): v is number => v !== undefined);
        // Bars stand on zero: their scale always holds it
        return chartStyle === "line" ? niceScale(Math.min(...values), Math.max(...values)) : niceScale(Math.min(0, ...values), Math.max(0, ...values));
    }, [points, chartStyle]);

    // Show the newest values whenever the grouping or the period changes
    const ready = box.width > 0;
    const endKey = `${group}|${chartStyle}|${points.length}|${points[0]?.date}|${points.at(-1)?.date}`;
    useLayoutEffect(() => {
        const el = scroller.current;
        if (el && ready) el.scrollLeft = el.scrollWidth;
    }, [endKey, ready, width]);

    const chartHeight = Math.max(0, box.height);
    const size = { width, height: chartHeight, data: points, margin: MARGIN, accessibilityLayer: false, onClick: onPick && pickFrom(points, group, onPick) };
    // Bars fill their band; points of the line sit in the middle of their room
    const pad = chartStyle === "line" ? edge + slot / 2 : edge;
    const xAxis = <XAxis dataKey="date" tickFormatter={tickText} tickLine={false} axisLine={false} interval={0} padding={{ left: pad, right: pad }} tick={TICK} />;
    const yAxis = <YAxis hide domain={scale.domain} ticks={scale.ticks} allowDataOverflow />;
    // Thin dim lines at the values of the amount axis, behind the values
    const grid = <CartesianGrid vertical={false} horizontalValues={scale.ticks} stroke="var(--line)" strokeWidth={1} />;
    const zero = scale.domain[0] < 0 && scale.domain[1] > 0 && <ReferenceLine y={0} stroke="var(--faint)" />;
    return (
        <div className="chart-scroll-wrap">
            <div className="chart-scroll" ref={scroller}>
                {ready && chartHeight > 0 && chartStyle === "line" && (
                    <AreaChart {...size}>
                        {chartDefs(id)}
                        {xAxis}
                        {yAxis}
                        {grid}
                        {chartTooltip(group, { stroke: "var(--faint)" })}
                        {zero}
                        {balanceArea(id, group)}
                        {hasForecast && forecastArea()}
                    </AreaChart>
                )}
                {ready && chartHeight > 0 && chartStyle === "flow" && (
                    <ComposedChart {...size} barCategoryGap="10%" maxBarSize={47} stackOffset="sign">
                        {chartDefs(id)}
                        {xAxis}
                        {yAxis}
                        {grid}
                        {flowTooltip(group)}
                        {zero}
                        {(["income", "expenses"] as const).map((key) => (
                            <Bar key={key} dataKey={key} stackId="f" radius={radius} fill={key === "income" ? "var(--pos)" : "var(--neg)"} isAnimationActive={!reducedMotion()}>
                                {points.map((p) => (
                                    // A period cut by the range (the running month) paler
                                    <Cell key={p.date} fillOpacity={p.flow?.partial ? 0.45 : 0.85} />
                                ))}
                            </Bar>
                        ))}
                        <Line
                            type="monotone"
                            dataKey="net"
                            stroke={`url(#s${id})`}
                            strokeWidth={2.4}
                            isAnimationActive={!reducedMotion()}
                            dot={false}
                            activeDot={{ r: 5, fill: "var(--glacier)", stroke: "var(--surface)", strokeWidth: 2 }}
                        />
                    </ComposedChart>
                )}
                {ready && chartHeight > 0 && chartStyle === "bar" && (
                    <BarChart {...size} barCategoryGap="10%" maxBarSize={47}>
                        {chartDefs(id)}
                        {xAxis}
                        {yAxis}
                        {grid}
                        {chartTooltip(group, { fill: "var(--hover)" })}
                        {zero}
                        <Bar dataKey="balance" stackId="b" radius={radius} isAnimationActive={!reducedMotion()}>
                            {points.map((p) => (
                                // Negative balances in red; a period cut by the range (the running month) paler
                                <Cell key={p.date} fill={(p.balance ?? 0) < 0 ? "var(--neg)" : `url(#s${id})`} fillOpacity={p.group?.partial ? 0.5 : 1} />
                            ))}
                        </Bar>
                        {hasForecast && (
                            <Bar dataKey="forecast" stackId="b" radius={radius} fill="var(--muted)" fillOpacity={0.35} isAnimationActive={false} />
                        )}
                    </BarChart>
                )}
            </div>
            <div className="chart-axis" aria-hidden="true">
                {ready && chartHeight > 0 && (
                    // Same height, margins and x-axis room as the plot, so the ticks line up with it
                    <BarChart width={AXIS_WIDTH} height={chartHeight} data={points} margin={MARGIN} accessibilityLayer={false}>
                        <XAxis dataKey="date" tick={false} tickLine={false} axisLine={false} />
                        <YAxis orientation="right" tickFormatter={shortEuro} tickLine={false} axisLine={false} width={AXIS_WIDTH} domain={scale.domain} ticks={scale.ticks} tick={TICK} />
                        <Bar dataKey={chartStyle === "flow" ? "net" : "balance"} fill="none" isAnimationActive={false} />
                    </BarChart>
                )}
            </div>
        </div>
    );
}

/** Click handler of a chart: the whole period of the value under the pointer, none for a value of the forecast. */
function pickFrom(points: readonly ChartPoint[], group: SeriesGroup, onPick: PickHandler) {
    return (state: MouseHandlerDataParam) => {
        const p = state.activeTooltipIndex == null ? undefined : points[Number(state.activeTooltipIndex)];
        if (!p || (p.balance === undefined && !p.flow)) return;
        if (group === "day") return onPick({ from: p.date, to: p.date });
        const { start, end } = periodOf(p.date, group);
        onPick({ from: start, to: end });
    };
}

// Plain functions, not components: Recharts reads its own elements among the chart's children

function chartDefs(id: string) {
    return (
        <defs>
            {/* Measured on the chart, not the line: a flat line has no height and would not be painted at all */}
            <linearGradient id={`s${id}`} gradientUnits="userSpaceOnUse" x1="0%" y1="0" x2="100%" y2="0">
                <stop offset="0%" stopColor="var(--iris)" />
                <stop offset="100%" stopColor="var(--glacier)" />
            </linearGradient>
            <linearGradient id={`f${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--iris)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--iris)" stopOpacity={0} />
            </linearGradient>
        </defs>
    );
}

function chartTooltip(group: SeriesGroup, cursor: React.SVGProps<SVGElement>) {
    return (
        <Tooltip
            cursor={cursor}
            content={({ active, payload }) => {
                const p = active ? (payload?.[0]?.payload as ChartPoint | undefined) : undefined;
                if (!p) return null;
                const label = p.group && group !== "day" ? groupPointLabel(p.group, group) : p.balance === undefined ? `${dateText(p.date)} · Vorschau` : dayLabel(p.date);
                return (
                    <div className="chart-tip">
                        <span className="muted">{label}</span>
                        <b className="amt">{fmt(p.balance ?? p.forecast ?? 0)}</b>
                    </div>
                );
            }}
        />
    );
}

function flowTooltip(group: SeriesGroup) {
    return (
        <Tooltip
            cursor={{ fill: "var(--hover)" }}
            content={({ active, payload }) => {
                const f = active ? (payload?.[0]?.payload as ChartPoint | undefined)?.flow : undefined;
                if (!f) return null;
                return (
                    <div className="chart-tip">
                        <span className="muted">{group === "day" ? dayLabel(f.date) : periodLabel(f, group)}</span>
                        <dl className="chart-tip-rows">
                            <dt>Eingänge</dt>
                            <dd className="pos">{fmt(f.income)}</dd>
                            <dt>Ausgaben</dt>
                            <dd className="neg">{fmt(f.expenses)}</dd>
                            <dt>Saldo</dt>
                            <dd className={f.net < 0 ? "neg" : undefined}>
                                <b>{fmt(f.net)}</b>
                            </dd>
                        </dl>
                    </div>
                );
            }}
        />
    );
}

function balanceArea(id: string, group: SeriesGroup) {
    return (
        <Area
            type="monotone"
            dataKey="balance"
            stroke={`url(#s${id})`}
            strokeWidth={2.4}
            fill={`url(#f${id})`}
            isAnimationActive={!reducedMotion()}
            // Averages are few: each one gets a visible point
            dot={group === "day" ? false : { r: 3, fill: "var(--glacier)", stroke: "var(--surface)", strokeWidth: 1.5 }}
            activeDot={{ r: 5, fill: "var(--glacier)", stroke: "var(--surface)", strokeWidth: 2 }}
        />
    );
}

function forecastArea() {
    return (
        <Area
            type="stepAfter"
            dataKey="forecast"
            stroke="var(--muted)"
            strokeWidth={1.8}
            strokeDasharray="5 4"
            fill="none"
            isAnimationActive={false}
            activeDot={{ r: 4, fill: "var(--muted)", stroke: "var(--surface)", strokeWidth: 2 }}
        />
    );
}
