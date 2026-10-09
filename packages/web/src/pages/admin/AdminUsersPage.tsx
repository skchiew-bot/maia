import { EmptyState, PageHeader } from '../../components';

/** Placeholder — replaced by the Wave-2 page implementation. */
export default function AdminUsersPage() {
  return (
    <>
      <PageHeader
        title={'Users'}
        subtitle={'People, roles and passkeys.'}
        breadcrumbs={[{ label: 'Admin' }, { label: 'Users' }]}
      />
      <EmptyState
        icon="admin"
        title="Not yet implemented"
        body={
          'Identity (§6): per-person accounts with the Approver, Builder or Requester role, token attribution and passkey enrolment for signed approvals.'
        }
      />
    </>
  );
}
