/**
 * Hand-written SVG chart kit (no chart library). Rules every chart follows (§12 + dataviz method):
 * - key numbers are printed as visible text, and the chart has `role="img"` with an aria-label summary;
 * - no idle animation — marks change only when props change (i.e. when an event arrived);
 * - width follows the container (ResizeObserver); hairline recessive axes; 2px surface gaps between fills;
 * - categorical colour only where series identity is the subject, max four adjacent slots, always with a
 *   legend; status colours only where a mark means good/bad, always with a word.
 * Heroes: Sparkline small multiples (Console), TimelineStrip + StackedPhaseBar (Session), PairedBars +
 * TrendSparkline (Registry); Control Tower kit: FunnelBar, LatencyBars, SmallMultiples, StackedBar (with
 * RankedList from ../components).
 */
export { Sparkline, TrendSparkline, type SparklineProps, type TrendSparklineProps } from './Sparkline';
export { TimelineStrip, MarkShape, type TimelineStripProps } from './TimelineStrip';
export { StackedPhaseBar, type StackedPhaseBarProps } from './StackedPhaseBar';
export { PairedBars, type PairedBarsProps } from './PairedBars';
export { Meter, type MeterProps } from './Meter';
export { SegmentBar, type SegmentBarProps } from './SegmentBar';
export { MiniBarChart, type MiniBarChartProps } from './MiniBarChart';
export { RecurrenceTrend, RECURRENCE_STAGE_WORD, type RecurrenceTrendProps } from './RecurrenceTrend';
export { SmallMultiples, type SmallMultiplesProps, type SmallMultipleSeries } from './SmallMultiples';
export { FunnelBar, findBottleneck, type FunnelBarProps, type FunnelStage } from './FunnelBar';
export { LatencyBars, type LatencyBarsProps, type LatencyRow } from './LatencyBars';
export { StackedBar, type StackedBarProps, type StackedBarRow, type StackedBarSeries } from './StackedBar';
export {
  ChartTable,
  HitLayer,
  useElementWidth,
  type ChartTableProps,
  type HitItem,
  type HitLayerProps,
} from './shared';
export type * from './types';
