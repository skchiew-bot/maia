import { useParams } from 'react-router-dom';
import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function TicketPage() {
  const { id = '' } = useParams();
  return (
    <>
      <PageHeader
        title={`Ticket ${id}`}
        subtitle={'Diagnosis, fix plan and UAT for one intake.'}
        breadcrumbs={[{ label: 'Tickets', to: '/tickets' }, { label: id }]}
      />
      <EmptyState
        icon="tickets"
        title="Not yet implemented"
        body={
          'Ticket detail (§7): severity, diagnosis budget, root-cause confidence, linked sessions and the two human gates (fix plan, go-live).'
        }
      />
    </>
  );
}
