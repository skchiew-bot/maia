import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function DecisionsPage() {
  return (
    <>
      <PageHeader title={'Decisions'} subtitle={'Human-required decisions waiting on you, oldest first.'} />
      <EmptyState
        icon="decisions"
        title="Not yet implemented"
        body={
          'Decision inbox (§2, R15): every card shows its age; approving resumes the session via the supervisor. Go-live and rollback will require a per-decision passkey (§6).'
        }
      />
    </>
  );
}
