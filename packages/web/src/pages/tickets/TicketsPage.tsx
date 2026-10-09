import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function TicketsPage() {
  return (
    <>
      <PageHeader title={'Tickets'} subtitle={'Requester intake tickets and the work they spawned.'} />
      <EmptyState
        icon="tickets"
        title="Not yet implemented"
        body={
          'Tickets (§7): each intake with its read-only diagnosis, root cause, fix-plan gate and UAT sign-off. Raw uploads stay behind the role boundary.'
        }
      />
    </>
  );
}
