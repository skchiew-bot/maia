import { useParams } from 'react-router-dom';
import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function ChangePage() {
  const { id = '' } = useParams();
  return (
    <>
      <PageHeader
        title={`Change request ${id}`}
        subtitle={'Impact, mitigation, rollback target and acceptance test.'}
        breadcrumbs={[{ label: 'Changes', to: '/changes' }, { label: id }]}
      />
      <EmptyState
        icon="changes"
        title="Not yet implemented"
        body={
          'Change record detail (§8, §14): the four required fields, who affirmed each, the pinned tag and the provenance trail to main.'
        }
      />
    </>
  );
}
