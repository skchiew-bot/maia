import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function KnowledgePage() {
  return (
    <>
      <PageHeader title={'Knowledge'} subtitle={'Resolved bugs and playbooks as searchable team memory.'} />
      <EmptyState
        icon="knowledge"
        title="Not yet implemented"
        body={
          'Team knowledge layer (§14): resolved bugs and distilled playbooks become searchable institutional memory.'
        }
      />
    </>
  );
}
