import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the requester-portal implementation. No internal terminology here (§7). */
export default function PortalNewRequestPage() {
  return (
    <>
      <PageHeader
        title={'New request'}
        subtitle={'Tell us what went wrong — a description, screenshots or a short video help most.'}
        breadcrumbs={[{ label: 'My requests', to: '/portal' }, { label: 'New request' }]}
      />
      <EmptyState title="Coming soon" body={'The request form will be available here.'} />
    </>
  );
}
