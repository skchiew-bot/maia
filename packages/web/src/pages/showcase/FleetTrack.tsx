import { useEffect, useRef, useState } from 'react';
import { estimateTextWidth } from '../../charts/shared';
import { livenessColors, LIVENESS_META } from '../../components/liveness/liveness';
import { formatAge, formatClock } from '../../lib/format';
import { prefersReducedMotion } from '../../lib/dom';
import type { TrackModel } from './model';

export const TRACK_HEIGHT = 64;
const PAD_X = 12;
const CY = 36;
const BAR_H = 8;
const GAP = 3;
const NODE_R = 8;
const MARK_Y = 13;

export interface FleetTrackProps {
  track: TrackModel;
  width: number;
  now: number;
  /** Seq of the latest event for this session: each change rings the node once (never under reduced motion). */
  activitySeq: number | null;
  label: string;
}

/** A session's mark colour: its liveness tone; finished and unknown are neutral. */
export function nodeColor(t: TrackModel): string {
  if (t.finished || !t.liveness) return 'var(--text-3)';
  return livenessColors(LIVENESS_META[t.liveness].tone).fg;
}

/** What sits above the node: an open decision first, then a throttle reset, a stall or a dead process. */
function markerOf(
  t: TrackModel,
  now: number,
): { kind: 'decision' | 'throttle' | 'stalled' | 'dead'; text: string } | null {
  if (t.finished) return null;
  if (t.decision) return { kind: 'decision', text: formatAge(now - Date.parse(t.decision.since)) };
  if (t.liveness === 'throttled' && t.throttledUntil)
    return { kind: 'throttle', text: `resets ${formatClock(t.throttledUntil)}` };
  if (t.liveness === 'stalled' && t.livenessSince)
    return { kind: 'stalled', text: formatAge(now - Date.parse(t.livenessSince)) };
  if (t.liveness === 'dead' && t.livenessSince)
    return { kind: 'dead', text: formatAge(now - Date.parse(t.livenessSince)) };
  return null;
}

/** One session's plan as a track of phases (to scale by declared weight) with the session as a node on it. */
export function FleetTrack({ track, width, now, activitySeq, label }: FleetTrackProps) {
  const w = Math.max(120, width);
  const span = w - PAD_X * 2;
  const x = (weight: number) => PAD_X + (track.totalWeight > 0 ? (weight / track.totalWeight) * span : 0);
  const nodeX = track.totalWeight > 0 ? x(track.doneWeight) : PAD_X;
  const marker = markerOf(track, now);
  const ring = useRing(activitySeq);
  const markerRight = nodeX > w - 90;

  return (
    <svg
      className="sc-track"
      width={w}
      height={TRACK_HEIGHT}
      viewBox={`0 0 ${w} ${TRACK_HEIGHT}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {track.phases.length === 0 ? (
        <>
          <line className="sc-track__none" x1={PAD_X} x2={w - PAD_X} y1={CY} y2={CY} />
          <text className="sc-track__note" x={w / 2} y={CY + 22} textAnchor="middle">
            {!track.planKnown
              ? 'Loading the plan…'
              : track.mode === 'observed'
                ? 'Observed session: read-only, no plan'
                : 'No plan declared'}
          </text>
        </>
      ) : (
        track.phases.map((p, i) => {
          const x0 = x(p.start) + (i > 0 ? GAP / 2 : 0);
          const x1 = x(p.start + p.total) - (i < track.phases.length - 1 ? GAP / 2 : 0);
          const segW = Math.max(1, x1 - x0);
          const doneW = p.total > 0 ? (p.done / p.total) * segW : 0;
          const current = i === track.currentPhase && !track.finished && p.done < p.total;
          const labelFits = estimateTextWidth(p.name, 11) <= segW - 4;
          return (
            <g key={p.phaseId}>
              <rect
                className={current ? 'sc-seg sc-seg--current' : 'sc-seg'}
                x={x0}
                y={CY - BAR_H / 2}
                width={segW}
                height={BAR_H}
                rx={2}
              />
              {doneW > 0 && (
                <rect
                  className="sc-seg__done"
                  x={x0}
                  y={CY - BAR_H / 2}
                  width={doneW}
                  height={BAR_H}
                  rx={2}
                />
              )}
              {labelFits && (
                <text
                  className={current ? 'sc-seg__label sc-seg__label--current' : 'sc-seg__label'}
                  x={x0 + segW / 2}
                  y={CY + 22}
                  textAnchor="middle"
                >
                  {p.name}
                </text>
              )}
            </g>
          );
        })
      )}
      {track.planKnown && (
        <g className="sc-node" style={{ transform: `translate(${nodeX}px, ${CY}px)` }}>
          {marker && (
            <g className={`sc-marker sc-marker--${marker.kind}`}>
              <line className="sc-marker__stem" x1={0} x2={0} y1={MARK_Y - CY + 6} y2={-NODE_R} />
              <MarkerGlyph kind={marker.kind} y={MARK_Y - CY} />
              <text
                className="sc-marker__text"
                x={markerRight ? -10 : 10}
                y={MARK_Y - CY + 4}
                textAnchor={markerRight ? 'end' : 'start'}
              >
                {marker.text}
              </text>
            </g>
          )}
          {ring !== null && (
            <circle key={ring} className="sc-ping" r={NODE_R} style={{ stroke: nodeColor(track) }} />
          )}
          <circle className="sc-node__dot" r={NODE_R} style={{ fill: nodeColor(track) }} />
          {track.liveness === 'dead' && !track.finished && (
            <path className="sc-node__x" d="M-3.5,-3.5L3.5,3.5M3.5,-3.5L-3.5,3.5" />
          )}
          {track.finished && <path className="sc-node__x" d="M-3.5,0.5L-1,3L3.8,-2.6" />}
        </g>
      )}
    </svg>
  );
}

function MarkerGlyph({ kind, y }: { kind: 'decision' | 'throttle' | 'stalled' | 'dead'; y: number }) {
  switch (kind) {
    case 'decision':
      return <path className="sc-glyph sc-glyph--decision" d={`M0,${y - 6}L6,${y}L0,${y + 6}L-6,${y}Z`} />;
    case 'throttle':
      return (
        <path
          className="sc-glyph sc-glyph--throttle"
          d={`M-4.5,${y - 6}H4.5L0,${y}L4.5,${y + 6}H-4.5L0,${y}Z`}
        />
      );
    case 'stalled':
      return <path className="sc-glyph sc-glyph--stalled" d={`M0,${y - 6}L6.5,${y + 5}H-6.5Z`} />;
    case 'dead':
      return <rect className="sc-glyph sc-glyph--dead" x={-5} y={y - 5} width={10} height={10} rx={1.5} />;
  }
}

/** Ring key for the latest activity: null until an event arrives after mount (the first value never rings). */
function useRing(activitySeq: number | null): number | null {
  const first = useRef(activitySeq);
  const [ring, setRing] = useState<number | null>(null);
  useEffect(() => {
    if (activitySeq === null || activitySeq === first.current || prefersReducedMotion()) return;
    setRing(activitySeq);
  }, [activitySeq]);
  return ring;
}
