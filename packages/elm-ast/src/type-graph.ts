import { Data, Effect } from "effect";
import type { Type } from "./index.ts";
import type { Project, ProjectLookupError, ResolvedType } from "./project.ts";

/** A declaration reachable from a concrete Elm boundary type. */
export type TypeNode = {
  key: string;
  definition: ResolvedType;
  dependencies: string[];
};

/** A type that cannot be represented across a component boundary. */
export class TypeGraphError extends Data.TaggedError("TypeGraphError")<{
  module: string;
  message: string;
}> {}

const primitives = new Set(["String", "Bool", "Int", "Float"]);

const containers = new Map([["Maybe", 1], ["List", 1], ["Result", 2]]);

/** Find every declaration needed to represent concrete types across an Elm boundary. */
export function collectTypeGraph(project: Project, fromModule: string, roots: Type[]): Effect.Effect<Map<string, TypeNode>, TypeGraphError | ProjectLookupError> {
  return Effect.gen(function* () {
    const found = new Map<string, TypeNode>();
    const visiting = new Set<string>();

    function invalid(currentModule: string, message: string): Effect.Effect<never, TypeGraphError> {
      return Effect.fail(new TypeGraphError({ module: currentModule, message: `${currentModule}: ${message}` }));
    }

    function visit(type: Type, currentModule: string, variables: Set<string>, dependencies: Set<string>): Effect.Effect<void, TypeGraphError | ProjectLookupError> {
      return Effect.gen(function* () {
        switch (type.kind) {
          case "unit": return;
          case "variable":
            if (!variables.has(type.name)) return yield* invalid(currentModule, `unbound type variable ${type.name}`);

            return;
          case "function": return yield* invalid(currentModule, "functions cannot cross a component boundary");
          case "record":
            if (type.extension) return yield* invalid(currentModule, "extensible records cannot cross a component boundary");

            for (const field of type.fields) yield* visit(field.type, currentModule, variables, dependencies);

            return;
          case "tuple":
            for (const item of type.items) yield* visit(item, currentModule, variables, dependencies);

            return;
          case "named": {
            const qualified = type.module.join(".");

            const primitive = (qualified === "" && primitives.has(type.name))
              || (qualified === "String" && type.name === "String")
              || (qualified === "Basics" && ["Bool", "Int", "Float"].includes(type.name));

            if (primitive) {
              if (type.arguments.length) return yield* invalid(currentModule, `${type.name} takes no type arguments`);

              return;
            }

            const arity = containers.get(type.name);

            if (arity !== undefined && (qualified === "" || qualified === type.name)) {
              if (type.arguments.length !== arity) return yield* invalid(currentModule, `${type.name} needs ${arity} type argument${arity === 1 ? "" : "s"}`);

              for (const argument of type.arguments) yield* visit(argument, currentModule, variables, dependencies);

              return;
            }

            for (const argument of type.arguments) yield* visit(argument, currentModule, variables, dependencies);
            const definition = yield* project.resolveType(currentModule, type);
            const key = `${definition.module}.${definition.name}`;
            dependencies.add(key);
            const expected = definition.declaration.parameters.length;

            if (type.arguments.length !== expected) return yield* invalid(currentModule, `${key} needs ${expected} type argument${expected === 1 ? "" : "s"}`);

            if (!definition.constructorsVisible) return yield* invalid(currentModule, `expose ${key} constructors for generated codecs`);

            if (found.has(key) || visiting.has(key)) return;

            visiting.add(key);
            const nested = new Set<string>();
            const parameters = new Set(definition.declaration.parameters);

            if (definition.declaration.kind === "alias") {
              yield* visit(definition.declaration.type, definition.module, parameters, nested);
            } else {
              for (const constructor of definition.declaration.constructors) {
                for (const argument of constructor.arguments) yield* visit(argument, definition.module, parameters, nested);
              }
            }

            visiting.delete(key);
            found.set(key, { key, definition, dependencies: [...nested].sort() });
          }
        }
      });
    }

    const rootDependencies = new Set<string>();

    for (const root of roots) yield* visit(root, fromModule, new Set(), rootDependencies);

    return new Map([...found].sort(([left], [right]) => left.localeCompare(right)));
  });
}
