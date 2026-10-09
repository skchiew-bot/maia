import type { AuthUser } from '../../api/auth';
import { ButtonLink, EmptyState } from '../../components';

/** Builders file nothing here: requester tickets reach them through the console (§6). */
export function BuilderNotice({ user }: { user: AuthUser }) {
  return (
    <EmptyState
      icon="tickets"
      title="This portal is for reporting problems"
      body={`You're signed in as ${user.name}, a Builder. Requests filed here reach you as tickets in the console.`}
      action={
        <ButtonLink to="/tickets" variant="primary">
          Open tickets
        </ButtonLink>
      }
    />
  );
}

/** Placeholder cards that hold the page's layout while it loads (static: no shimmer, §12). */
export function CardSkeleton({ count = 3, label }: { count?: number; label: string }) {
  return (
    <div className="portal-skeleton">
      <p className="aoc-sr-only" role="status">
        {label}
      </p>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="portal-card portal-skeleton__card" aria-hidden="true">
          <span className="portal-skeleton__bar portal-skeleton__bar--title" />
          <span className="portal-skeleton__bar portal-skeleton__bar--line" />
          <span className="portal-skeleton__bar portal-skeleton__bar--short" />
        </div>
      ))}
    </div>
  );
}
