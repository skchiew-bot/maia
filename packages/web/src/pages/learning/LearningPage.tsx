import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function LearningPage() {
  return (
    <>
      <PageHeader title={'Learning'} subtitle={'Distilled lessons and repeat-offence classes.'} />
      <EmptyState
        icon="learning"
        title="Not yet implemented"
        body={
          'Error learning (§11): scoped lessons with repeats prevented and savings, and a recurrence trend per root-cause class — never per-person blame.'
        }
      />
    </>
  );
}
