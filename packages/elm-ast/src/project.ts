import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Data, Effect, Schema } from "effect";
import { type Declaration, type ElmModule, type Exposure, type Type, parseModule, parseTypeAnnotation } from "./index.ts";

/** A file or parse failure while opening an Elm project. */
export class ProjectError extends Data.TaggedError("ProjectError")<{
  path: string;
  message: string;
}> {}

/** A missing or ambiguous declaration requested from an Elm project. */
export class ProjectLookupError extends Data.TaggedError("ProjectLookupError")<{
  module: string;
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

const ElmApplicationSchema = Schema.Struct({
  type: Schema.Literal("application"),
  "elm-version": Schema.String,
  "source-directories": Schema.Array(Schema.String),
  dependencies: Schema.Struct({
    direct: Schema.Record({ key: Schema.String, value: Schema.String }),
    indirect: Schema.Record({ key: Schema.String, value: Schema.String }),
  }),
});

const PackageModuleSchema = Schema.Struct({
  name: Schema.String,
  aliases: Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.Array(Schema.String), type: Schema.String })),
  unions: Schema.Array(Schema.Struct({
    name: Schema.String,
    args: Schema.Array(Schema.String),
    cases: Schema.Array(Schema.Tuple(Schema.String, Schema.Array(Schema.String))),
  })),
});

type PackageModule = typeof PackageModuleSchema.Type;

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];

  const paths: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "elm-stuff") continue;
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

  if (alias) return { kind: "alias", name, parameters: [...alias.args], type: parseTypeAnnotation(alias.type), range };
  const union = module.unions.find((item) => item.name === name);

  if (!union) return undefined;

  return {
    kind: "union",
    name,
    parameters: [...union.args],
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

  /** Find a source module, or return a typed lookup error. */
  module(name: string): Effect.Effect<ElmModule, ProjectLookupError> {
    const entry = this.modules.get(name);

    if (!entry) return Effect.fail(new ProjectLookupError({ module: name, message: `unknown project module ${name}` }));

    return Effect.succeed(entry.ast);
  }

  /** Resolve a named type through local declarations, imports, and package docs. */
  resolveType(fromModule: string, reference: Extract<Type, { kind: "named" }>): Effect.Effect<ResolvedType, ProjectLookupError> {
    return Effect.gen(this, function* () {
      const from = this.modules.get(fromModule)?.ast;

      if (!from && !this.packages.has(fromModule)) {
        return yield* Effect.fail(new ProjectLookupError({ module: fromModule, message: `unknown module ${fromModule}` }));
      }

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

        const declaration = yield* Effect.try({
          try: () => packageDeclaration(packageModule, reference.name),
          catch: (error) => new ProjectLookupError({
            module: moduleName,
            message: `invalid package type ${moduleName}.${reference.name}: ${error instanceof Error ? error.message : String(error)}`,
          }),
        });

        if (declaration) found.push({ module: moduleName, name: reference.name, declaration, constructorsVisible: declaration.kind === "alias" || declaration.constructors.length > 0 });
      }

      if (found.length === 1) return found[0]!;

      if (found.length > 1) {
        return yield* Effect.fail(new ProjectLookupError({ module: fromModule, message: `${fromModule}: ambiguous type ${reference.name} from ${found.map((item) => item.module).join(", ")}` }));
      }

      return yield* Effect.fail(new ProjectLookupError({ module: fromModule, message: `${fromModule}: cannot resolve type ${[qualifier, reference.name].filter(Boolean).join(".")}` }));
    });
  }
}

/** Read project modules and installed package docs when the returned Effect runs. */
export function openProject(root: string, elmHome = process.env.ELM_HOME ?? join(homedir(), ".elm")): Effect.Effect<Project, ProjectError> {
  return Effect.gen(function* () {
    const directory = resolve(root);
    const manifestPath = join(directory, "elm.json");
    const manifestJson: unknown = yield* attempt(manifestPath, () => JSON.parse(readFileSync(manifestPath, "utf8")));

    const manifest = yield* Schema.decodeUnknown(ElmApplicationSchema)(manifestJson).pipe(
      Effect.mapError((error) => new ProjectError({ path: manifestPath, message: `invalid Elm application: ${error.message}` })),
    );

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

      const docsJson: unknown = yield* attempt(docsPath, () => JSON.parse(readFileSync(docsPath, "utf8")));

      const docs = yield* Schema.decodeUnknown(Schema.Array(PackageModuleSchema))(docsJson).pipe(
        Effect.mapError((error) => new ProjectError({ path: docsPath, message: `invalid package docs: ${error.message}` })),
      );

      for (const module of docs) packages.set(module.name, module);
    }

    return new Project(directory, modules, packages);
  });
}
