import type { Type } from "./index.ts";
import type { Project, ResolvedType } from "./project.ts";

export type TypeNode = {
  key: string;
  definition: ResolvedType;
  dependencies: string[];
};

const primitives = new Set(["String", "Bool", "Int", "Float"]);

const containers = new Map([["Maybe", 1], ["List", 1], ["Result", 2]]);

/** Find every declaration needed to represent concrete types across an Elm boundary. */
export function collectTypeGraph(project: Project, fromModule: string, roots: Type[]): Map<string, TypeNode> {
  const found = new Map<string, TypeNode>();
  const visiting = new Set<string>();

  function visit(type: Type, currentModule: string, variables: Set<string>, dependencies: Set<string>): void {
    switch (type.kind) {
      case "unit": return;
      case "variable":
        if (!variables.has(type.name)) throw new Error(`${currentModule}: unbound type variable ${type.name}`);

        return;
      case "function": throw new Error(`${currentModule}: functions cannot cross a component boundary`);
      case "record":
        if (type.extension) throw new Error(`${currentModule}: extensible records cannot cross a component boundary`);

        for (const field of type.fields) visit(field.type, currentModule, variables, dependencies);

        return;
      case "tuple":
        for (const item of type.items) visit(item, currentModule, variables, dependencies);

        return;
      case "named": {
        const qualified = type.module.join(".");

        if ((qualified === "" || qualified === "Basics" || qualified === "String") && primitives.has(type.name)) {
          if (type.arguments.length) throw new Error(`${currentModule}: ${type.name} takes no type arguments`);

          return;
        }

        const arity = containers.get(type.name);

        if (arity !== undefined && (qualified === "" || qualified === type.name)) {
          if (type.arguments.length !== arity) throw new Error(`${currentModule}: ${type.name} needs ${arity} type argument${arity === 1 ? "" : "s"}`);

          for (const argument of type.arguments) visit(argument, currentModule, variables, dependencies);

          return;
        }

        for (const argument of type.arguments) visit(argument, currentModule, variables, dependencies);
        const definition = project.resolveType(currentModule, type);
        const key = `${definition.module}.${definition.name}`;
        dependencies.add(key);
        const expected = definition.declaration.parameters.length;

        if (type.arguments.length !== expected) throw new Error(`${currentModule}: ${key} needs ${expected} type argument${expected === 1 ? "" : "s"}`);

        if (!definition.constructorsVisible) throw new Error(`${currentModule}: expose ${key} constructors for generated codecs`);

        if (found.has(key) || visiting.has(key)) return;

        visiting.add(key);
        const nested = new Set<string>();
        const parameters = new Set(definition.declaration.parameters);

        if (definition.declaration.kind === "alias") {
          visit(definition.declaration.type, definition.module, parameters, nested);
        } else {
          for (const constructor of definition.declaration.constructors) {
            for (const argument of constructor.arguments) visit(argument, definition.module, parameters, nested);
          }
        }

        visiting.delete(key);
        found.set(key, { key, definition, dependencies: [...nested].sort() });
      }
    }
  }

  const rootDependencies = new Set<string>();

  for (const root of roots) visit(root, fromModule, new Set(), rootDependencies);

  return new Map([...found].sort(([left], [right]) => left.localeCompare(right)));
}
