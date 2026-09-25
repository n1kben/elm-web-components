#!/usr/bin/env node
import { Effect, Either } from "effect";
import { build, type BuildOptions } from "../tool/build.ts";

const usage = "Usage: elm-web-components build [--app src/Main.elm] [--output dist/app.js] [--optimize] src/Ui/Component.elm ...\n";

const args = process.argv.slice(2);

if (args[0] === "--help" || args[0] === "-h") {
  process.stdout.write(usage);
} else if (args.shift() === "build") {
  try {
    const options: BuildOptions = { componentFiles: [] };

    while (args.length) {
      const arg = args.shift()!;

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

    const controller = new AbortController();
    let interruptedBy: NodeJS.Signals | undefined;
    const interrupt = (signal: NodeJS.Signals): void => { interruptedBy = signal; controller.abort(); };

    const onInterrupt = (): void => interrupt("SIGINT");
    const onTerminate = (): void => interrupt("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);

    try {
      const result = await Effect.runPromise(Effect.either(build(options)), { signal: controller.signal });

      if (Either.isLeft(result)) throw result.left;
    } catch (error) {
      if (!interruptedBy) throw error;
      process.exitCode = interruptedBy === "SIGINT" ? 130 : 143;
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write(usage);
  process.exitCode = 1;
}
