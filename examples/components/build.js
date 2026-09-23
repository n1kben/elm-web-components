import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../tool/build.js";

const project = dirname(fileURLToPath(import.meta.url));
const root = resolve(project, "../..");
process.env.ELM_HOME ??= resolve(root, ".elm-home");
const split = process.argv.includes("--split");
build(resolve(project, split ? "elm-web-components.split.json" : "elm-web-components.json"));
if (split) process.exit(0);
const result = spawnSync(
  resolve(root, "node_modules/.bin/elm"),
  ["make", "src/Host.elm", "--output=../../dist/host.js"],
  { cwd: project, env: process.env, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
