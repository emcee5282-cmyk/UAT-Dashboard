'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';

/* =============================================================================
   WaveTrendChart — reusable port of the "liquidity wave" trend chart built
   (and extensively debugged) as vanilla JS/SVG in public/dashboard-demo.html
   (search that file for `function renderChart`). This component ports the
   exact, already-fixed algorithm — do not "clean up" the math, every branch
   below exists because a real bug was found and fixed against it there:

   - Boundary strokes use `getTotalLength()` (after the <path> is in the DOM)
     for their stroke-dasharray/dashoffset draw-in, not a hardcoded guess —
     a fixed guess permanently truncates longer/wigglier 30-point curves.
   - `topActiveIndex` (last series with any nonzero value anywhere in the
     window) anchors the peak label and the "topmost/bold" boundary line,
     not the literal last series — a trailing series that's zero all window
     (e.g. Upay when only Nagad moved volume) sits flat on the baseline and
     must not be mistaken for the real running-total line.
   - A series with zero contribution across the whole window is skipped from
     the cumulative stack (flat on the baseline) rather than either
     inheriting the active layer's height or being hidden outright.
   - Dense mode (>10 points, i.e. the 30D view) adds y-axis gridlines,
     shows a value label only on the peak day (30 per-point labels collide),
     and thins x-axis date labels to every 4th day (suppressing a
     near-duplicate right before the true last day).
   ============================================================================= */

export type WaveTrendDataPoint = { date: string } & Record<string, number>;

export type WaveTrendSeriesDef = {
  key: string; // property name read off each WaveTrendDataPoint
  label: string; // legend / tooltip label
  colorVar: string; // CSS custom property name, e.g. '--pos', '--bkash' — see the
  // `.wtc-panel` scoped token block below for the exact set this component
  // defines and resolves against. A literal CSS color (e.g. '#4f46e5') also
  // works — only a leading '--' is treated as a var() reference.
};

export type WaveTrendChartProps = {
  data: WaveTrendDataPoint[];
  series: WaveTrendSeriesDef[];
  title: string;
  // Base subtitle text (matches the demo's `chartSubBase`, e.g. "Daily
  // CashGo volume") — this component appends ", last N sessions" itself,
  // reading N off whichever dataset (7D `data` or 30D `data30`) is
  // currently active, rather than the caller hardcoding the count.
  subtitle: string;
  // Optional 30-day counterpart. The 7D/30D range toggle only renders when
  // this is provided; omitted entirely otherwise (a line with no 30D
  // counterpart just shows `data` with no toggle UI).
  data30?: WaveTrendDataPoint[];
  // Rows the hover tooltip breaks the day down into — independent of
  // `series` (which draws the visual line/area and the legend swatch).
  // Lets a chart draw a single combined line while the tooltip still lists
  // each underlying wallet's own value. Defaults to `series` when omitted.
  tooltipSeries?: WaveTrendSeriesDef[];
};

function seriesTotal(point: WaveTrendDataPoint, keys: string[]): number {
  return keys.reduce((sum, k) => sum + (point[k] || 0), 0);
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>
): SVGElementTagNameMap[K] {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el as SVGElementTagNameMap[K];
}

type Pt = [number, number];

function linePath(points: Pt[]): string {
  let d = `M ${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i][0].toFixed(1)},${points[i][1].toFixed(1)}`;
  }
  return d;
}

function linePathReversed(points: Pt[]): string {
  const rev = [...points].reverse();
  let d = '';
  for (const [x, y] of rev) d += ` L ${x.toFixed(1)},${y.toFixed(1)}`;
  return d;
}

function colorValue(colorVar: string): string {
  return colorVar.startsWith('--') ? `var(${colorVar})` : colorVar;
}

export default function WaveTrendChart({ data, series, title, subtitle, data30, tooltipSeries }: WaveTrendChartProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const [replayTick, setReplayTick] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);

  const hasRangeToggle = Boolean(data30);
  const activeData = useMemo(
    () => (hasRangeToggle && range === '30d' ? data30! : data),
    [hasRangeToggle, range, data, data30]
  );

  const displaySubtitle = `${subtitle}, last ${activeData.length} session${activeData.length === 1 ? '' : 's'}`;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!activeData || activeData.length === 0) return; // JSX overlay below covers the empty state

    const keys = series.map((s) => s.key);
    const n = activeData.length;
    // 30D mode: 30 permanent value labels collide — drop to peak-only, add
    // y-axis gridlines, and thin x-axis dates (see file-header note).
    const dense = n > 10;
    // Per-point stagger tuned for a 7-point chart (0.05s/point, ~1s total);
    // scaled down for longer windows so the whole cascade still finishes
    // in well under a second regardless of day count.
    const dotDelayStep = Math.min(0.05, 0.6 / n);
    const W = 980;
    const padL = dense ? 34 : 8;
    const padR = 8;
    const padT = 30;
    const padB = 28;
    const plotW = W - padL - padR;
    const plotH = 280 - padT - padB;
    const xStep = n > 1 ? plotW / (n - 1) : 0;
    const xAt = (i: number) => padL + i * xStep;
    // Falls back to 1 (never 0) so an all-zero window renders as a flat
    // baseline instead of a 0/0 = NaN SVG coordinate. 15% headroom keeps
    // peak-day labels from clipping the chart's top edge.
    const rawMax = Math.max(...activeData.map((d) => seriesTotal(d, keys))) || 1;
    const maxV = rawMax * 1.15;
    const yAt = (v: number) => padT + plotH - (v / maxV) * plotH;
    const baselineY = padT + plotH;

    const totals = activeData.map((d) => seriesTotal(d, keys));
    const peakIndex = totals.indexOf(Math.max(...totals));

    // A series with zero contribution across the entire window doesn't join
    // the cumulative stack — its own line sits flat on the baseline instead
    // of inheriting the active layer's height (which would paint the wrong
    // series' color on top) or being hidden entirely.
    const layerHasData = keys.map((k) => activeData.some((d) => (d[k] || 0) !== 0));
    let topActiveIndex = layerHasData.lastIndexOf(true);
    if (topActiveIndex === -1) topActiveIndex = keys.length - 1;

    const cum: number[][] = activeData.map((d) => {
      let running = 0;
      return keys.map((k, j) => {
        if (!layerHasData[j]) return 0;
        running += d[k] || 0;
        return running;
      });
    });
    const layerPts: Pt[][] = keys.map((_, j) => activeData.map((d, i): Pt => [xAt(i), yAt(cum[i][j])]));

    const colorOf = (j: number) => colorValue(series[j].colorVar);

    const defs = svgEl('defs', {});
    keys.forEach((_, j) => {
      const grad = svgEl('linearGradient', { id: `wtcGrad${rawId}${j}`, x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': colorOf(j), 'stop-opacity': 0.5 }));
      grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': colorOf(j), 'stop-opacity': 0.06 }));
      defs.appendChild(grad);
    });
    svg.appendChild(defs);

    svg.appendChild(
      svgEl('line', { x1: padL, y1: baselineY, x2: padL + plotW, y2: baselineY, stroke: 'var(--border)', 'stroke-dasharray': '2,4' })
    );

    // Y-axis gridlines — dense mode only. Sparse (7D) mode already labels
    // every point directly above it, so a separate axis would be redundant.
    if (dense) {
      const niceStep = (max: number, targetTicks: number) => {
        const raw = max / targetTicks;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const norm = raw / mag;
        const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
        return step * mag;
      };
      const yStepVal = niceStep(rawMax, 6) || 1;
      for (let v = 0; v <= maxV; v += yStepVal) {
        const y = yAt(v);
        svg.appendChild(svgEl('line', { x1: padL, y1: y, x2: padL + plotW, y2: y, stroke: 'var(--wtc-hair-soft)', 'stroke-width': 1 }));
        const yl = svgEl('text', { x: padL - 8, y: y + 3, 'text-anchor': 'end' });
        yl.setAttribute('font-size', '10');
        yl.setAttribute('fill', 'var(--wtc-text-low)');
        yl.textContent = v === 0 ? '0' : v.toFixed(v < 1 ? 2 : 0) + 'M';
        svg.appendChild(yl);
      }
    }

    // Areas: bottom layer fills to the baseline, every layer above fills to
    // the layer below's own boundary curve. Skipped for a no-data layer —
    // it's already flat on the baseline (nothing to fill).
    keys.forEach((_, j) => {
      if (!layerHasData[j]) return;
      const top = layerPts[j];
      const areaPath =
        j === 0
          ? linePath(top) + ` L ${top[n - 1][0].toFixed(1)},${baselineY} L ${top[0][0].toFixed(1)},${baselineY} Z`
          : linePath(top) + linePathReversed(layerPts[j - 1]) + ' Z';
      const area = svgEl('path', { d: areaPath, fill: `url(#wtcGrad${rawId}${j})` });
      area.style.opacity = '0';
      area.style.animation = `wtcWvFadeIn 1s ease-out ${0.1 + j * 0.1}s forwards`;
      svg.appendChild(area);
    });

    // Boundary strokes: every layer's own line is always drawn (a no-data
    // series just sits flat on the baseline), with the topmost ACTIVE layer
    // — the real running total — drawn bolder than the rest.
    keys.forEach((_, j) => {
      const isTop = j === topActiveIndex;
      const stroke = svgEl('path', {
        d: linePath(layerPts[j]),
        fill: 'none',
        stroke: colorOf(j),
        'stroke-width': isTop ? 2.5 : 1.6,
        'stroke-linecap': 'round',
      });
      svg.appendChild(stroke);
      // getTotalLength() after the path is in the DOM gives the real path
      // length every time (7-point or 30-point alike) — a fixed guess here
      // permanently truncates longer/wigglier curves.
      const len = stroke.getTotalLength();
      stroke.style.strokeDasharray = String(len);
      stroke.style.strokeDashoffset = String(len);
      stroke.style.animation = `wtcWvDrawLine 1.3s cubic-bezier(.4,0,.2,1) ${0.1 + j * 0.1}s forwards`;
    });

    // Shared hover tooltip — one crosshair + dot + box that moves to
    // whichever day is hovered, instead of a separate DOM subtree per day.
    // Breaks the day down by `tooltipSeries` (falls back to `series`) rather
    // than the drawn line's own `series` — lets the chart draw a single
    // combined line while the tooltip still lists each wallet's own value.
    const breakdown = tooltipSeries ?? series;
    const breakdownKeys = breakdown.map((s) => s.key);
    const ttRowH = 15;
    const ttH = 20 + breakdownKeys.length * ttRowH;
    const ttW = 126;
    const tooltipG = svgEl('g', {});
    tooltipG.style.opacity = '0';
    tooltipG.style.transition = 'opacity .12s';
    tooltipG.style.pointerEvents = 'none';
    const crosshair = svgEl('line', { y1: padT, y2: baselineY, stroke: 'var(--border)', 'stroke-dasharray': '2,3' });
    const hoverDot = svgEl('circle', { r: 5, fill: 'var(--wave-peak)', stroke: 'var(--wtc-panel-bg)', 'stroke-width': 2 });
    const ttBg = svgEl('rect', { width: ttW, height: ttH, rx: 8, fill: 'var(--wtc-panel-bg)', stroke: 'var(--border)' });
    const ttDate = svgEl('text', {});
    ttDate.setAttribute('font-size', '9.5');
    ttDate.setAttribute('fill', 'var(--wtc-text-low)');
    // Black, not per-wallet colored — the line itself is a single combined
    // Total now, so tying each row's text to its wallet's old line color no
    // longer matches what's on the chart. Bumped a size up from the date
    // row's 9.5 for legibility (these are the tooltip's primary numbers).
    const ttRows = breakdown.map(() => {
      const row = svgEl('text', { fill: 'var(--foreground)' });
      row.setAttribute('font-size', '11');
      row.setAttribute('font-weight', '600');
      return row;
    });
    tooltipG.appendChild(crosshair);
    tooltipG.appendChild(ttBg);
    tooltipG.appendChild(ttDate);
    ttRows.forEach((row) => tooltipG.appendChild(row));
    tooltipG.appendChild(hoverDot);
    // Appended to the SVG only after every point's dots/rings/labels below
    // are added (not here) — SVG stacks later DOM siblings on top, so the
    // tooltip must be the LAST thing appended or the peak's own ring/dot
    // would render over it instead of the other way around.

    // Dots on every layer boundary, plus a pulsing gold ring + value label
    // on the peak day's topmost (total) point.
    // Hoisted above the loop (not per-iteration) so every column's hover
    // handler below can reach the one peak label and fade it out of the
    // tooltip's way — the tooltip box is pinned to the plot's top edge
    // (see boxY below), same band the peak label lives in, so in dense
    // (30D) mode — where it's the chart's only permanent label — it would
    // otherwise sit right under/behind the tooltip while hovering.
    let peakLabelEl: SVGTextElement | null = null;
    activeData.forEach((d, i) => {
      keys.forEach((_, j) => {
        const isTop = j === topActiveIndex;
        const isPeak = isTop && i === peakIndex;
        if (isPeak) {
          const ring = svgEl('circle', {
            cx: layerPts[j][i][0],
            cy: layerPts[j][i][1],
            r: 5,
            fill: 'none',
            stroke: 'var(--wave-peak)',
            'stroke-width': 2,
          });
          ring.style.animation = 'wtcWvRingPulse 2s ease-out infinite';
          svg.appendChild(ring);
        }
        // Dense (30D): every point's dot on every series is too much noise
        // at 30 days — same thinning the value labels below already get,
        // dropped to just the peak's own dot (which keeps its ring too).
        if (!dense || isPeak) {
          const dot = svgEl('circle', {
            cx: layerPts[j][i][0],
            cy: layerPts[j][i][1],
            r: isPeak ? 5 : isTop ? 3.5 : 3,
            fill: isPeak ? 'var(--wave-peak)' : colorOf(j),
            stroke: 'var(--wtc-panel-bg)',
            'stroke-width': 1.5,
          });
          dot.style.opacity = '0';
          dot.style.animation = `wtcWvFadeDot .3s ease-out ${0.75 + i * dotDelayStep}s forwards`;
          svg.appendChild(dot);
        }
      });

      // topActiveIndex, not the literal last key — an inactive trailing
      // series sits flat at the baseline, so anchoring on it would put the
      // value label there instead of at the real running-total peak.
      const topPt = layerPts[topActiveIndex][i];
      const isPeak = i === peakIndex;
      // Sparse (7D): every point gets a permanent label (7 never collide).
      // Dense (30D): only the peak day keeps one; the rest are reachable
      // via the hover tooltip instead of crowding the chart.
      if (!dense || isPeak) {
        const label = svgEl('text', { x: topPt[0], y: topPt[1] - 14, 'text-anchor': 'middle' });
        label.setAttribute('font-size', '11');
        label.setAttribute('font-weight', '600');
        label.setAttribute('fill', isPeak ? 'var(--wave-peak)' : 'var(--wtc-text-mid)');
        label.style.opacity = '0';
        label.style.animation = `wtcWvFadeUp .4s ease-out ${0.95 + i * dotDelayStep}s forwards`;
        label.textContent = totals[i].toFixed(1) + 'M';
        svg.appendChild(label);
        if (isPeak) peakLabelEl = label;
      }

      if (dense) {
        svg.appendChild(svgEl('line', { x1: xAt(i), y1: baselineY, x2: xAt(i), y2: baselineY + 3, stroke: 'var(--border)' }));
      }
      // Dense mode thins date text to every 4th day (plus the last); the
      // last 4th-multiple can land 1-3 days before the true last index,
      // close enough to visually collide — suppressed in that case.
      if (!dense || i === n - 1 || (i % 4 === 0 && n - 1 - i > 2)) {
        const dl = svgEl('text', { x: xAt(i), y: baselineY + 20, 'text-anchor': 'middle' });
        dl.setAttribute('font-size', '10');
        dl.setAttribute('fill', 'var(--wtc-text-low)');
        dl.textContent = d.date;
        svg.appendChild(dl);
      }

      // Hovering this day's column moves the shared crosshair/dot/box here
      // and fills in this day's own breakdown.
      const hoverRect = svgEl('rect', { x: xAt(i) - xStep / 2, y: padT, width: xStep || plotW, height: plotH, fill: 'transparent' });
      hoverRect.style.cursor = 'pointer';
      hoverRect.addEventListener('mouseenter', () => {
        tooltipG.style.opacity = '1';
        // Only when hovering the peak day itself — that's the one case the
        // tooltip box actually lands on the peak's own label (sparse mode
        // keeps a label on every point, dense mode only the peak's, but
        // either way only ITS OWN day's hover collides with it). The
        // label's own fade-in keyframe animation holds opacity:1 via
        // `forwards`, which outranks inline style in the cascade — clear
        // the animation first so the opacity toggle below actually takes
        // visual effect.
        if (i === peakIndex && peakLabelEl) {
          peakLabelEl.style.animation = 'none';
          peakLabelEl.style.opacity = '0';
        }
        crosshair.setAttribute('x1', String(topPt[0]));
        crosshair.setAttribute('x2', String(topPt[0]));
        hoverDot.setAttribute('cx', String(topPt[0]));
        hoverDot.setAttribute('cy', String(topPt[1]));
        const boxX = Math.min(Math.max(topPt[0] - ttW / 2, padL), padL + plotW - ttW);
        // Pinned to the plot's top edge normally, but a high-value day's own
        // point (hoverDot, r=5) can sit close enough to that fixed band to
        // render inside the box instead of above it — drop the box below
        // the point instead whenever it would collide, rather than always
        // trusting there's clearance above.
        const topBoxY = padT - 4;
        const boxY = topPt[1] < topBoxY + ttH + 5 ? topPt[1] + 12 : topBoxY;
        ttBg.setAttribute('x', String(boxX));
        ttBg.setAttribute('y', String(boxY));
        ttDate.setAttribute('x', String(boxX + 10));
        ttDate.setAttribute('y', String(boxY + 14));
        ttDate.textContent = d.date;
        breakdown.forEach((s, j) => {
          ttRows[j].setAttribute('x', String(boxX + 10));
          ttRows[j].setAttribute('y', String(boxY + 14 + (j + 1) * ttRowH));
          ttRows[j].textContent = `${s.label} ${(d[s.key] || 0).toFixed(2)}M`;
        });
      });
      hoverRect.addEventListener('mouseleave', () => {
        tooltipG.style.opacity = '0';
        if (peakLabelEl) peakLabelEl.style.opacity = '1';
      });
      svg.appendChild(hoverRect);
    });

    // Last append wins the stacking order — tooltip now renders above every
    // point's dots/rings/labels instead of the peak ring/dot poking through
    // the tooltip box when they visually coincide (see note above).
    svg.appendChild(tooltipG);

    return () => {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    };
  }, [activeData, series, tooltipSeries, rawId, replayTick]);

  return (
    <section className="wtc-panel overflow-hidden rounded-lg border border-[#DEE1E8] bg-white px-[22px] py-5 dark:border-[#262B38] dark:bg-[#12151D]">
      {/* Scoped tokens + keyframes — see the color-token decision note at the
          bottom of this file. `--wave-peak` is intentionally NOT redefined
          under .dark: it stays the same violet in both themes so the peak
          marker never blends into the line's own blue (both trend charts
          now draw a single always-blue Total line — see --bkash below). */}
      <style>{`
        .wtc-panel {
          --pos: #16A34A;
          --neg: #E23D3D;
          --wave-peak: #7C5CE0;
          --bkash: #2F6FED;
          --nagad: #7C5CE0;
          --upay: #5C7A94;
          --wtc-hair-soft: #EEF0F3;
          --wtc-text-mid: #6B7280;
          --wtc-text-low: #9CA3AF;
          --wtc-panel-bg: #ffffff;
        }
        .dark .wtc-panel {
          --pos: #34D399;
          --neg: #F4665A;
          --bkash: #5B8DEF;
          --nagad: #8B7FE8;
          --upay: #7C93A8;
          --wtc-hair-soft: #1D212B;
          --wtc-text-mid: #9198AC;
          --wtc-text-low: #565C70;
          --wtc-panel-bg: #12151D;
        }
        @keyframes wtcWvFadeIn { to { opacity: 1; } }
        @keyframes wtcWvDrawLine { to { stroke-dashoffset: 0; } }
        @keyframes wtcWvFadeDot { to { opacity: 1; } }
        @keyframes wtcWvRingPulse { 0% { r: 5; opacity: .7; } 100% { r: 15; opacity: 0; } }
        @keyframes wtcWvFadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-[11px] text-[color:var(--wtc-text-low)]">{displaySubtitle}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            title="Replay animation"
            onClick={() => setReplayTick((t) => t + 1)}
            className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-[7px] border border-[#DEE1E8] bg-[#F1F2F5] text-[#6B7280] hover:border-[color:var(--ui-accent)] hover:text-[color:var(--ui-accent)] dark:border-[#262B38] dark:bg-[#1A1E29] dark:text-[#9198AC]"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M13.5 2.3V6h-3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {hasRangeToggle && (
            <div className="flex items-center gap-0.5 rounded-[7px] border border-[#DEE1E8] p-0.5 dark:border-[#262B38]">
              <button
                type="button"
                onClick={() => setRange('7d')}
                className={`whitespace-nowrap rounded-md px-3 py-1 text-[11.5px] font-semibold ${
                  range === '7d' ? 'bg-[color:var(--ui-accent)] text-white' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                7D
              </button>
              <button
                type="button"
                onClick={() => setRange('30d')}
                className={`whitespace-nowrap rounded-md px-3 py-1 text-[11.5px] font-semibold ${
                  range === '30d' ? 'bg-[color:var(--ui-accent)] text-white' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                30D
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--wtc-text-mid)]">
            <i className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: colorValue(s.colorVar) }} />
            {s.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--wtc-text-mid)]">
          <i className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: 'var(--wave-peak)' }} />
          Peak day
        </span>
      </div>

      <div className="relative mt-[22px] h-[230px]">
        {activeData.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center text-center text-[12px] italic text-[color:var(--wtc-text-low)]">
            Coming Soon &mdash; volume data for this line has not been published yet
          </div>
        ) : (
          <svg ref={svgRef} className="block h-full w-full overflow-visible" viewBox="0 0 980 280" preserveAspectRatio="none" />
        )}
      </div>
    </section>
  );
}

/* -----------------------------------------------------------------------
   Color-token decision (per task instructions — documenting the choice):

   Hybrid of the two options offered, matching this codebase's existing
   convention of scoping product/theme-dependent CSS custom properties on a
   wrapper element (see app/globals.css's `[data-product="cashout"]` /
   `.dark [data-product="cashout"]` pattern):

   - Reused directly, no new token: `var(--border)` for hairlines/gridline
     baseline (demo's `--hair`), `var(--foreground)` for high-emphasis text
     (demo's `--text-hi` — used via Tailwind `text-foreground` on the title),
     `var(--muted-foreground)` for mid-emphasis text (demo's `--text-mid`),
     and `var(--ui-accent)` for the demo's `--brass` role (active
     toggle background, replay-button hover).
     UPDATED per later explicit instruction: this originally reused
     `--product-accent` (Cashout indigo / Send Money teal) reasoning it was
     the closest existing equivalent to the demo's per-theme `--brass`. That
     product-scoped choice was later explicitly overridden app-wide — no UI
     chrome should carry Send Money's teal branding, only the sidebar/
     product-switch elements that exist specifically to signal which
     product you're on. Switched to `--ui-accent` (indigo light / gold dark,
     identical on both products) to match.
   - New, scoped to `.wtc-panel` (not global `:root`, so this component
     can't collide with anything the rest of the app defines later): `--pos`
     /`--neg`/`--wave-peak`/`--bkash`/`--nagad`/`--upay` — genuinely new
     series/semantic colors with no existing project equivalent, kept at
     the demo's own exact hex pairs (also handles `--wave-peak` staying
     theme-invariant, the deliberate fix described in the demo's own
     comments). `--wtc-hair-soft`/`--wtc-text-low`/`--wtc-panel-bg` are also
     new (this project has no "softer than border" gridline tint, no third
     text-emphasis tier, and no themed panel-background var it exposes as a
     CSS custom property) — prefixed `wtc-` since, unlike `--pos`/`--bkash`/
     etc., there's no reason a future page would need to reference these by
     name directly as a `colorVar` prop value.
   ----------------------------------------------------------------------- */
