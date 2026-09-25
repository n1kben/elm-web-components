import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Data, Effect } from "effect";
import { type Declaration, type ElmModule, type Exposure, type Type, parseModule, parseTypeAnnotation } from "./index.ts";

export class ProjectError extends Data.TaggedError("ProjectError")<{
  path: string;
  message: string;
}> {}

function attempt<A>(path: string, operation: () => A): Effect.Effect<A, ProjectError> {
  return Effect.try({
    try: operation,
    catch: (error) => new ProjectError({ path, message: error instanceof Error ? error.message : String(error) }),
  });
}

export type ResolvedType = {
  module: string;
  name: string;
  declaration: Extract<Declaration, { kind: "alias" | "union" }>;
  constructorsVisible: boolean;
};

type ModuleEntry = { path: string; ast: ElmModule };

type ElmApplication = {
  type: "application";
  "elm-version": string;
  "source-directories": string[];
  dependencies: { direct: Record<string, string>; indirect: Record<string, string> };
};

type PackageAlias = { name: string; args: string[]; type: string };

type PackageUnion = { name: string; args: string[]; cases: Array<[string, string[]]> };

type PackageModule = { name: string; aliases: PackageAlias[]; unions: PackageUnion[] };

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];

  const paths: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "WebComponents" || entry.name === "elm-stuff") continue;
    const path = join(directory, entry.name);

    if (entry.isDirectory()) paths.push(...sourceFiles(path));
    else if (entry.name.endsWith(".elm")) paths.push(path);
  }

  return paths;
}

function exposed(items: Exposure[] | "all" | undefined, name: string): boolean {
  return items === "all" || items?.some((item) => item.kind === "type" && item.name === name) === true;
}

function constructorsExposed(items: Exposure[] | "all" | undefined, name: string): boolean {
  return items === "all" || items?.some((item) => item.kind === "type" && item.name === name && item.constructors) === true;
}

function packageDeclaration(module: PackageModule, name: string): ResolvedType["declaration"] | undefined {
  const range = { start: { offset: 0, row: 1, column: 1 }, end: { offset: 0, row: 1, column: 1 } };
  const alias = module.aliases.find((item) => item.name === name);

  if (alias) return { kind: "alias", name, parameters: alias.args, type: parseTypeAnnotation(alias.type), range };
  const union = module.unions.find((item) => item.name === name);

  if (!union) return undefined;

  return {
    kind: "union",
    name,
    parameters: union.args,
    constructors: union.cases.map(([caseName, args]) => ({ name: caseName, arguments: args.map(parseTypeAnnotation), range })),
    range,
  };
}

export class Project {
  readonly root: string;
  readonly modules: Map<string, ModuleEntry>;
  readonly packages: Map<string, PackageModule>;

  constructor(root: string, modules: Map<string, ModuleEntry>, packages: Map<string, PackageModule>) {
    this.root = root;
    this.modules = modules;
    this.packages = packages;
  }

  module(name: string): ElmModule {
    const entry = this.modules.get(name);

    if (!entry) throw new Error(`unknown project module ${name}`);

    return entry.ast;
  }

  resolveType(fromModule: string, reference: Extract<Type, { kind: "named" }>): ResolvedType {
    const from = this.modules.get(fromModule)?.ast;

    if (!from && !this.packages.has(fromModule)) throw new Error(`unknown module ${fromModule}`);

    const qualifier = reference.module.join(".");
    const candidates: string[] = [];

    if (qualifier === "") {
      if (!from || from.declarations.some((item) => (item.kind === "alias" || item.kind === "union") && item.name === reference.name)) {
        candidates.push(fromModule);
      } else {
        for (const imported of from.imports) {
          if (exposed(imported.exposing, reference.name)) candidates.push(imported.module);
        }
      }
    } else if (qualifier === fromModule) {
      candidates.push(fromModule);
    } else {
      if (from) {
        for (const imported of from.imports) {
          if (imported.module === qualifier || imported.alias === qualifier) candidates.push(imported.module);
        }
      } else if (this.packages.has(qualifier)) {
        candidates.push(qualifier);
      }
    }

    const found: ResolvedType[] = [];

    for (const moduleName of candidates) {
      const projectModule = this.modules.get(moduleName)?.ast;

      if (projectModule) {
        const declaration = projectModule.declarations.find((item): item is ResolvedType["declaration"] =>
          (item.kind === "alias" || item.kind === "union") && item.name === reference.name);

        if (!declaration) continue;

        if (moduleName !== fromModule && !exposed(projectModule.exposing, reference.name)) continue;

        found.push({
          module: moduleName,
          name: reference.name,
          declaration,
          constructorsVisible: declaration.kind === "alias"
            ? exposed(projectModule.exposing, reference.name)
            : constructorsExposed(projectModule.exposing, reference.name),
        });
        continue;
      }

      const packageModule = this.packages.get(moduleName);

      if (!packageModule) continue;
      const declaration = packageDeclaration(packageModule, reference.name);

      if (declaration) found.push({ module: moduleName, name: reference.name, declaration, constructorsVisible: declaration.kind === "alias" || declaration.constructors.length > 0 });
    }

    if (found.length === 1) return found[0]!;

    if (found.length > 1) throw new Error(`${fromModule}: ambiguous type ${reference.name} from ${found.map((item) => item.module).join(", ")}`);
    throw new Error(`${fromModule}: cannot resolve type ${[qualifier, reference.name].filter(Boolean).join(".")}`);
  }
}

export function openProject(root: string, elmHome = process.env.ELM_HOME ?? join(homedir(), ".elm")): Effect.Effect<Project, ProjectError> {
  return Effect.gen(function* () {
    const directory = resolve(root);
    const manifestPath = join(directory, "elm.json");
    const manifest: ElmApplication = yield* attempt(manifestPath, () => JSON.parse(readFileSync(manifestPath, "utf8")));

    if (manifest.type !== "application") {
      return yield* Effect.fail(new ProjectError({ path: manifestPath, message: "expected an Elm application" }));
    }

    const modules = new Map<string, ModuleEntry>();

    for (const sourceDirectory of manifest["source-directories"]) {
      const sourceRoot = resolve(directory, sourceDirectory);
      const paths = yield* attempt(sourceRoot, () => sourceFiles(sourceRoot));

      for (const path of paths) {
        const ast = yield* attempt(path, () => parseModule(readFileSync(path, "utf8")));

        if (modules.has(ast.name)) {
          return yield* Effect.fail(new ProjectError({ path, message: `duplicate module ${ast.name}` }));
        }

        modules.set(ast.name, { path, ast });
      }
    }

    const packages = new Map<string, PackageModule>();
    const dependencies = { ...manifest.dependencies.direct, ...manifest.dependencies.indirect };

    for (const [name, version] of Object.entries(dependencies)) {
      const docsPath = join(elmHome, manifest["elm-version"], "packages", name, version, "docs.json");

      if (!existsSync(docsPath)) continue;

      const docs: PackageModule[] = yield* attempt(docsPath, () => JSON.parse(readFileSync(docsPath, "utf8")));

      for (const module of docs) packages.set(module.name, module);
    }

    return new Project(directory, modules, packages);
  });
}
