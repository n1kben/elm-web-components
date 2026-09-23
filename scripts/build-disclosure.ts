import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const example = resolve(root, "examples/disclosure");
const output = resolve(root, "dist/disclosure.js");

mkdirSync(dirname(output), { recursive: true });

const result = spawnSync(
  resolve(root, "node_modules/.bin/elm"),
  ["make", "src/Main.elm", `--output=${output}`],
  {
    cwd: example,
    env: { ...process.env, ELM_HOME: resolve(root, ".elm-home") },
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

appendFileSync(output, `\n${readFileSync(resolve(example, "adapter.js"), "utf8")}`);
console.log(`Built ${output}`);
