/** Portal documents (spec §6.3): requested items first, then the shared vault. */
import { createFileRoute } from '@tanstack/react-router';
import { usePortalClient } from '@/client/portalClient';
import { RequestList } from '@/client/Requests';
import { Vault } from '@/client/Vault';
import { useMe } from '@/lib/session';

export const Route = createFileRoute('/portal/documents')({ component: Documents });

function Documents() {
  const { client } = usePortalClient();
  const me = useMe();
  if (!client || !me.data) return null;
  const access = client.role;
  return (
    <>
      <h1 className="hd text-[26px] leading-8">Documents</h1>
      <section className="flex flex-col gap-3" aria-labelledby="req-h">
        <h2 id="req-h" className="t-h3">
          Requested from you
        </h2>
        <RequestList clientId={client.id} access={access} />
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="vault-h">
        <h2 id="vault-h" className="t-h3">
          Shared documents
        </h2>
        <Vault clientId={client.id} access={access} meId={me.data.user.id} />
      </section>
    </>
  );
}
