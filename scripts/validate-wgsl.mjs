/**
 * WebCut — build-time WGSL validation.
 *
 * WGSL shaders live inside `/* wgsl *\/` tagged template literals, so neither
 * `tsc` nor `vite build` ever parses them — a syntax error compiles clean and
 * only blows up at runtime as an invalid GPUShaderModule (blank viewer). This
 * script extracts every such literal under src/ and parses it with a real WGSL
 * parser, failing the build on any error.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WgslReflect } from "wgsl_reflect/wgsl_reflect.module.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");

/** Recursively collect .ts/.tsx files. */
const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
};

// Match:  <ident> = /* wgsl */ `...`
const LITERAL_RE = /(\w+)\s*=\s*\/\*\s*wgsl\s*\*\/\s*`([\s\S]*?)`/g;

let literals = 0;
let failures = 0;

for (const file of walk(srcDir)) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(LITERAL_RE)) {
    const [, name, code] = m;
    literals += 1;
    try {
      new WgslReflect(code);
    } catch (err) {
      failures += 1;
      const rel = path.relative(root, file);
      console.error(`\n✗ WGSL parse error in ${rel} (${name}):`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

if (failures > 0) {
  console.error(`\nWGSL validation failed: ${failures} of ${literals} shader literal(s) invalid.`);
  process.exit(1);
}
console.log(`WGSL validation passed: ${literals} shader literal(s) OK.`);
