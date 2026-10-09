import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the requester-portal implementation. No internal terminology here (§7). */
export default function PortalHomePage() {
  return (
    <>
      <PageHeader title={'My requests'} subtitle={'Everything you have reported, with its current status.'} />
      <EmptyState
        title="Coming soon"
        body={
          'Your requests will be listed here with a simple status: being worked on, ready for your testing, or completed.'
        }
      />
    </>
  );
}
