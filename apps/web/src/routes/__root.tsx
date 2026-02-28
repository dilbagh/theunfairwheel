import { Outlet, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <div className="app-shell">
      <div className="bg-layer bg-layer-one" aria-hidden />
      <div className="bg-layer bg-layer-two" aria-hidden />
      <main className="page-wrap">
        <Outlet />
      </main>
    </div>
  );
}
