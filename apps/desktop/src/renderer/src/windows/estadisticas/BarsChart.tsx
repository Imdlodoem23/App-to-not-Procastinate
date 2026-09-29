/**
 * The one bar chart of Estadísticas (PROMPT §10: «Recharts, un solo color, sin rejilla salvo
 * la línea base»), in its own chunk: the window imports it with `React.lazy`, so Recharts loads
 * only when a chart is drawn («Recharts y MediaPipe se cargan solo cuando hacen falta»).
 *
 * Marks (dataviz rules adapted to the tokens): one series in `--green` («concentrado»), bars at
 * most 24 px with a 4 px rounded end and square on the baseline, 2 px between touching bars, a
 * `--control` hairline baseline and no grid or Y axis; the tallest bar carries its value, in
 * the margin above the plot, where no bar reaches. The hover and keyboard layer (Recharts'
 * accessibility layer: Tab to the chart, ← →) moves an active bar whose day and minutes the
 * window prints on the help line under the chart instead of a popup tooltip (and, for key
 * moves, in a polite region). The focusable root is a `group` with a roledescription, not an
 * `img`: it is interactive. Colors are set in
 * `estadisticas.css` (classes), never here.
 */
import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  Tooltip,
  XAxis,
  YAxis,
  useActiveTooltipLabel,
  useIsTooltipActive,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
} from 'recharts';
import type { ChartBarView } from './view';

export interface BarsChartProps {
  bars: readonly ChartBarView[];
  ticks: readonly string[];
  tickLabels: Readonly<Record<string, string>>;
  maxKey: string | null;
  maxLabel: string | null;
  /** Accessible name of the chart (its caption). */
  title: string;
  /** Space-separated ids that describe the chart (its help line and the text summary). */
  describedBy: string;
  /** What assistive technology calls the focusable chart («gráfico de barras»). */
  roleDescription: string;
  height: number;
  onActiveChange(key: string | null): void;
}

/** The popup tooltip is replaced by the help line: Recharts only tracks the active bar. */
function NoTooltip(): null {
  return null;
}

/**
 * Reports the bar under the pointer or the keyboard to the window. `engaged`: the pointer is
 * over the chart or the focus is in it. Recharts throttles its mouse moves, so a quick exit can
 * leave its active bar set after the pointer has gone; the help line must not keep that day.
 */
function ActiveBar(props: { engaged: boolean; onChange(key: string | null): void }): null {
  const active = useIsTooltipActive();
  const label = useActiveTooltipLabel();
  const key =
    props.engaged && active && label !== undefined && label !== null ? String(label) : null;
  const { onChange } = props;
  useEffect(() => onChange(key), [key, onChange]);
  return null;
}

/** Room a centred value label needs on each side before it hangs inward instead. */
const LABEL_HALF = 36;

/** The tallest bar's value, just above the plot (the tallest bar touches the plot's top). */
function MaxLabel(props: {
  maxKey: string;
  minutes: number;
  text: string;
}): React.JSX.Element | null {
  const x = useXAxisScale();
  const y = useYAxisScale();
  const plot = usePlotArea();
  if (!x || !y || !plot) return null;
  const center = x(props.maxKey, { position: 'middle' });
  const top = y(props.minutes);
  if (center === undefined || top === undefined) return null;
  const left = plot.x;
  const right = plot.x + plot.width;
  let anchor: 'start' | 'middle' | 'end' = 'middle';
  let at = center;
  if (center - LABEL_HALF < left) {
    anchor = 'start';
    at = Math.max(left, x(props.maxKey, { position: 'start' }) ?? left);
  } else if (center + LABEL_HALF > right) {
    anchor = 'end';
    at = Math.min(right, x(props.maxKey, { position: 'end' }) ?? right);
  }
  return (
    <text className="est-bar-label" x={at} y={top - 6} textAnchor={anchor}>
      {props.text}
    </text>
  );
}

interface TickProps {
  x: number | string;
  y: number | string;
  payload: { value?: unknown };
}

const MARGIN = { top: 18, right: 2, bottom: 0, left: 2 };
const RADIUS: [number, number, number, number] = [4, 4, 0, 0];

function minBar(value: number | null | undefined): number {
  return typeof value === 'number' && value > 0 ? 2 : 0;
}

export default function BarsChart(props: BarsChartProps): React.JSX.Element {
  const { bars, maxKey, maxLabel, tickLabels } = props;
  const data = bars.map((b) => ({ key: b.key, minutes: b.minutes }));
  const maxMinutes = bars.find((b) => b.key === maxKey)?.minutes ?? 0;
  const [pointerIn, setPointerIn] = useState(false);
  const [focusIn, setFocusIn] = useState(false);

  // A label that would run past the chart's left edge starts at it («00:00» of a day).
  const renderTick = (tick: TickProps): React.JSX.Element => {
    const x = Number(tick.x);
    const text = tickLabels[String(tick.payload.value ?? '')] ?? '';
    const start = x - text.length * 3.5 < 0;
    return (
      <text
        className="est-tick"
        x={start ? MARGIN.left : x}
        y={Number(tick.y)}
        dy="0.71em"
        textAnchor={start ? 'start' : 'middle'}
      >
        {text}
      </text>
    );
  };

  return (
    <div
      className="est-bars-frame"
      onPointerEnter={() => setPointerIn(true)}
      onPointerLeave={() => setPointerIn(false)}
      onFocus={() => setFocusIn(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusIn(false);
      }}
    >
      <BarChart
        className="est-bars"
        data={data}
        width="100%"
        height={props.height}
        responsive
        margin={MARGIN}
        barCategoryGap={2}
        role="group"
        aria-roledescription={props.roleDescription}
        title={props.title}
        aria-describedby={props.describedBy}
      >
        <XAxis
          dataKey="key"
          ticks={[...props.ticks]}
          interval={0}
          tickLine={false}
          tick={renderTick}
          height={18}
        />
        <YAxis hide domain={[0, (max: number) => Math.max(1, max)]} />
        <Tooltip
          content={NoTooltip}
          cursor={{ className: 'est-cursor' }}
          isAnimationActive={false}
        />
        <Bar
          dataKey="minutes"
          className="est-bar"
          radius={RADIUS}
          maxBarSize={24}
          minPointSize={minBar}
          isAnimationActive={false}
        />
        {maxKey !== null && maxLabel !== null ? (
          <MaxLabel maxKey={maxKey} minutes={maxMinutes} text={maxLabel} />
        ) : null}
        <ActiveBar engaged={pointerIn || focusIn} onChange={props.onActiveChange} />
      </BarChart>
    </div>
  );
}
