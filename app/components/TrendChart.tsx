'use client';

import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export type TrendSeriesDef = { key: string; label: string };

export type TrendPoint = {
  day: string; // 'MM/DD' — x-axis label
  tooltipLabel: string; // 'Jun 21' — tooltip header
  total: number;
  series: Record<string, number>; // keyed by TrendSeriesDef.key
};

type TrendChartProps = {
  title: string;
  seriesDefs: TrendSeriesDef[]; // stacking order = ramp order, index 0 = fullest opacity
  weekData: TrendPoint[]; // 7 points: 7 full days of history (today excluded — partial/in-progress)
  monthData: TrendPoint[]; // 30 points: 30 full days of history
};

type PlotPoint = TrendPoint & { visibleTotal: number };

// Every bar uses the single product accent, differentiated only by an
// opacity ramp — no per-series hue, no hardcoded hex, so the exact same
// component reads as indigo on Cashout and teal on Send Money purely from
// the page's own data-product CSS context.
const RAMP_OPACITY = [1, 0.6, 0.35];

function fmtAmount(num: number): string {
  const abs = Math.abs(num);
  let value = abs;
  let suffix = '';
  if (abs >= 1e9) {
    value = abs / 1e9;
    suffix = 'B';
  } else if (abs >= 1e6) {
    value = abs / 1e6;
    suffix = 'M';
  } else if (abs >= 1e3) {
    value = abs / 1e3;
    suffix = 'K';
  }
  const rounded = Math.round(value * 10) / 10;
  const str = rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${str}${suffix}`;
}

function TrendXAxisTick({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) {
  return (
    <text x={x} y={(y ?? 0) + 12} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--muted-foreground)">
      {payload?.value}
    </text>
  );
}

function TrendTooltip({ active, payload, seriesDefs }: { active?: boolean; payload?: Array<{ payload: PlotPoint }>; seriesDefs: TrendSeriesDef[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-lg border border-[#e5e5e7] bg-white px-3 py-2 text-[11px] shadow-md dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
      <p className="mb-1.5 font-bold text-slate-900 dark:text-white">{point.tooltipLabel} · {fmtAmount(point.visibleTotal)}</p>
      {seriesDefs.map((def) => {
        const value = point.series[def.key] ?? 0;
        return (
          <p key={def.key} className="text-slate-600 dark:text-slate-300">
            {def.label} {value > 0 ? fmtAmount(value) : '—'}
          </p>
        );
      })}
    </div>
  );
}

export default function TrendChart({ title, seriesDefs, weekData, monthData }: TrendChartProps) {
  const [period, setPeriod] = useState<'week' | 'month'>('week');
  const [visibleSeries, setVisibleSeries] = useState<Record<string, boolean>>(
    () => Object.fromEntries(seriesDefs.map((s) => [s.key, true]))
  );

  const toggleSeries = (key: string) => setVisibleSeries((prev) => ({ ...prev, [key]: !prev[key] }));

  // Toggling a chip is a real filter, not just a visual hide — stack height,
  // peak detection, the average line, labels, and tooltip totals all recompute
  // from a per-point visibleTotal (sum of only currently-toggled-on series).
  // Zeroing a hidden series' own value here (rather than removing its <Bar>
  // from the tree) keeps every Bar permanently mounted across toggles — see
  // the dataKey note below for why that matters.
  const attachVisibleTotal = (points: TrendPoint[]): PlotPoint[] =>
    points.map((p) => {
      const series = Object.fromEntries(
        seriesDefs.map((def) => [def.key, visibleSeries[def.key] ? (p.series[def.key] ?? 0) : 0])
      );
      const visibleTotal = seriesDefs.reduce((sum, def) => sum + series[def.key], 0);
      return { ...p, series, visibleTotal };
    });

  const weekPoints = useMemo(() => attachVisibleTotal(weekData), [weekData, visibleSeries, seriesDefs]);
  const monthPoints = useMemo(() => attachVisibleTotal(monthData), [monthData, visibleSeries, seriesDefs]);
  const chartData = period === 'week' ? weekPoints : monthPoints;

  const thirtyDayAvg = monthPoints.length
    ? monthPoints.reduce((sum, p) => sum + p.visibleTotal, 0) / monthPoints.length
    : 0;

  const peakDay = chartData.length
    ? chartData.reduce((peak, point) => (point.visibleTotal > peak.visibleTotal ? point : peak), chartData[0]).day
    : null;

  const shouldLabel = (point: PlotPoint) => period === 'week' || point.day === peakDay;

  const yMax = Math.max(1, ...monthPoints.map((p) => p.visibleTotal));
  const yTicks = [0, Math.round(yMax / 2), yMax];

  // Recharts never calls a stacked Bar's LabelList content fn for a day where
  // that series' own value is 0 that day, and worse, silently renumbers the
  // `index` prop to only count that series' own non-zero entries once this
  // happens (this recharts version's LabelList props don't include `payload`
  // as a fallback either). Fixed by matching the label's own `value` back
  // against the chart data by number instead of trusting `index`, and having
  // every stacked Bar's content fn independently decide whether IT is the
  // topmost non-zero (and currently visible) segment for that day before
  // rendering — guaranteeing the label always lands on a segment that
  // actually has a rect to attach to.
  const makeValueLabelRenderer = (seriesKey: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (props: any) => {
      const { x, y, width, value } = props;
      const numValue = Number(value ?? 0);
      const point = chartData.find((p) => Math.abs(p.visibleTotal - numValue) < 0.01);
      if (!point || !shouldLabel(point)) return null;

      // Recharts stacks the LAST-declared series (seriesDefs[seriesDefs.
      // length - 1]) on top of the stack, and the first-declared as the
      // base touching the axis — confirmed against real tooltip data
      // (a day where the first series' value was 7x the second's still
      // rendered the first series as the larger BASE segment, not on top).
      // So the topmost non-zero segment for a given day is the last
      // (highest-index) visible series with data that day.
      let hostKey: string | null = null;
      for (let i = seriesDefs.length - 1; i >= 0; i -= 1) {
        const def = seriesDefs[i];
        if (visibleSeries[def.key] && (point.series[def.key] ?? 0) > 0) {
          hostKey = def.key;
          break;
        }
      }
      if (hostKey !== seriesKey) return null;

      const numX = Number(x ?? 0);
      const numY = Number(y ?? 0);
      const numWidth = Number(width ?? 0);
      return (
        <text x={numX + numWidth / 2} y={numY - 6} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--foreground)">
          {fmtAmount(point.visibleTotal)}
        </text>
      );
    };

  // The last-declared series renders as the topmost stack segment (see
  // hostKey note above), so the rounded top corners belong on the last
  // VISIBLE series, not the first.
  const visibleDefs = seriesDefs.filter((def) => visibleSeries[def.key]);
  const topmostVisibleKey = visibleDefs.length ? visibleDefs[visibleDefs.length - 1].key : null;

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="whitespace-nowrap text-[13px] font-semibold text-foreground">{title}</h2>
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            <button
              onClick={() => setPeriod('week')}
              className={`whitespace-nowrap rounded-md px-3 py-1 text-[10px] font-medium ${
                period === 'week' ? 'bg-[color:var(--product-accent)] text-white' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              7D
            </button>
            <button
              onClick={() => setPeriod('month')}
              className={`whitespace-nowrap rounded-md px-3 py-1 text-[10px] font-medium ${
                period === 'month' ? 'bg-[color:var(--product-accent)] text-white' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              30D
            </button>
          </div>
        </div>
        {/* Wallet-type legend row: plain dot + label, no button chrome —
            still clickable as a real filter. Filled dot = currently added to
            the chart; hollow ring = tap to add it back. */}
        <div className="mt-2 flex flex-wrap items-center gap-4">
          {seriesDefs.map((def, i) => {
            const isOn = visibleSeries[def.key];
            const rampOpacity = RAMP_OPACITY[i] ?? RAMP_OPACITY[RAMP_OPACITY.length - 1];
            return (
              <button
                key={def.key}
                onClick={() => toggleSeries(def.key)}
                className={`flex items-center gap-1.5 text-[11px] font-medium ${
                  isOn ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={
                    isOn
                      ? { background: 'var(--product-accent)', opacity: rampOpacity }
                      : { background: 'transparent', border: '1.5px solid var(--muted-foreground)' }
                  }
                />
                {def.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Chart — 7D: no Y-axis, every bar labeled. 30D: minimal 3-tick Y-axis,
          only the peak day labeled, dashed 30-day average line. */}
      <div className="h-[280px] select-none px-3 py-4 pt-6">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 20, right: 45, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="4 4" />
            <XAxis dataKey="day" tick={<TrendXAxisTick />} axisLine={{ stroke: 'var(--border)' }} tickLine={false} interval={period === 'month' ? 'preserveStartEnd' : 0} />
            {period === 'month' && (
              <YAxis
                domain={[0, yMax]}
                ticks={yTicks}
                tick={{ fontSize: 10, fontWeight: 600, fill: 'var(--muted-foreground)' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(value: number) => fmtAmount(value)}
                width={46}
                tickMargin={6}
              />
            )}
            <Tooltip content={<TrendTooltip seriesDefs={seriesDefs} />} cursor={{ fill: 'var(--muted)', opacity: 0.4 }} />
            {period === 'month' && thirtyDayAvg > 0 && (
              <ReferenceLine y={thirtyDayAvg} stroke="var(--muted-foreground)" strokeDasharray="4 4" strokeWidth={1} />
            )}
            {seriesDefs.map((def, i) => {
              const isTopmost = def.key === topmostVisibleKey;
              const rampOpacity = RAMP_OPACITY[i] ?? RAMP_OPACITY[RAMP_OPACITY.length - 1];
              // Every series' <Bar> stays mounted at all times with a
              // stable string dataKey. Toggling a chip zeroes that series'
              // value in the data itself (see attachVisibleTotal above)
              // instead of unmounting the <Bar> — unmounting/remounting on
              // toggle was the root cause of a real bug: recharts registers
              // each stacked Bar's stack position by mount order, so
              // re-adding a previously-removed Bar re-registered it at the
              // END of the stack, reversing the visual arrangement after an
              // untick/tick cycle.
              return (
                <Bar key={def.key} dataKey={`series.${def.key}`} stackId="trend" fill="var(--product-accent)" maxBarSize={40} radius={isTopmost ? [3, 3, 0, 0] : undefined}>
                  {chartData.map((point, idx) => (
                    <Cell key={idx} fillOpacity={rampOpacity} />
                  ))}
                  <LabelList dataKey="visibleTotal" content={makeValueLabelRenderer(def.key)} />
                </Bar>
              );
            })}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
