import { Outlet } from '@tanstack/react-router'

export function RootLayout(): React.JSX.Element {
  return (
    <main>
      <Outlet />
    </main>
  )
}
