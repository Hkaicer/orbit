// Small chart kit for the Performance dashboards: stat tiles, columns over
// time, ranked bars and a part-to-whole bar. Thin marks, hairline grid, one
// tooltip per column, a legend for two series or more, and a table twin for
// every chart (the values are never reachable by hovering only).

import { ArrowDownRight, ArrowUpRight, ChartColumn, ChevronRight, Table2 } from "lucide-react";
import { useState, type ReactNode } from "react";

export interface Series {
  key: string;
  label: string;
  /** A CSS color, normally one of the --series-N slots. */
  color: string;
}

/** A round top for the y axis: 1, 2, 2.5 or 5 times a power of ten. */
export function niceTop(max: number): number {
  if (max <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= max) return m * mag;
  return 10 * mag;
}

/** 1,284 / 12.9K / 4.2M */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${+(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${+(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
  return Math.round(n).toLocaleString();
}

export function StatTile({
  label,
  value,
  hint,
  delta,
  deltaTitle,
  goodWhenUp = true,
  meter,
  onClick,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** Change since the previous period, already formatted with its sign; null hides it. */
  delta?: { value: number; text: string } | null;
  deltaTitle?: string;
  /** Whether a rise is good news; null when it is neither. */
  goodWhenUp?: boolean | null;
  /** 0 to 100: a meter under the value. */
  meter?: number | null;
  /** Makes the whole tile a button that opens its details. */
  onClick?: () => void;
}) {
  const tone = !delta || delta.value === 0 || goodWhenUp === null ? "flat" : delta.value > 0 === goodWhenUp ? "good" : "bad";
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="perf-tile-value">
        {value}
        {delta && (
          <span className={`perf-delta is-${tone}`} title={deltaTitle}>
            {delta.value > 0 ? <ArrowUpRight /> : delta.value < 0 ? <ArrowDownRight /> : null}
            {delta.text}
          </span>
        )}
      </span>
      {meter !== undefined && meter !== null && (
        <span className="perf-meter" role="img" aria-label={`${meter}%`}>
          <span style={{ width: `${Math.max(0, Math.min(100, meter))}%` }} />
        </span>
      )}
      {hint && <span className="stat-hint">{hint}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className="perf-tile is-clickable" onClick={onClick} aria-haspopup="dialog" aria-label={`${label} : voir le détail`}>
      {body}
      <ChevronRight className="perf-tile-go" aria-hidden />
    </button>
  ) : (
    <div className="perf-tile">{body}</div>
  );
}

/** A dashboard card: a title, an optional legend, the chart, and a switch to its table. */
export function ChartCard({
  title,
  series,
  children,
  table,
  wide,
  note,
}: {
  title: string;
  series?: Series[];
  children: ReactNode;
  table?: { head: string[]; rows: (string | number)[][] };
  wide?: boolean;
  note?: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className={`perf-card ${wide ? "is-wide" : ""}`}>
      <div className="perf-card-head">
        <figcaption className="perf-card-title">{title}</figcaption>
        {table && (
          <button
            type="button"
            className="icon-btn perf-card-switch"
            aria-label={asTable ? "Graphique" : "Tableau"}
            data-tip={asTable ? "Graphique" : "Tableau"}
            data-tip-pos="left"
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? <ChartColumn /> : <Table2 />}
          </button>
        )}
      </div>
      {series && series.length > 1 && !asTable && <Legend series={series} />}
      {asTable && table ? <DataTable head={table.head} rows={table.rows} /> : children}
      {note && <p className="perf-note">{note}</p>}
    </figure>
  );
}

function Legend({ series }: { series: Series[] }) {
  return (
    <div className="perf-legend">
      {series.map((s) => (
        <span key={s.key} className="perf-legend-item">
          <span className="perf-swatch" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="perf-table-wrap">
      <table className="perf-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {c}
                  </th>
                ) : (
                  <td key={j} className="tnum">
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Columns over time or over ordered categories. Several series sit side by
 * side in each column; hovering or focusing a column shows every value.
 */
export function ColumnChart({
  series,
  values,
  xLabel,
  tipTitle,
  format = compact,
  nice = niceTop,
  height = 140,
  emphasis,
  labelEvery,
}: {
  series: Series[];
  /** values[column][series] */
  values: number[][];
  xLabel: (i: number) => string;
  tipTitle: (i: number) => string;
  format?: (n: number) => string;
  /** The top of the y axis for the largest value. */
  nice?: (max: number) => number;
  height?: number;
  /** Highlight these columns; the others take the muted color. */
  emphasis?: number[] | null;
  /** Show every n-th x label (by default about seven labels). */
  labelEvery?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  const max = Math.max(0, ...values.flat());
  const top = nice(max);
  const ticks = [0, top / 2, top];
  const every = labelEvery ?? Math.max(1, Math.ceil(n / 7));
  const single = series.length === 1;
  // The largest value of a single series is labeled on its cap.
  const peak = single && max > 0 ? values.findIndex((v) => v[0] === max) : -1;
  return (
    <div className="chart-plot perf-plot" onMouseLeave={() => setHover(null)}>
      <div className="chart-y">
        {ticks.map((v) => (
          <span key={v} className="tnum" style={{ bottom: (v / top) * height - 6 }}>
            {v === 0 ? "0" : format(v)}
          </span>
        ))}
      </div>
      <div className="chart-area" style={{ height }}>
        {ticks.map((v) => (
          <div key={v} className={`chart-grid ${v === 0 ? "is-base" : ""}`} style={{ bottom: (v / top) * height }} />
        ))}
        <div className="chart-cols" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
          {values.map((col, i) => (
            <div
              key={i}
              className={`chart-col ${hover === i ? "is-hover" : ""}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              aria-label={`${tipTitle(i)}: ${series.map((s, j) => `${s.label} ${format(col[j] ?? 0)}`).join(", ")}`}
            >
              <div className={`perf-bars ${single ? "is-single" : ""}`}>
                {series.map((s, j) => {
                  const v = col[j] ?? 0;
                  const h = (v / top) * height;
                  const muted = Boolean(emphasis && !emphasis.includes(i));
                  return (
                    <span key={s.key} className="perf-bar" style={{ height: v > 0 ? Math.max(3, h) : 0, background: muted ? "var(--chart-muted)" : s.color }}>
                      {i === peak && (
                        <span className="chart-value tnum" style={{ bottom: Math.max(3, h) + 3 }}>
                          {format(v)}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {hover !== null && values[hover] && (
          <div className="chart-tip" style={{ left: `${Math.min(88, Math.max(12, ((hover + 0.5) / n) * 100))}%` }} role="status">
            <span className="faint">{tipTitle(hover)}</span>
            {series.map((s, j) => (
              <span key={s.key} className="perf-tip-row">
                <span className="perf-tip-key" style={{ background: s.color }} />
                <strong className="tnum">{format(values[hover]![j] ?? 0)}</strong>
                {!single && <span className="faint">{s.label}</span>}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="chart-x" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
        {values.map((_, i) => (
          <span key={i} className="tnum">
            {i % every === 0 || i === n - 1 ? xLabel(i) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Ranked horizontal bars of one measure, value at the tip. Rows past `max` fold into the last one. */
export function BarList({
  rows,
  format = compact,
  color = "var(--series-1)",
  max = 7,
  otherLabel,
}: {
  rows: { key: string; label: string; value: number; dot?: string | null; hint?: string }[];
  format?: (n: number) => string;
  color?: string;
  max?: number;
  otherLabel?: string;
}) {
  const shown = rows.length > max && otherLabel ? [...rows.slice(0, max - 1), { key: "_other", label: otherLabel, value: rows.slice(max - 1).reduce((s, r) => s + r.value, 0) }] : rows.slice(0, max);
  const top = Math.max(1, ...shown.map((r) => r.value));
  return (
    <ul className="perf-barlist">
      {shown.map((r) => (
        <li key={r.key} title={r.hint}>
          <span className="perf-barlist-label">
            {r.dot !== undefined && <span className="perf-dot" style={{ background: r.dot ?? "var(--chart-muted)" }} />}
            <span className="truncate">{r.label}</span>
          </span>
          <span className="perf-barlist-track">
            <span style={{ width: `${(r.value / top) * 100}%`, background: color }} />
          </span>
          <span className="perf-barlist-value tnum">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** One bar split into parts (part-to-whole), with a legend that carries the values. */
export function SplitBar({ parts, format = compact }: { parts: (Series & { value: number })[]; format?: (n: number) => string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="perf-split">
      <div className="perf-split-bar" role="img" aria-label={parts.map((p) => `${p.label} ${format(p.value)}`).join(", ")}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span key={p.key} style={{ flexGrow: p.value, background: p.color }} title={`${p.label}: ${format(p.value)}`} />
          ))}
      </div>
      <div className="perf-legend">
        {parts.map((p) => (
          <span key={p.key} className="perf-legend-item">
            <span className="perf-swatch" style={{ background: p.color }} />
            {p.label}
            <strong className="tnum">{format(p.value)}</strong>
            {total > 0 && <span className="faint tnum">{Math.round((100 * p.value) / total)} %</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
