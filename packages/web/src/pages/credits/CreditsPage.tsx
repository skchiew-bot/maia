import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function CreditsPage() {
  return (
    <>
      <PageHeader title={'Credits'} subtitle={'Allocations, automatic grants and top-up requests.'} />
      <EmptyState
        icon="credits"
        title="Not yet implemented"
        body={
          'Credits (§10): hard caps enforced at task boundaries only, the one-time 25% grant, and top-up requests routed to an Approver — every grant an audited event.'
        }
      />
    </>
  );
}
