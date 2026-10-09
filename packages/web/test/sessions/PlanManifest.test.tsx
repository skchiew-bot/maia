import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ManifestPhaseDTO } from '@aoc/contracts';
import { PlanManifest } from '../../src/pages/sessions/PlanManifest';
import { ago, NOW } from './fixtures';

const phase: ManifestPhaseDTO = {
  phaseId: 'p2',
  name: 'Fix',
  order: 1,
  completedAt: null,
  pinnedSha: null,
  pinnedTag: null,
  tasks: [
    {
      taskId: 't3',
      phaseId: 'p2',
      title: 'Idempotency key on claim submit',
      acceptance: null,
      size: 'm',
      weight: 3,
      status: 'done',
      declaredBy: 'ses_rich',
      sessionId: 'ses_rich',
      doneAt: ago(4),
      evidence: { kind: 'diff', ref: 'src/claims/idempotency.ts', verified: false },
      flag: 'evidence_unverified',
    },
    {
      taskId: 't4',
      phaseId: 'p2',
      title: 'Dedupe store with 24h expiry',
      acceptance: null,
      size: 'l',
      weight: 5,
      status: 'open',
      declaredBy: 'ses_rich',
      sessionId: 'ses_rich',
      doneAt: null,
      evidence: null,
      flag: null,
    },
  ],
};

describe('PlanManifest', () => {
  it('says why a close is flagged and breaks evidence paths at separators, not mid-name', () => {
    render(
      <MemoryRouter>
        <PlanManifest manifest={[phase]} amendments={[]} nameOf={() => null} now={NOW} />
      </MemoryRouter>,
    );
    expect(screen.getByText('1 task flagged')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'P2 Fix tasks' });
    expect(within(table).getByText('Evidence did not verify — counts until reviewed')).toBeInTheDocument();
    const ref = within(table).getByText('src/claims/idempotency.ts');
    expect(ref.tagName).toBe('CODE');
    expect(ref.querySelectorAll('wbr')).toHaveLength(2);
    expect(within(table).getByText('unverified')).toBeInTheDocument();
  });
});
