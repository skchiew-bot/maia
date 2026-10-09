import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function ChangesPage() {
  return (
    <>
      <PageHeader title={'Changes'} subtitle={'Change requests and their approval state.'} />
      <EmptyState
        icon="changes"
        title="Not yet implemented"
        body={
          'Change control (§8): impact analysis, mitigation plan, rollback plan (exact commit or tag) and acceptance test — all four before work starts.'
        }
      />
    </>
  );
}
