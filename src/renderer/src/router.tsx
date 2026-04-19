import { createHashHistory, createRouter } from '@tanstack/react-router'
import type { RouterHistory } from '@tanstack/react-router'
import { routeTree } from './routes/routeTree'

export function createAppRouter(history?: RouterHistory): ReturnType<typeof createRouter> {
  return createRouter({
    routeTree,
    history,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0
  })
}

export const router = createAppRouter(createHashHistory())

// Register this router for TanStack's typed hooks.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
