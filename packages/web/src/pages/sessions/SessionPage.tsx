import { useParams } from 'react-router-dom';
import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function SessionPage() {
  const { id = '' } = useParams();
  return (
    <>
      <PageHeader
        title={`Session ${id}`}
        subtitle={'One managed session: plan, progress, decisions and liveness.'}
        breadcrumbs={[{ label: 'Console', to: '/console' }, { label: id }]}
      />
      <EmptyState
        icon="console"
        title="Not yet implemented"
        body={
          'Session hero (§12): the timeline strip — phases to scale, tool-call ticks, decision diamonds, amber drift marks — with the stacked per-phase completion bar beneath.'
        }
      />
    </>
  );
}
