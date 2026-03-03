import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extensionFactory from "../src/index.js";

// Verify default export is assignable to (pi: ExtensionAPI) => void
const _factory: (pi: ExtensionAPI) => void = extensionFactory;
void _factory;
