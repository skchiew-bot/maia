import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function CompliancePage() {
  return (
    <>
      <PageHeader title={'Compliance'} subtitle={'ISO/IEC 42001 control mapping and evidence packs.'} />
      <EmptyState
        icon="compliance"
        title="Not yet implemented"
        body={
          'Compliance (§13, §14): the corrected 42001:2023 control mapping (provisional until the compliance lead stamps it) and frozen, hash-verified evidence packs.'
        }
      />
    </>
  );
}
