import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setAbis } from "./abis-registry.js";

// Node-only companion to abis.ts: reads control-panel/abis.json off disk and registers it.
// Importing this module for its side effect is how Node consumers (scripts, tests, KeeperBot,
// etc.) get ABIs without calling setAbis() themselves — see abis.ts's guarded dynamic import.
// Imports abis-registry.ts directly (not abis.ts) to avoid a circular import back through abis.ts's
// own dynamic import of this file. Never imported by a browser bundle: keeping the `node:*`
// imports out of abis.ts/abis-registry.ts/sdk.ts is what lets those bundle cleanly for a browser target.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const ABIS_PATH = join(__dirname, "..", "..", "control-panel", "abis.json");

setAbis(JSON.parse(readFileSync(ABIS_PATH, "utf-8")));
