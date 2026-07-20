'use client';

// Shadcn-styled recreation of the CashGo Trend bar chart — Card, Button,
// and the shadcn Chart primitives (ChartContainer/ChartTooltip/ChartLegend)
// instead of the hand-rolled markup in app/components/TrendChart.tsx. Same
// data shape (TrendPoint/TrendSeriesDef), still a stacked bar chart, just
// restyled. Scratch/demo only — does not import from or modify
// app/components/TrendChart.tsx, app/page.tsx, or app/balance-overview/page.tsx.

import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/ui/chart';
import type { TrendPoint, TrendSeriesDef } from '../components/TrendChart';

type Props = {
  title: string;
  seriesDefs: TrendSeriesDef[];
  weekData: TrendPoint[];
  monthData: TrendPoint[];
};

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

export default function CashGoTrendShadcn({ title, seriesDefs, weekData, monthData }: Props) {
  const [period, setPeriod] = useState<'week' | 'month'>('week');

  // One base color (chart-1) for every series, ramped lighter per index via
  // color-mix — an actual distinct paint color per series rather than a
  // fillOpacity trick, so the tooltip's indicator swatch (which reads each
  // series' own color, not its opacity) shows the same ramp as the bars.
  const chartConfig = useMemo<ChartConfig>(
    () =>
      Object.fromEntries(
        seriesDefs.map((def, i) => [
          def.key,
          { label: def.label, color: i === 0 ? 'var(--chart-1)' : 'color-mix(in oklab, var(--chart-1) 45%, transparent)' },
        ])
      ),
    [seriesDefs]
  );

  // Flatten each point's `series` map onto the row itself — recharts' <Bar
  // dataKey> needs a plain top-level key, not a nested path lookup.
  const flatten = (points: TrendPoint[]) =>
    points.map((p) => ({ day: p.day, tooltipLabel: p.tooltipLabel, total: p.total, ...p.series }));

  const weekRows = useMemo(() => flatten(weekData), [weekData]);
  const monthRows = useMemo(() => flatten(monthData), [monthData]);
  const chartData = period === 'week' ? weekRows : monthRows;

  const yMax = Math.max(1, ...monthData.map((p) => p.total));
  const yTicks = [0, Math.round(yMax / 2), yMax];
  const thirtyDayAvg = monthData.length ? monthData.reduce((sum, p) => sum + p.total, 0) / monthData.length : 0;

  return (
    <Card className="gap-0 overflow-hidden rounded-2xl border py-0 shadow-sm">
      <CardHeader className="flex-row items-center justify-between border-b !py-3">
        <CardTitle className="text-[13px] font-semibold">{title}</CardTitle>
        <div className="flex items-center gap-1">
          <Button size="xs" variant={period === 'week' ? 'default' : 'outline'} onClick={() => setPeriod('week')}>
            7D
          </Button>
          <Button size="xs" variant={period === 'month' ? 'default' : 'outline'} onClick={() => setPeriod('month')}>
            30D
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        <ChartContainer config={chartConfig} className="aspect-auto h-[280px] w-full">
          <BarChart data={chartData} margin={{ top: 20, right: 0, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              fontSize={10}
              interval={period === 'month' ? 'preserveStartEnd' : 0}
            />
            {period === 'month' && (
              <YAxis
                domain={[0, yMax]}
                ticks={yTicks}
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                fontSize={10}
                width={40}
                tickFormatter={(value: number) => fmtAmount(value)}
              />
            )}
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value, payload) => payload?.[0]?.payload?.tooltipLabel ?? value}
                />
              }
            />
            {period === 'month' && thirtyDayAvg > 0 && (
              <ReferenceLine y={thirtyDayAvg} stroke="var(--muted-foreground)" strokeDasharray="4 4" strokeWidth={1} />
            )}
            {seriesDefs.map((def, i) => (
              <Bar
                key={def.key}
                dataKey={def.key}
                stackId="cashgo"
                fill={`var(--color-${def.key})`}
                radius={i === seriesDefs.length - 1 ? [4, 4, 0, 0] : undefined}
                maxBarSize={40}
              />
            ))}
            <ChartLegend content={<ChartLegendContent />} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
