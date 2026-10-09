/** First-load placeholder that holds the page's frame (static blocks — no shimmer, no idle animation). */
export function TowerSkeleton() {
  return (
    <div className="tower-skel" aria-busy="true">
      <p className="aoc-sr-only" role="status">
        Loading the Control Tower…
      </p>
      <div className="tower-skel__kpis" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className="tower-skel__block tower-skel__kpi" />
        ))}
      </div>
      <div className="tower-main" aria-hidden="true">
        <div className="tower-skel__panel">
          <span className="tower-skel__line tower-skel__line--head" />
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="tower-skel__row">
              <span className="tower-skel__line tower-skel__line--short" />
              <span className="tower-skel__line" />
            </span>
          ))}
        </div>
        <div className="tower-rail">
          <span className="tower-skel__panel tower-skel__panel--tall" />
          <span className="tower-skel__panel tower-skel__panel--mid" />
        </div>
      </div>
      <div className="tower-flow" aria-hidden="true">
        {Array.from({ length: 3 }, (_, i) => (
          <span key={i} className="tower-skel__panel tower-skel__panel--mid" />
        ))}
      </div>
    </div>
  );
}
