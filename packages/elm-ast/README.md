# Elm AST for TypeScript

This 0.1.0 preview parses Elm module headers, imports, type aliases, unions, and type annotations into TypeScript values. It follows imports across project modules and installed package docs, including recursive types. It can also print Elm declarations from a typed expression tree and add the imports those declarations use.

Install it with `npm install @n1kben/elm-ast effect`.

```ts
import { openProject } from "@n1kben/elm-ast/project";
import { Effect } from "effect";

const project = Effect.runSync(openProject("."));
const component = Effect.runSync(project.module("Ui.DatePicker"));
const input = component.declarations.find((item) => item.kind === "alias" && item.name === "Input");
```

`openProject` reads `elm.json`, indexes the source directories, and loads installed package docs from `ELM_HOME` when the Effect runs. File and parse failures return `ProjectError`. Missing or ambiguous declarations return `ProjectLookupError` from `module` and `resolveType`. `collectTypeGraph` follows the declarations needed by concrete boundary types and returns `TypeGraphError` for unsupported types.

For generated source, use `createModule`, `ref`, and `printModule` from `@n1kben/elm-ast/emit`. The printer adds imports referenced by expressions and types. `typeModuleFromParsed` copies parsed type declarations for inspection or rewriting; it does not copy functions or comments. Parsed function bodies remain source text. Generated function bodies use the expression AST, which covers the constructs needed by the current codec generator rather than all Elm expressions. Check generated output with the Elm compiler.

[Elm web components](https://github.com/n1kben/elm-web-components) is testing these APIs for a future TypeScript generator. Its CLI still uses an Elm generator.

This repository also has an experimental codec generator in `tool/type-codec.ts`. It handles recursive unions and package records. Runtime tests round-trip recursive trees and records containing lists, tuples, unit, `Maybe`, and `Result`. It does not create component host modules or adapters yet.
