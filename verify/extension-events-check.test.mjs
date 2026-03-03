import { readFileSync } from "fs";

const src = readFileSync("src/index.ts", "utf8");
const required = ["context", "session_start", "agent_end", "tool_result", "session_before_compact"];
const missing = required.filter((e) => !src.includes(`pi.on("${e}"`));
if (missing.length) {
	console.error("Missing pi.on() registrations:", missing);
	process.exit(1);
}
console.log("All 5 event handlers registered.");
