import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function ProjectsPage() {
  return (
    <>
      <PageHeader title={'Projects'} subtitle={'Durable project threads that outlive individual sessions.'} />
      <EmptyState
        icon="projects"
        title="Not yet implemented"
        body={
          'Projects list (§1, §5): each project with its active writer session, completion by phase and open decisions.'
        }
      />
    </>
  );
}
