import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. Approvers land here (`/` → `/tower`). */
export default function ControlTowerPage() {
  return (
    <>
      <PageHeader
        title="Control Tower"
        subtitle="What needs a human now, across every project and session."
      />
      <EmptyState
        icon="tower"
        title="Not yet implemented"
        body="The Approver's landing view: a ranked attention list (RankedList), the work pipeline with its bottleneck (FunnelBar), decision latency against SLA (LatencyBars), fleet activity (SmallMultiples) and work by state (StackedBar)."
      />
    </>
  );
}
