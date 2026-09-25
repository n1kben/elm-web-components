import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Data, Effect } from "effect";

type Field = { name: string; type: string; attribute: string };

type Output = { name: string; fields: Field[]; event: string };

export type ComponentSource = {
  path: string;
  module: string;
  tag: string;
  suffix: string;
  inputs: Field[];
  outputs: Output[];
  elm: string;
  host: string;
  adapter: string;
  codec: string;
};

type GeneratorResponse = { id: number; component: Omit<ComponentSource, "elm" | "host" | "adapter" | "codec">; elm: string; host: string; adapter: string; codec: string } | { id: number; error: string };

type Generator = {
  ports: {
    request: { send: (source: { id: number; path: string; contents: string; modules: Array<{ path: string; contents: string }>; packages: Array<{ name: string; docs: string }> }) => void };
    response: { subscribe: (receive: (value: GeneratorResponse) => void) => void };
  };
};

type WorkerScope = {
  Elm?: { Generator: { init: () => Generator } };
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

let generator: Generator | undefined;

let nextId = 0;

const pending = new Map<number, (result: Effect.Effect<ComponentSource, ParseComponentError>) => void>();

/** A component source or generator failure with its source path. */
export class ParseComponentError extends Data.TaggedError("ParseComponentError")<{ readonly path: string; readonly message: string; readonly cause?: unknown }> {}

function startGenerator(): Generator {
  if (generator) return generator;

  const candidates = [
    fileURLToPath(new URL("../generator.js", import.meta.url)),
    fileURLToPath(new URL("../dist-node/generator.js", import.meta.url)),
  ];

  const path = candidates.find(existsSync);

  if (!path) throw new Error("Elm generator is missing; run npm run build:generator");

  const scope: WorkerScope = {
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(readFileSync(path, "utf8"), scope, { filename: path });

  if (!scope.Elm) throw new Error("Elm generator did not initialize");
  generator = scope.Elm.Generator.init();

  generator.ports.response.subscribe((result) => {
    const waiting = pending.get(result.id);

    if (!waiting) return;
    pending.delete(result.id);

    if ("error" in result) waiting(Effect.fail(new ParseComponentError({ path: "generator", message: result.error })));
    else {
      // SAFETY: The Elm worker emits the ComponentSource fields declared in Generator.elm.
      const component = JSON.parse(JSON.stringify({ ...result.component, elm: result.elm, host: result.host, adapter: result.adapter, codec: result.codec })) as ComponentSource;
      waiting(Effect.succeed(component));
    }
  });

  return generator;
}

/** Parse one Elm component using the bundled Elm generator. */
export function parseComponent(path: string, modules: Array<{ path: string; contents: string }> = [], packages: Array<{ name: string; docs: string }> = []): Effect.Effect<ComponentSource, ParseComponentError> {
  return Effect.gen(function* () {
    const contents = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) => new ParseComponentError({ path, message: `${path}: cannot read component source`, cause }),
    });

    const app = yield* Effect.try({
      try: startGenerator,
      catch: (cause) => new ParseComponentError({ path, message: `${path}: cannot start Elm generator: ${cause instanceof Error ? cause.message : String(cause)}`, cause }),
    });

    const id = nextId++;

    return yield* Effect.async<ComponentSource, ParseComponentError>((resume) => {
      pending.set(id, resume);

      try {
        app.ports.request.send({ id, path, contents, modules, packages });
      } catch (cause) {
        pending.delete(id);
        resume(Effect.fail(new ParseComponentError({ path, message: `${path}: Elm generator request failed`, cause })));
      }

      return Effect.sync(() => { pending.delete(id); });
    });
  });
}
