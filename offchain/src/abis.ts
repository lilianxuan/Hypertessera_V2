// Single source of truth: control-panel/abis.json, regenerated from forge build artifacts via
// control-panel/build-abis.sh. Module E consumes the same ABIs the control panel does, so the two
// never drift (development-plan.md §2.5 "W4 -> W5: All ABI surfaces ... must be frozen").
//
// The registry itself (abis-registry.ts) holds no Node-specific imports, so it bundles cleanly
// for a browser target. This module adds the Node auto-load on top: a guarded dynamic import
// that only resolves under Node (`process.versions.node`), so a browser bundle never reaches the
// `node:fs`-based abis-node.js. Browser callers must call `setAbis(...)` once at startup with an
// imported control-panel/abis.json before constructing a HyperTesseraSDK.
export * from "./abis-registry.js";
import { abisLoaded } from "./abis-registry.js";

if (typeof process !== "undefined" && process.versions?.node && !abisLoaded()) {
  await import("./abis-node.js");
}
