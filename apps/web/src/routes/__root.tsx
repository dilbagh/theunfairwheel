import { Link, Outlet, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <main>
      <nav>
        <Link to="/">Home</Link>
      </nav>
      <Outlet />
    </main>
  );
}
