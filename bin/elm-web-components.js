#!/usr/bin/env node
import { resolve } from "node:path";
import { build } from "../tool/build.js";

const [command, config] = process.argv.slice(2);
if (command === "--help" || command === "-h") {
  process.stdout.write("Usage: elm-web-components build [path/to/elm-web-components.json]\n");
} else if (command === "build" && process.argv.length <= 4) {
  try {
    build(resolve(config ?? "elm-web-components.json"));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write("Usage: elm-web-components build [path/to/elm-web-components.json]\n");
  process.exitCode = 1;
}
