import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function RegistryPage() {
  return (
    <>
      <PageHeader title={'Registry'} subtitle={'Process types and the economics of distillation.'} />
      <EmptyState
        icon="registry"
        title="Not yet implemented"
        body={
          'Registry hero (§12): discovery-vs-execution cost-per-run paired bars plus a trend sparkline per process type — sized large and shown first.'
        }
      />
    </>
  );
}
