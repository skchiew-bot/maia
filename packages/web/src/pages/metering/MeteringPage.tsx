import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function MeteringPage() {
  return (
    <>
      <PageHeader
        title={'Metering'}
        subtitle={'Tokens and notional cost by actor, task, project and model.'}
      />
      <EmptyState
        icon="metering"
        title="Not yet implemented"
        body={
          'Metering (§10): input, output, cache-read and cache-write tokens with a notional API-equivalent cost (labelled as such), plan-limit hits and idle time. Observes, never gates.'
        }
      />
    </>
  );
}
