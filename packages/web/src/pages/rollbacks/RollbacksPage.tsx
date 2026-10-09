import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function RollbacksPage() {
  return (
    <>
      <PageHeader title={'Rollbacks'} subtitle={'Gated rollbacks to pinned tags, verified before main.'} />
      <EmptyState
        icon="rollbacks"
        title="Not yet implemented"
        body={
          "Rollback (§8): the supervisor checks out the tag on a new branch, runs that state's acceptance tests and reports back; the Approver signs off once it is shown clean."
        }
      />
    </>
  );
}
