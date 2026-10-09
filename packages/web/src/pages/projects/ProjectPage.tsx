import { useParams } from 'react-router-dom';
import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function ProjectPage() {
  const { id = '' } = useParams();
  return (
    <>
      <PageHeader
        title={`Project ${id}`}
        subtitle={'Master timeline, manifest and the sessions that built it.'}
        breadcrumbs={[{ label: 'Projects', to: '/projects' }, { label: id }]}
      />
      <EmptyState
        icon="projects"
        title="Not yet implemented"
        body={
          'Master project timeline (§9): tasks done over tasks declared across all developers as a stacked per-phase bar, audited manifest amendments and rollover history (§5).'
        }
      />
    </>
  );
}
