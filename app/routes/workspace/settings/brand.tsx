/** Settings → Brand (Owner). The API enforces Owner-only; this page just hides itself from others. */
import { createFileRoute } from '@tanstack/react-router';
import { BrandEditor } from '@/settings/BrandEditor';
import { Card } from '@/ui/controls';

export const Route = createFileRoute('/workspace/settings/brand')({ component: BrandSettings });

function BrandSettings() {
  return (
    <>
      <div>
        <h1 className="hd t-h1">Brand</h1>
        <p className="mt-1 text-text2">Your logo, colors and type, everywhere your clients look: sign-in, portal, emails, link previews.</p>
      </div>
      <Card>
        <BrandEditor />
      </Card>
    </>
  );
}
