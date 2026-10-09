import { useParams } from 'react-router-dom';
import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the requester-portal implementation. No internal terminology here (§7). */
export default function PortalTicketPage() {
  const { id = '' } = useParams();
  return (
    <>
      <PageHeader
        title={`Request ${id}`}
        subtitle={'Status and updates for one of your requests.'}
        breadcrumbs={[{ label: 'My requests', to: '/portal' }, { label: id }]}
      />
      <EmptyState
        title="Coming soon"
        body={'Details of this request and any testing we ask you to do will appear here.'}
      />
    </>
  );
}
