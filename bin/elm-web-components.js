#!/usr/bin/env node
import { build } from "../tool/build.js";

const usage = "Usage: elm-web-components build [--app src/Main.elm] [--output dist/app.js] [--optimize] src/Ui/Component.elm ...\n";

const args = process.argv.slice(2);

if (args[0] === "--help" || args[0] === "-h") {
  process.stdout.write(usage);
} else if (args.shift() === "build") {
  try {
    const options = { componentFiles: [] };

    while (args.length) {
      const arg = args.shift();

      if (arg === "--app" || arg === "--output") {
        if (!args.length || args[0].startsWith("--")) throw new Error(`${arg} requires a path`);
        options[arg === "--app" ? "app" : "output"] = args.shift();
      } else if (arg === "--optimize") {
        options.optimize = true;
      } else if (arg.startsWith("-")) {
        throw new Error(`Unknown option ${arg}`);
      } else {
        options.componentFiles.push(arg);
      }
    }

    build(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage}`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write(usage);
  process.exitCode = 1;
}
