import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <main className="grid min-h-dvh place-items-center p-6 text-center">
      <div>
        <h1 className="hd text-2xl">Page not found</h1>
        <p className="mt-2 text-text2">The page you were looking for doesn’t exist.</p>
      </div>
    </main>
  ),
});
