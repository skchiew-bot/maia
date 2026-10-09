import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function ConsolePage() {
  return (
    <>
      <PageHeader
        title={'Console'}
        subtitle={'Every agent session at a glance, live from the event stream.'}
      />
      <EmptyState
        icon="console"
        title="Not yet implemented"
        body={
          'Console hero (§12): a small-multiple grid of per-agent actions-per-minute sparklines — a flat line reveals a stall before any badge — with liveness badges and the open-decision queue.'
        }
      />
    </>
  );
}
