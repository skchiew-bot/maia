import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function AuditPage() {
  return (
    <>
      <PageHeader title={'Audit'} subtitle={'The append-only, hash-chained event log.'} />
      <EmptyState
        icon="audit"
        title="Not yet implemented"
        body={
          'Audit trail (§13): one hash-chained log for CEO and auditor alike — liveness state changes, decisions, grants and changes — verified against the off-host anchor.'
        }
      />
    </>
  );
}
