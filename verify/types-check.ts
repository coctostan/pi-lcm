import type { LCMConfig } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

// Verify LCMConfig is importable and usable as a type
const _config: LCMConfig = DEFAULT_CONFIG;
void _config;
