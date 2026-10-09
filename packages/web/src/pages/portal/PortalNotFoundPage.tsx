import { ButtonLink, EmptyState, PageHeader } from '../../components';

/** Requester 404. */
export default function PortalNotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState
        title="We couldn't find that page"
        body="The link may be out of date."
        action={
          <ButtonLink to="/portal" variant="primary">
            Back to my requests
          </ButtonLink>
        }
      />
    </>
  );
}
