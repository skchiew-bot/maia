import { useLocation } from 'react-router-dom';
import { ButtonLink, EmptyState, PageHeader } from '../../components';

/** Operator 404 (inside the shell). */
export default function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <>
      <PageHeader title="Page not found" subtitle={<code>{pathname}</code>} />
      <EmptyState
        icon="search"
        title="Nothing lives at this address"
        body="The link may be out of date, or the item was renamed. Every record stays in the audit log."
        action={
          <ButtonLink to="/console" variant="primary">
            Go to Console
          </ButtonLink>
        }
      />
    </>
  );
}
