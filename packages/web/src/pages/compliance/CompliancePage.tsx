import { useState } from 'react';
import type { ComplianceMappingDTO, EvidencePackSummaryDTO } from '@aoc/contracts';
import { useAuth } from '../../api/auth';
import type { StreamMessage } from '../../api/stream';
import { useResource } from '../../api/useResource';
import { InlineAlert, PageHeader, Widget, WidgetGrid } from '../../components';
import { useNow } from '../../lib/clock';
import { PeopleProvider } from '../audit/people';
import { can } from '../audit/permissions';
import { LoadFailed, Skeleton } from '../audit/Skeleton';
import { MappingStatus, MappingTable } from './Mapping';
import { GeneratePackForm, PacksTable } from './Packs';
import './compliance.css';

const isMappingEvent = (m: StreamMessage) => m.kind === 'aoc' && m.event.type.startsWith('mapping.');
const isPackEvent = (m: StreamMessage) => m.kind === 'aoc' && m.event.type.startsWith('evidence_pack.');

function ComplianceView() {
  const { user } = useAuth();
  const now = useNow();
  const mapping = useResource<ComplianceMappingDTO>('/api/compliance/mapping', { refreshOn: isMappingEvent });
  const packs = useResource<{ packs: EvidencePackSummaryDTO[] }>('/api/evidence/packs', {
    refreshOn: isPackEvent,
  });
  const [stamped, setStamped] = useState<ComplianceMappingDTO | null>(null);
  const current =
    stamped && mapping.data && stamped.hash === mapping.data.hash && mapping.data.status !== 'stamped'
      ? stamped
      : mapping.data;
  const canGenerate = can(user, 'evidence.generate');

  return (
    <WidgetGrid>
      <Widget
        span={12}
        title="Can the ISO/IEC 42001 mapping be cited?"
        subtitle="provisional until the compliance lead stamps its exact hash"
        info="The clause numbers in AOC-SPEC-002's table were wrong in at least five rows (§13); the compliance lead confirms every row against ISO/IEC 42001:2023 before the mapping is cited. A stamp is bound to the mapping hash: editing the mapping makes it provisional again (R3)."
      >
        {current ? (
          <MappingStatus mapping={current} onStamped={setStamped} />
        ) : mapping.error ? (
          <LoadFailed what="the compliance mapping" error={mapping.error} onRetry={mapping.reload} />
        ) : (
          <Skeleton label="Loading the compliance mapping" blocks={[72, 96]} />
        )}
      </Widget>

      <Widget
        span={12}
        flush
        title="Clause → evidence"
        subtitle="each AOC control, the clause it evidences, and what an auditor can check"
      >
        {current ? (
          <MappingTable mapping={current} />
        ) : (
          <Skeleton label="Loading the mapping rows" blocks={[320]} />
        )}
      </Widget>

      <Widget
        span={12}
        title="Evidence packs"
        subtitle="frozen, hash-verified, date-ranged and control-mapped"
        info="One button produces an evidence bundle for a date range (§14): the chained headers (never bodies), the chain and anchor verification, the control mapping with its stamp state, and the rate card in force. It is written once, its sha256 recorded in the chain and re-checked before every download."
      >
        {canGenerate ? (
          <GeneratePackForm now={now} onGenerated={() => packs.reload()} />
        ) : (
          <InlineAlert tone="info" title="Generating packs needs the Builder or Approver role" />
        )}
        <div className="compliance-packs">
          {packs.data ? (
            <PacksTable packs={packs.data.packs} />
          ) : packs.error ? (
            <LoadFailed what="evidence packs" error={packs.error} onRetry={packs.reload} />
          ) : (
            <Skeleton label="Loading evidence packs" blocks={[140]} />
          )}
        </div>
      </Widget>
    </WidgetGrid>
  );
}

export default function CompliancePage() {
  return (
    <PeopleProvider>
      <PageHeader
        title="Compliance"
        subtitle="The ISO/IEC 42001:2023 control mapping and frozen evidence packs for the auditor (§13, §14)."
      />
      <ComplianceView />
    </PeopleProvider>
  );
}
