/** The live blocks of a client update (deadlines, opportunities, documents, wins). */
import type { UpdateBlock } from '@/lib/types';

export function BlockList({ blocks }: { blocks: UpdateBlock[] }) {
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((b) => (
        <div key={b.kind}>
          <p className="t-sm font-semibold">{b.title}</p>
          {b.items.length ? (
            <ul className="t-sm ml-5 list-disc text-text2">
              {b.items.map((i, n) => (
                <li key={n}>
                  <span className="text-text">{i.title}</span>
                  {i.detail ? ` — ${i.detail}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="t-sm text-text3">{b.empty}</p>
          )}
        </div>
      ))}
    </div>
  );
}
