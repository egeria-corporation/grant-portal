import { createFileRoute, Link } from '@tanstack/react-router';
import { ClipboardPlus } from 'lucide-react';
import { RequestList } from '@/client/Requests';
import { Vault } from '@/client/Vault';
import { useMe } from '@/lib/session';

export const Route = createFileRoute('/workspace/clients/$clientId/documents')({ component: Documents });

function Documents() {
  const { clientId } = Route.useParams();
  const me = useMe();
  const newRequest = (
    <Link to="/workspace/clients/$clientId/requests/new" params={{ clientId }} className="btn btn-primary btn-sm">
      <ClipboardPlus aria-hidden className="i" /> Request documents
    </Link>
  );
  return (
    <>
      <section className="flex flex-col gap-3" aria-labelledby="req-h">
        <div className="flex items-center gap-3">
          <h2 id="req-h" className="t-h3 flex-1">
            Requests
          </h2>
          {newRequest}
        </div>
        <RequestList clientId={clientId} access="staff" />
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="vault-h">
        <h2 id="vault-h" className="t-h3">
          Vault
        </h2>
        {me.data ? <Vault clientId={clientId} access="staff" meId={me.data.user.id} /> : null}
      </section>
    </>
  );
}
