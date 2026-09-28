/**
 * The GitHub-style heatmap (PROMPT §9, §10 «mapa de calor tipo GitHub en verde»): one 8 px cell
 * per day with a 2 px gap, weeks as columns (Monday on top), five steps of one green: none, then
 * `color-mix` of `--green` into the background at 50, 67, 84 and 100 % (validated as an ordinal
 * ramp in both themes: monotone lightness, the lightest step ≥ 2:1 on `--bg`).
 *
 * No popup tooltip (PROMPT §10 «Nada de tooltips emergentes»): the cell under the pointer gets an
 * outline and its day and minutes replace the summary on the help line below. The cells are not
 * focusable one by one (they would be 8 px targets); the graphic is one image whose name is the
 * summary, the text a screen reader reads beside it.
 */
import { useMemo, useRef, type PointerEvent } from 'react';
import { HelpLine } from '../../components';
import type { HeatCellView, HeatmapView } from './view';

const CELL = 8;
const GAP = 2;
const PITCH = CELL + GAP;
/** Room for the weekday labels («L», «Mon») and the month labels above. */
const LEFT = 32;
const TOP = 16;

export function Heatmap(props: {
  id: string;
  helpId: string;
  view: HeatmapView;
  active: HeatCellView | null;
  onActive(cell: HeatCellView | null): void;
}): React.JSX.Element {
  const { view, active, onActive } = props;
  const width = LEFT + view.weeks * PITCH - GAP;
  const height = TOP + 7 * PITCH - GAP;
  const svg = useRef<SVGSVGElement>(null);
  const byPlace = useMemo(
    () => new Map(view.cells.map((c) => [`${c.col}:${c.row}`, c] as const)),
    [view.cells],
  );

  const onPointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    const x = ((event.clientX - box.left) * width) / box.width - LEFT;
    const y = ((event.clientY - box.top) * height) / box.height - TOP;
    // The hit area of a cell includes its gap.
    const cell =
      x < 0 || y < 0 ? null : byPlace.get(`${Math.floor(x / PITCH)}:${Math.floor(y / PITCH)}`);
    if ((cell ?? null) !== active) onActive(cell ?? null);
  };

  return (
    <figure className="est-heat">
      <svg
        ref={svg}
        id={props.id}
        className="est-heat-svg"
        role="img"
        aria-label={view.summary}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => onActive(null)}
      >
        {view.months.map((m) => (
          <text key={`m${m.col}`} className="est-heat-label" x={LEFT + m.col * PITCH} y={11}>
            {m.label}
          </text>
        ))}
        {view.weekdays.map((w) => (
          <text
            key={`w${w.row}`}
            className="est-heat-label"
            x={LEFT - 4}
            y={TOP + w.row * PITCH + CELL}
            textAnchor="end"
          >
            {w.label}
          </text>
        ))}
        {view.cells.map((c) => (
          <rect
            key={c.day}
            className="est-heat-cell"
            data-level={c.level}
            x={LEFT + c.col * PITCH}
            y={TOP + c.row * PITCH}
            width={CELL}
            height={CELL}
            rx={2}
          />
        ))}
        {active ? (
          <rect
            className="est-heat-hover"
            x={LEFT + active.col * PITCH - 1}
            y={TOP + active.row * PITCH - 1}
            width={CELL + 2}
            height={CELL + 2}
            rx={3}
          />
        ) : null}
      </svg>
      <div className="est-heat-foot">
        <HelpLine id={props.helpId}>{active ? active.readout : view.summary}</HelpLine>
        <span className="est-legend" aria-hidden="true">
          <span>{view.less}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className="est-legend-cell" data-level={level} />
          ))}
          <span>{view.more}</span>
        </span>
      </div>
    </figure>
  );
}
