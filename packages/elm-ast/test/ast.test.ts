import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Effect, Either } from "effect";
import { type Expression, createModule, local, printModule, printTypeAnnotation, ref, typeModuleFromParsed } from "../src/emit.ts";
import { type Type, parseModule, parseTypeAnnotation } from "../src/index.ts";
import { Project, openProject } from "../src/project.ts";
import { collectTypeGraph } from "../src/type-graph.ts";
import { generateCodecs } from "../../../tool/type-codec.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function expectFailure<A, E extends { message: string }>(operation: Effect.Effect<A, E>, pattern: RegExp): void {
  const result = Effect.runSync(Effect.either(operation));
  assert.ok(Either.isLeft(result));
  assert.match(result.left.message, pattern);
}

test("parses imported recursive unions and comments", () => {
  const source = readFileSync(join(root, "test/fixtures/Ui/ImportedTree.elm"), "utf8");
  const file = parseModule(source);
  assert.equal(file.name, "Ui.ImportedTree");
  assert.deepEqual(file.imports.find((item) => item.module === "Data.Tree")?.exposing, [{ name: "Tree", kind: "type", constructors: false }]);
  const input = file.declarations.find((item) => item.kind === "alias" && item.name === "Input");
  assert.ok(input?.kind === "alias");
  assert.deepEqual(input.type, { kind: "record", fields: [{ name: "tree", type: { kind: "named", module: [], name: "Tree", arguments: [{ kind: "named", module: [], name: "String", arguments: [] }] } }] });
  assert.deepEqual(parseTypeAnnotation("Tree (Maybe String)"), { kind: "named", module: [], name: "Tree", arguments: [{ kind: "named", module: [], name: "Maybe", arguments: [{ kind: "named", module: [], name: "String", arguments: [] }] }] });
  const component = file.declarations.find((item) => item.kind === "value" && item.name === "component");
  assert.ok(component?.kind === "value");
  assert.equal(component.head, "Component.define");
});

test("type parser follows Elm tuple and record syntax", () => {
  assert.deepEqual(parseTypeAnnotation("{ row | value : Maybe (List Int) }"), {
    kind: "record",
    extension: "row",
    fields: [{ name: "value", type: { kind: "named", module: [], name: "Maybe", arguments: [{ kind: "named", module: [], name: "List", arguments: [{ kind: "named", module: [], name: "Int", arguments: [] }] }] } }],
  });
  assert.throws(() => parseTypeAnnotation("( )"), /unit type must be/);
  assert.throws(() => parseTypeAnnotation("(Int, String, Bool, Float)"), /at most three/);
  assert.throws(() => parseTypeAnnotation("{ row | }"), /need a field/);
  const parenthesized = parseTypeAnnotation("(Data.Tree { left : Int }) -> String");
  assert.ok(parenthesized.kind === "function");
  assert.deepEqual(parenthesized.argument, {
    kind: "named",
    module: ["Data"],
    name: "Tree",
    arguments: [{ kind: "record", fields: [{ name: "left", type: { kind: "named", module: [], name: "Int", arguments: [] } }] }],
  });

  for (const source of [
    "Tree (Maybe String)",
    "(Data.Tree { left : Int }) -> String",
    "{ left : Tree a, right : Result String (List Int) }",
    "( Int, { a : String }, Maybe Float )",
    "(a -> b) -> List b",
    "{ row | value : Maybe (List Int) }",
  ]) {
    const parsed = parseTypeAnnotation(source);
    assert.deepEqual(parseTypeAnnotation(printTypeAnnotation(parsed)), parsed);
  }
});

test("parses effect headers and multi-character exposed operators", () => {
  const effect = parseModule("effect module Task where { command = MyCmd } exposing (Task, (<<), (//))\nimport List exposing ((::))\ntype Task a = Task a\n");
  assert.equal(effect.kind, "effect module");
  assert.deepEqual(effect.effect, { command: "MyCmd" });
  assert.deepEqual(effect.exposing, [
    { name: "Task", kind: "type", constructors: false },
    { name: "<<", kind: "operator", constructors: false },
    { name: "//", kind: "operator", constructors: false },
  ]);
  assert.deepEqual(effect.imports[0]?.exposing, [{ name: "::", kind: "operator", constructors: false }]);
});

test("copying types removes exposures for omitted values", () => {
  const parsed = parseModule("module Example exposing (T, value)\ntype alias T = Int\nvalue = 1\n");
  const source = printModule(typeModuleFromParsed(parsed));
  assert.match(source, /module Example exposing \(T\)/);
  assert.doesNotMatch(source, /exposing \([^)]*value/);
});

test("constructor patterns are grouped in generated function and lambda arguments", () => {
  const module = createModule("Generated.Pattern");
  const pattern = { kind: "constructor" as const, reference: local("Box"), arguments: [{ kind: "variable" as const, name: "value" }] };
  module.declarations.push({ kind: "union", name: "Box", parameters: ["a"], constructors: [{ name: "Box", arguments: [{ kind: "variable", name: "a" }] }] });
  module.declarations.push({ kind: "function", name: "unwrap", arguments: [pattern], body: local("value") });
  module.declarations.push({ kind: "function", name: "unwrapLambda", arguments: [], body: { kind: "lambda", arguments: [pattern], body: local("value") } });
  const source = printModule(module);
  assert.match(source, /unwrap \(Box value\) =/);
  assert.match(source, /\\\(Box value\) ->/);

  const projectRoot = mkdtempSync(join(tmpdir(), "elm-ast-pattern-"));
  mkdirSync(join(projectRoot, "src/Generated"), { recursive: true });
  const elmJson = JSON.parse(readFileSync(join(root, "examples/components/elm.json"), "utf8"));
  elmJson["source-directories"] = ["src"];
  writeFileSync(join(projectRoot, "elm.json"), JSON.stringify(elmJson));
  writeFileSync(join(projectRoot, "src/Generated/Pattern.elm"), source);

  try {
    const elm = fileURLToPath(new URL("../../../node_modules/.bin/elm", import.meta.url));
    const result = spawnSync(elm, ["make", "src/Generated/Pattern.elm", "--output=/dev/null"], { cwd: projectRoot, env: { ...process.env, ELM_HOME: join(root, ".elm-home") }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr + source);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("round-trips 5000 generated type ASTs", () => {
  let seed = 2537;

  const random = (limit: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;

    return seed % limit;
  };

  const leaf = (): Type => random(2) ? { kind: "variable", name: "a" } : { kind: "named", module: [], name: "Int", arguments: [] };

  const generate = (depth: number): Type => {
    if (depth === 0) return leaf();

    switch (random(6)) {
      case 0: return leaf();
      case 1: return { kind: "named", module: [], name: "Maybe", arguments: [generate(depth - 1)] };
      case 2: return { kind: "record", fields: [{ name: "left", type: generate(depth - 1) }, { name: "right", type: generate(depth - 1) }] };
      case 3: return { kind: "tuple", items: [generate(depth - 1), generate(depth - 1)] };
      case 4: return { kind: "function", argument: generate(depth - 1), result: generate(depth - 1) };
      default: return { kind: "named", module: ["Data"], name: "Tree", arguments: [generate(depth - 1)] };
    }
  };

  for (let index = 0; index < 5000; index++) {
    const type = generate(4);
    assert.deepEqual(parseTypeAnnotation(printTypeAnnotation(type)), type, `case ${index}`);
  }
});

test("Elm compiles 80 generated nested type aliases", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "elm-ast-types-"));
  mkdirSync(join(projectRoot, "src/Generated"), { recursive: true });
  const elmJson = JSON.parse(readFileSync(join(root, "examples/components/elm.json"), "utf8"));
  elmJson["source-directories"] = ["src"];
  writeFileSync(join(projectRoot, "elm.json"), JSON.stringify(elmJson));
  let seed = 7181;

  const random = (limit: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;

    return seed % limit;
  };

  const leaf = (): Type => ({ kind: "named", module: [], name: ["Int", "String", "Bool"][random(3)]!, arguments: [] });

  const generate = (depth: number): Type => {
    if (depth === 0) return leaf();

    switch (random(6)) {
      case 0: return leaf();
      case 1: return { kind: "named", module: [], name: "Maybe", arguments: [generate(depth - 1)] };
      case 2: return { kind: "named", module: [], name: "List", arguments: [generate(depth - 1)] };
      case 3: return { kind: "tuple", items: [generate(depth - 1), generate(depth - 1)] };
      case 4: return { kind: "record", fields: [{ name: "left", type: generate(depth - 1) }, { name: "right", type: generate(depth - 1) }] };
      default: return { kind: "function", argument: generate(depth - 1), result: generate(depth - 1) };
    }
  };

  const module = createModule("Generated.Types");

  for (let index = 0; index < 80; index++) {
    module.declarations.push({ kind: "alias", name: `Type${index}`, parameters: [], type: generate(3) });
  }

  const output = printModule(module);
  writeFileSync(join(projectRoot, "src/Generated/Types.elm"), output);

  try {
    const elm = fileURLToPath(new URL("../../../node_modules/.bin/elm", import.meta.url));
    const result = spawnSync(elm, ["make", "src/Generated/Types.elm", "--output=/dev/null"], { cwd: projectRoot, env: { ...process.env, ELM_HOME: join(root, ".elm-home") }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr + output);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("project loading is deferred and reports typed file errors", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "elm-ast-effect-"));
  const load = openProject(projectRoot, join(root, ".elm-home"));
  const manifestPath = join(projectRoot, "elm.json");

  try {
    const missing = Effect.runSync(Effect.either(load));
    assert.ok(Either.isLeft(missing));
    assert.equal(missing.left._tag, "ProjectError");
    assert.equal(missing.left.path, manifestPath);

    writeFileSync(manifestPath, JSON.stringify({ type: "application" }));
    const malformed = Effect.runSync(Effect.either(load));
    assert.ok(Either.isLeft(malformed));
    assert.equal(malformed.left.path, manifestPath);
    assert.match(malformed.left.message, /invalid Elm application/);

    mkdirSync(join(projectRoot, "src"));
    mkdirSync(join(projectRoot, "src/WebComponents"));
    writeFileSync(manifestPath, JSON.stringify({ type: "application", "elm-version": "0.19.1", "source-directories": ["src"], dependencies: { direct: {}, indirect: {} } }));
    writeFileSync(join(projectRoot, "src/WebComponents/Handwritten.elm"), "module WebComponents.Handwritten exposing (Flag)\ntype alias Flag = Bool\n");
    const loaded = Effect.runSync(load);
    assert.equal(loaded.root, projectRoot);
    assert.equal(Effect.runSync(loaded.module("WebComponents.Handwritten")).name, "WebComponents.Handwritten");
    expectFailure(loaded.module("Missing"), /unknown project module/);

    const sourcePath = join(projectRoot, "src/Broken.elm");
    writeFileSync(sourcePath, "this is not an Elm module");
    const invalidSource = Effect.runSync(Effect.either(load));
    assert.ok(Either.isLeft(invalidSource));
    assert.equal(invalidSource.left.path, sourcePath);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("rejects malformed package docs through the Effect error channel", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "elm-ast-docs-"));
  const docsPath = join(projectRoot, ".elm-home/0.19.1/packages/example/pkg/1.0.0/docs.json");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  mkdirSync(join(projectRoot, ".elm-home/0.19.1/packages/example/pkg/1.0.0"), { recursive: true });
  writeFileSync(join(projectRoot, "elm.json"), JSON.stringify({
    type: "application", "elm-version": "0.19.1", "source-directories": ["src"],
    dependencies: { direct: { "example/pkg": "1.0.0" }, indirect: {} },
  }));

  try {
    for (const docs of ["{}", '[{"name":"Example"}]']) {
      writeFileSync(docsPath, docs);
      const result = Effect.runSync(Effect.either(openProject(projectRoot, join(projectRoot, ".elm-home"))));
      assert.ok(Either.isLeft(result));
      assert.equal(result.left.path, docsPath);
      assert.match(result.left.message, /invalid package docs/);
    }

    writeFileSync(docsPath, '[{"name":"Example","aliases":[{"name":"Broken","args":[],"type":"???"}],"unions":[]}]');
    const project = Effect.runSync(openProject(projectRoot, join(projectRoot, ".elm-home")));
    expectFailure(project.resolveType("Example", { kind: "named", module: ["Example"], name: "Broken", arguments: [] }), /invalid package type/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("collects recursive project types from parsed component input", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "elm-ast-graph-"));
  mkdirSync(join(projectRoot, "src/Ui"), { recursive: true });
  mkdirSync(join(projectRoot, "src/Data"), { recursive: true });
  cpSync(join(root, "test/fixtures/Ui/ImportedTree.elm"), join(projectRoot, "src/Ui/ImportedTree.elm"));
  cpSync(join(root, "test/fixtures/Data/Tree.elm"), join(projectRoot, "src/Data/Tree.elm"));
  const elmJson = JSON.parse(readFileSync(join(root, "examples/components/elm.json"), "utf8"));
  elmJson["source-directories"] = ["src"];
  writeFileSync(join(projectRoot, "elm.json"), JSON.stringify(elmJson));

  try {
    const project = Effect.runSync(openProject(projectRoot, join(root, ".elm-home")));
    const input = Effect.runSync(project.module("Ui.ImportedTree")).declarations.find((item) => item.kind === "alias" && item.name === "Input");
    assert.ok(input?.kind === "alias");
    const graph = Effect.runSync(collectTypeGraph(project, "Ui.ImportedTree", [input.type]));
    assert.deepEqual([...graph.keys()], ["Data.Tree.Tree"]);
    assert.deepEqual(graph.get("Data.Tree.Tree")?.dependencies, ["Data.Tree.Tree"]);
    assert.equal(graph.get("Data.Tree.Tree")?.definition.declaration.kind, "union");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("rejects hidden, ambiguous, and incorrectly applied boundary types", () => {
  const modules = new Map([
    ["A", { path: "A.elm", ast: parseModule("module A exposing (Tree(..), Shared)\ntype Tree a = Leaf a | Branch (Tree a)\ntype alias Shared = Int\n") }],
    ["B", { path: "B.elm", ast: parseModule("module B exposing (Shared)\ntype alias Shared = String\n") }],
    ["Ui.Host", { path: "Ui/Host.elm", ast: parseModule("module Ui.Host exposing (Input)\nimport A exposing (Tree, Shared)\nimport B exposing (Shared)\ntype alias Hidden = { value : Int }\ntype alias Input = { tree : Tree String }\n") }],
  ]);

  const project = new Project(".", modules, new Map());
  const named = (name: string, args: Type[] = []): Type => ({ kind: "named", module: [], name, arguments: args });
  assert.deepEqual([...Effect.runSync(collectTypeGraph(project, "Ui.Host", [named("Tree", [named("String")])])).keys()], ["A.Tree"]);
  expectFailure(collectTypeGraph(project, "Ui.Host", [named("Tree")]), /needs 1 type argument/);
  expectFailure(collectTypeGraph(project, "Ui.Host", [named("Shared")]), /ambiguous type Shared/);
  expectFailure(collectTypeGraph(project, "Ui.Host", [named("Hidden")]), /expose Ui.Host.Hidden/);
  expectFailure(collectTypeGraph(project, "Ui.Host", [{ kind: "function", argument: named("Int"), result: named("Int") }]), /functions cannot cross/);
  expectFailure(collectTypeGraph(project, "Ui.Host", [{ kind: "record", extension: "row", fields: [{ name: "value", type: named("Int") }] }]), /extensible records cannot cross/);
  expectFailure(collectTypeGraph(project, "Ui.Host", [{ kind: "variable", name: "a" }]), /unbound type variable/);
});

test("resolves project and package types through imports", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "elm-ast-project-"));
  mkdirSync(join(projectRoot, "src/Ui"), { recursive: true });
  mkdirSync(join(projectRoot, "src/Data"), { recursive: true });
  cpSync(join(root, "test/fixtures/Ui/ImportedTree.elm"), join(projectRoot, "src/Ui/ImportedTree.elm"));
  cpSync(join(root, "test/fixtures/Data/Tree.elm"), join(projectRoot, "src/Data/Tree.elm"));
  cpSync(join(root, "test/fixtures/Ui/PackageUrl.elm"), join(projectRoot, "src/Ui/PackageUrl.elm"));
  const elmJson = JSON.parse(readFileSync(join(root, "examples/components/elm.json"), "utf8"));
  elmJson["source-directories"] = ["src"];
  writeFileSync(join(projectRoot, "elm.json"), JSON.stringify(elmJson));

  try {
    const project = Effect.runSync(openProject(projectRoot, join(root, ".elm-home")));
    const tree = Effect.runSync(project.resolveType("Ui.ImportedTree", { kind: "named", module: [], name: "Tree", arguments: [] }));
    assert.equal(tree.module, "Data.Tree");
    assert.equal(tree.declaration.kind, "union");
    assert.equal(tree.constructorsVisible, true);
    const url = Effect.runSync(project.resolveType("Ui.PackageUrl", { kind: "named", module: ["Url"], name: "Url", arguments: [] }));
    assert.equal(url.module, "Url");
    assert.equal(url.declaration.kind, "alias");
    const urlInput = Effect.runSync(project.module("Ui.PackageUrl")).declarations.find((item) => item.kind === "alias" && item.name === "Input");
    assert.ok(urlInput?.kind === "alias");
    assert.deepEqual([...Effect.runSync(collectTypeGraph(project, "Ui.PackageUrl", [urlInput.type])).keys()], ["Url.Protocol", "Url.Url"]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("prints a generated recursive codec with imports and compiles it", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "elm-ast-codec-"));
  mkdirSync(join(projectRoot, "src/Generated"), { recursive: true });
  mkdirSync(join(projectRoot, "src/Data"), { recursive: true });
  const treeSource = readFileSync(join(root, "test/fixtures/Data/Tree.elm"), "utf8");
  const treeOutput = printModule(typeModuleFromParsed(parseModule(treeSource)));
  assert.match(treeOutput, /type Tree a/);
  writeFileSync(join(projectRoot, "src/Data/Tree.elm"), treeOutput);
  const elmJson = JSON.parse(readFileSync(join(root, "examples/components/elm.json"), "utf8"));
  elmJson["source-directories"] = ["src"];
  writeFileSync(join(projectRoot, "elm.json"), JSON.stringify(elmJson));

  const generated = createModule("Generated.Codec", ["encodeTree", "decodeTree"]);
  const call = (module: string, name: string, args: Expression[]): Expression => ({ kind: "apply", function: ref(module, name), arguments: args });
  const localCall = (name: string, args: Expression[]): Expression => ({ kind: "apply", function: local(name), arguments: args });
  const encodeA = local("encodeA");
  const item = local("item");
  const left = local("left");
  const right = local("right");
  const encode = local("encodeTree");

  const encodedBranch: Expression = {
    kind: "apply",
    function: ref("Json.Encode", "list"),
    arguments: [local("identity"), { kind: "list", items: [
      { kind: "apply", function: encode, arguments: [encodeA, left] },
      { kind: "apply", function: encode, arguments: [encodeA, right] },
    ] }],
  };

  generated.declarations.push({
    kind: "function",
    name: "encodeTree",
    arguments: [{ kind: "variable", name: "encodeA" }, { kind: "variable", name: "value" }],
    body: {
      kind: "case",
      value: local("value"),
      branches: [
        { pattern: { kind: "constructor", reference: ref("Data.Tree", "Leaf"), arguments: [{ kind: "variable", name: "item" }] }, body: { kind: "apply", function: encodeA, arguments: [item] } },
        { pattern: { kind: "constructor", reference: ref("Data.Tree", "Branch"), arguments: [{ kind: "variable", name: "left" }, { kind: "variable", name: "right" }] }, body: encodedBranch },
      ],
    },
  });

  const decodeA = local("decodeA");

  const decodeArg = (index: number, decoder: Expression): Expression =>
    call("Json.Decode", "at", [
      { kind: "list", items: [{ kind: "string", value: "args" }] },
      call("Json.Decode", "index", [{ kind: "integer", value: index }, decoder]),
    ]);

  generated.declarations.push({
    kind: "function",
    name: "decodeTree",
    arguments: [{ kind: "variable", name: "decodeA" }],
    body: call("Json.Decode", "lazy", [{
      kind: "lambda",
      arguments: [{ kind: "wildcard" }],
      body: call("Json.Decode", "andThen", [
        {
          kind: "lambda",
          arguments: [{ kind: "variable", name: "tag" }],
          body: {
            kind: "case",
            value: local("tag"),
            branches: [
              {
                pattern: { kind: "string", value: "leaf" },
                body: call("Json.Decode", "map", [ref("Data.Tree", "Leaf"), decodeArg(0, decodeA)]),
              },
              {
                pattern: { kind: "string", value: "branch" },
                body: call("Json.Decode", "map2", [
                  ref("Data.Tree", "Branch"),
                  decodeArg(0, localCall("decodeTree", [decodeA])),
                  decodeArg(1, localCall("decodeTree", [decodeA])),
                ]),
              },
              { pattern: { kind: "wildcard" }, body: call("Json.Decode", "fail", [{ kind: "string", value: "unknown tree constructor" }]) },
            ],
          },
        },
        call("Json.Decode", "field", [{ kind: "string", value: "type" }, ref("Json.Decode", "string")]),
      ]),
    }]),
  });

  const output = printModule(generated);
  assert.match(output, /import Data\.Tree/);
  assert.match(output, /import Json\.Encode/);
  assert.match(output, /import Json\.Decode/);
  assert.equal(output, printModule(generated));
  writeFileSync(join(projectRoot, "src/Generated/Codec.elm"), output);
  writeFileSync(join(projectRoot, "src/Main.elm"), "module Main exposing (main)\nimport Data.Tree\nimport Generated.Codec\nimport Html\nimport Json.Decode\nimport Json.Encode\nmain = Html.text (case Json.Decode.decodeString (Generated.Codec.decodeTree Json.Decode.string) (Json.Encode.encode 0 (Generated.Codec.encodeTree Json.Encode.string (Data.Tree.Leaf \"hello\"))) of\n    Ok _ -> \"ok\"\n    Err _ -> \"error\")\n");

  try {
    const elm = fileURLToPath(new URL("../../../node_modules/.bin/elm", import.meta.url));
    const result = spawnSync(elm, ["make", "src/Main.elm", "--output=dist.js"], { cwd: projectRoot, env: { ...process.env, ELM_HOME: join(root, ".elm-home") }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr + output);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("round-trips a parsed recursive imported union through compiled Elm", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "elm-ast-generated-codec-"));
  mkdirSync(join(projectRoot, "src/Ui"), { recursive: true });
  mkdirSync(join(projectRoot, "src/Data"), { recursive: true });
  mkdirSync(join(projectRoot, "src/Generated"), { recursive: true });
  cpSync(join(root, "test/fixtures/Ui/ImportedTree.elm"), join(projectRoot, "src/Ui/ImportedTree.elm"));
  cpSync(join(root, "test/fixtures/Data/Tree.elm"), join(projectRoot, "src/Data/Tree.elm"));
  const elmJson = JSON.parse(readFileSync(join(root, "examples/components/elm.json"), "utf8"));
  elmJson["source-directories"] = ["src"];
  writeFileSync(join(projectRoot, "elm.json"), JSON.stringify(elmJson));

  try {
    const project = Effect.runSync(openProject(projectRoot, join(root, ".elm-home")));
    const input = Effect.runSync(project.module("Ui.ImportedTree")).declarations.find((item) => item.kind === "alias" && item.name === "Input");
    assert.ok(input?.kind === "alias");
    const graph = Effect.runSync(collectTypeGraph(project, "Ui.ImportedTree", [input.type]));
    const output = printModule(generateCodecs("Generated.Codec", graph));
    assert.match(output, /encodeData_Tree_Tree/);
    assert.match(output, /decodeData_Tree_Tree/);
    writeFileSync(join(projectRoot, "src/Generated/Codec.elm"), output);
    writeFileSync(join(projectRoot, "src/Main.elm"), [
      "port module Main exposing (main)",
      "import Generated.Codec",
      "import Json.Decode as Decode",
      "import Json.Encode as Encode",
      "import Platform",
      "import Platform.Cmd as Cmd",
      "port request : (String -> msg) -> Sub msg",
      "port response : String -> Cmd msg",
      "type Msg = Got String",
      "main : Platform.Program () () Msg",
      "main = Platform.worker { init = \\_ -> ( (), Cmd.none ), update = update, subscriptions = \\_ -> request Got }",
      "update (Got raw) model =",
      "    ( model",
      "    , response (case Decode.decodeString (Generated.Codec.decodeData_Tree_Tree Decode.string) raw of",
      "        Ok value -> Encode.encode 0 (Generated.Codec.encodeData_Tree_Tree Encode.string value)",
      "        Err error -> Decode.errorToString error)",
      "    )",
      "",
    ].join("\n"));
    const elm = fileURLToPath(new URL("../../../node_modules/.bin/elm", import.meta.url));
    const result = spawnSync(elm, ["make", "src/Main.elm", "--output=dist.js"], { cwd: projectRoot, env: { ...process.env, ELM_HOME: join(root, ".elm-home") }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr + output);

    type TreeScope = {
      Elm?: { Main: { init: () => { ports: { request: { send: (value: string) => void }; response: { subscribe: (callback: (value: string) => void) => void } } } } };
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
    };

    const scope: TreeScope = { setTimeout, clearTimeout };
    vm.runInNewContext(readFileSync(join(projectRoot, "dist.js"), "utf8"), scope);
    assert.ok(scope.Elm);
    const app = scope.Elm.Main.init();

    const tree = { type: "branch", args: [
      { type: "leaf", args: ["one"] },
      { type: "branch", args: [{ type: "leaf", args: ["two"] }, { type: "leaf", args: ["three"] }] },
    ] };

    await new Promise<void>((resolve, reject) => {
      app.ports.response.subscribe((value) => {
        try {
          assert.deepEqual(JSON.parse(value), tree);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      app.ports.request.send(JSON.stringify(tree));
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("generates Elm codecs for package aliases and unions", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "elm-ast-package-codec-"));
  mkdirSync(join(projectRoot, "src/Ui"), { recursive: true });
  mkdirSync(join(projectRoot, "src/Generated"), { recursive: true });
  cpSync(join(root, "test/fixtures/Ui/PackageUrl.elm"), join(projectRoot, "src/Ui/PackageUrl.elm"));
  const elmJson = JSON.parse(readFileSync(join(root, "examples/components/elm.json"), "utf8"));
  elmJson["source-directories"] = ["src"];
  elmJson.dependencies.direct["elm/url"] = elmJson.dependencies.indirect["elm/url"];
  delete elmJson.dependencies.indirect["elm/url"];
  writeFileSync(join(projectRoot, "elm.json"), JSON.stringify(elmJson));

  try {
    const project = Effect.runSync(openProject(projectRoot, join(root, ".elm-home")));
    const input = Effect.runSync(project.module("Ui.PackageUrl")).declarations.find((item) => item.kind === "alias" && item.name === "Input");
    assert.ok(input?.kind === "alias");
    const graph = Effect.runSync(collectTypeGraph(project, "Ui.PackageUrl", [input.type]));
    const output = printModule(generateCodecs("Generated.Codec", graph));
    assert.match(output, /decodeUrl_Url/);
    assert.match(output, /decodeUrl_Protocol/);
    writeFileSync(join(projectRoot, "src/Generated/Codec.elm"), output);
    writeFileSync(join(projectRoot, "src/Main.elm"), "module Main exposing (main)\nimport Generated.Codec\nimport Html\nimport Json.Decode\nimport Json.Encode\nimport Url\nmain = Html.text (case Json.Decode.decodeString Generated.Codec.decodeUrl_Url (Json.Encode.encode 0 (Generated.Codec.encodeUrl_Url { protocol = Url.Https, host = \"example.com\", port_ = Nothing, path = \"/\", query = Nothing, fragment = Nothing })) of\n    Ok _ -> \"ok\"\n    Err _ -> \"error\")\n");
    const elm = fileURLToPath(new URL("../../../node_modules/.bin/elm", import.meta.url));
    const result = spawnSync(elm, ["make", "src/Main.elm", "--output=dist.js"], { cwd: projectRoot, env: { ...process.env, ELM_HOME: join(root, ".elm-home") }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr + output);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("round-trips a nine-argument constructor and nested record types through compiled Elm", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "elm-ast-wide-codec-"));
  mkdirSync(join(projectRoot, "src/Domain"), { recursive: true });
  mkdirSync(join(projectRoot, "src/Ui"), { recursive: true });
  mkdirSync(join(projectRoot, "src/Generated"), { recursive: true });
  const elmJson = JSON.parse(readFileSync(join(root, "examples/components/elm.json"), "utf8"));
  elmJson["source-directories"] = ["src"];
  writeFileSync(join(projectRoot, "elm.json"), JSON.stringify(elmJson));
  writeFileSync(join(projectRoot, "src/Domain/Wide.elm"), "module Domain.Wide exposing (Wide(..), WideRecord)\ntype Wide = Empty | Nine Int Int Int Int Int Int Int Int Int\ntype alias WideRecord = { a : Int, b : Int, c : Int, d : Int, e : Int, f : Int, g : Int, h : Int, i : Int, values : List Int, unit : (), unitMaybe : Maybe (), pair : ( Int, String ), outcome : Result String Int, nested : Maybe (Result String (Maybe Int)) }\n");
  writeFileSync(join(projectRoot, "src/Ui/Test.elm"), "module Ui.Test exposing (Input)\nimport Domain.Wide exposing (Wide, WideRecord)\ntype alias Input = { wide : Wide, record : WideRecord }\n");

  try {
    const project = Effect.runSync(openProject(projectRoot, join(root, ".elm-home")));
    const input = Effect.runSync(project.module("Ui.Test")).declarations.find((item) => item.kind === "alias" && item.name === "Input");
    assert.ok(input?.kind === "alias");
    const graph = Effect.runSync(collectTypeGraph(project, "Ui.Test", [input.type]));
    const wideRecord = graph.get("Domain.Wide.WideRecord")?.definition.declaration;
    assert.ok(wideRecord?.kind === "alias" && wideRecord.type.kind === "record");
    const values = wideRecord.type.fields.find((field) => field.name === "values")?.type;
    assert.ok(values?.kind === "named");
    // Package docs use fully qualified List.List even though Elm source writes List.
    values.module = ["List"];
    const output = printModule(generateCodecs("Generated.Codec", graph));
    assert.match(output, /andMap decoder functionDecoder/);
    assert.doesNotMatch(output.split("\n")[0]!, /andMap/);
    writeFileSync(join(projectRoot, "src/Generated/Codec.elm"), output);
    writeFileSync(join(projectRoot, "src/Main.elm"), [
      "port module Main exposing (main)",
      "import Generated.Codec",
      "import Json.Decode as Decode",
      "import Json.Encode as Encode",
      "import Platform",
      "import Platform.Cmd as Cmd",
      "import Platform.Sub as Sub",
      "port requestWide : (String -> msg) -> Sub msg",
      "port requestRecord : (String -> msg) -> Sub msg",
      "port response : String -> Cmd msg",
      "type Msg = GotWide String | GotRecord String",
      "main : Platform.Program () () Msg",
      "main = Platform.worker { init = \\_ -> ( (), Cmd.none ), update = update, subscriptions = \\_ -> Sub.batch [ requestWide GotWide, requestRecord GotRecord ] }",
      "update msg model =",
      "    let",
      "        roundTrip decoder encoder raw =",
      "            case Decode.decodeString decoder raw of",
      "                Ok value -> Encode.encode 0 (encoder value)",
      "                Err error -> Decode.errorToString error",
      "    in",
      "    case msg of",
      "        GotWide raw -> ( model, response (roundTrip Generated.Codec.decodeDomain_Wide_Wide Generated.Codec.encodeDomain_Wide_Wide raw) )",
      "        GotRecord raw -> ( model, response (roundTrip Generated.Codec.decodeDomain_Wide_WideRecord Generated.Codec.encodeDomain_Wide_WideRecord raw) )",
      "",
    ].join("\n"));
    const elm = fileURLToPath(new URL("../../../node_modules/.bin/elm", import.meta.url));
    const result = spawnSync(elm, ["make", "src/Main.elm", "--output=dist.js"], { cwd: projectRoot, env: { ...process.env, ELM_HOME: join(root, ".elm-home") }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr + output);

    type PortInput = { send: (value: string) => void };

    type PortResponse = {
      subscribe: (callback: (value: string) => void) => void;
      unsubscribe: (callback: (value: string) => void) => void;
    };

    type WideScope = {
      Elm?: { Main: { init: () => { ports: { requestWide: PortInput; requestRecord: PortInput; response: PortResponse } } } };
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
    };

    type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

    type WirePayload = Record<string, JsonValue>;

    const scope: WideScope = { setTimeout, clearTimeout };
    vm.runInNewContext(readFileSync(join(projectRoot, "dist.js"), "utf8"), scope);
    assert.ok(scope.Elm);
    const app = scope.Elm.Main.init();

    const roundTrip = (port: PortInput, input: WirePayload): Promise<void> => new Promise((resolve, reject) => {
      const receive = (value: string): void => {
        app.ports.response.unsubscribe(receive);

        try {
          assert.deepEqual(JSON.parse(value), input);
          resolve();
        } catch (error) {
          reject(error);
        }
      };

      app.ports.response.subscribe(receive);
      port.send(JSON.stringify(input));
    });

    const numbers = Array.from({ length: 9 }, (_, index) => index + 1);
    await roundTrip(app.ports.requestWide, { type: "nine", args: numbers });
    const record = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, values: [1, 2, 3], unit: null, unitMaybe: { type: "just", args: [null] }, pair: [7, "x"], outcome: { type: "ok", args: [5] }, nested: { type: "just", args: [{ type: "ok", args: [{ type: "just", args: [42] }] }] } } satisfies WirePayload;
    await roundTrip(app.ports.requestRecord, record);
    await roundTrip(app.ports.requestRecord, { ...record, outcome: { type: "err", args: ["failure"] }, nested: { type: "nothing", args: [] }, unitMaybe: { type: "nothing", args: [] } });
    await roundTrip(app.ports.requestRecord, { ...record, nested: { type: "just", args: [{ type: "ok", args: [{ type: "nothing", args: [] }] }] } });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
