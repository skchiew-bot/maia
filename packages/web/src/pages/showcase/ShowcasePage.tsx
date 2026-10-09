import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function ShowcasePage() {
  return (
    <>
      <PageHeader title={'Showcase'} subtitle={'An optional, presentational view of the platform.'} />
      <EmptyState
        icon="showcase"
        title="Not yet implemented"
        body={
          'Showcase (§12): optional, 2D by default, built last and never the landing view. 3D is allowed only here.'
        }
      />
    </>
  );
}
