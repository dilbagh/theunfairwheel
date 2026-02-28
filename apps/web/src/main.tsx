import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { router } from "./router";
import "./styles.css";

const rootEl = document.getElementById("app");
const queryClient = new QueryClient();

if (!rootEl) {
  throw new Error("Root element with id 'app' was not found.");
}

createRoot(rootEl).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
