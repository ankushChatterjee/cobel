import { createRoute, createRootRoute } from '@tanstack/react-router'
import { HomePage } from './HomePage'
import { RootLayout } from './RootLayout'

const rootRoute = createRootRoute({
  component: RootLayout
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage
})

export const routeTree = rootRoute.addChildren([indexRoute])
