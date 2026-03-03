import { readFileSync } from "fs";
import assert from "assert";

const p = JSON.parse(readFileSync("tsconfig.json", "utf8"));
const co = p.compilerOptions;

assert.strictEqual(co.target, "ESNext");
assert.strictEqual(co.module, "NodeNext");
assert.strictEqual(co.moduleResolution, "NodeNext");
assert.strictEqual(co.strict, true);
assert.strictEqual(co.rootDir, "./src");
assert.strictEqual(co.outDir, "./dist");

console.log("tsconfig.json OK");
