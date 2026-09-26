import { buildApplication } from "./app.js";

const app = buildApplication();
app.server.listen(app.config.port, app.config.host, () => {
  console.log(`ClaimCheck orchestrator listening on http://${app.config.host}:${app.config.port}`);
  console.log("Keys are read only from server-side environment variables.");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => app.server.close(() => process.exit(0)));
}
