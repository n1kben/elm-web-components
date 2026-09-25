import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

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

const pending = new Map<number, { resolve: (component: ComponentSource) => void; reject: (error: Error) => void }>();

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

    if ("error" in result) waiting.reject(new Error(result.error));
    else {
      // SAFETY: The Elm worker emits the ComponentSource fields declared in Generator.elm.
      const component = JSON.parse(JSON.stringify({ ...result.component, elm: result.elm, host: result.host, adapter: result.adapter, codec: result.codec })) as ComponentSource;
      waiting.resolve(component);
    }
  });

  return generator;
}

export async function parseComponent(path: string, modules: Array<{ path: string; contents: string }> = [], packages: Array<{ name: string; docs: string }> = []): Promise<ComponentSource> {
  const app = startGenerator();
  const id = nextId++;

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    app.ports.request.send({ id, path, contents: readFileSync(path, "utf8"), modules, packages });
  });
}
