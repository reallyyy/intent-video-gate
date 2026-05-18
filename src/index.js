#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { doctor, createApp } from "./server.js";

const command = process.argv[2] || "serve";
const config = await loadConfig();

if (command === "doctor") {
  console.log(JSON.stringify(await doctor(config), null, 2));
} else if (command === "serve") {
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  const port = portArg ? Number(portArg.slice("--port=".length)) : config.port;
  const server = createApp(config);
  server.listen(port, "127.0.0.1", () => {
    console.log(`intent-video-gate listening on http://127.0.0.1:${port}`);
  });
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
