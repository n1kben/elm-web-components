import { Effect } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../tool/build.ts";

const project = dirname(fileURLToPath(import.meta.url));

const root = resolve(project, "../..");

process.env.ELM_HOME ??= resolve(root, ".elm-home");

await Effect.runPromise(build({
  app: "src/Host.elm",
  output: "../../dist/app.js",
  componentFiles: ["src/Ui/Disclosure.elm", "src/Ui/DatePicker.elm"],
}, project));
