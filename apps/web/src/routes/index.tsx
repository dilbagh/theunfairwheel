import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@repo/ui/button";
import { apiClient } from "../lib/api-client";

export const Route = createFileRoute("/")({
  component: Home,
});

async function fetchHealth() {
  const response = await apiClient.health.$get();

  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`);
  }

  return response.json();
}

function Home() {
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
  });

  return (
    <section>
      <h1>@repo/web</h1>
      <p>Vite + TanStack Router is ready.</p>
      <Button appName="@repo/web">Test UI package</Button>
      <h2>Backend health</h2>
      {healthQuery.isLoading && <p>Loading backend health...</p>}
      {healthQuery.isError && (
        <p>
          Failed to load backend health: {healthQuery.error.message}
        </p>
      )}
      {healthQuery.data && (
        <pre>{JSON.stringify(healthQuery.data, null, 2)}</pre>
      )}
    </section>
  );
}
