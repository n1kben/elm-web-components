import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

test("one compiled file contains the app and both components", () => {
  const elements = new Map<string, new () => object>();

  const context = vm.createContext({
    HTMLElement: class {},
    customElements: { define: (tag: string, klass: new () => object) => elements.set(tag, klass) },
  });

  const source = readFileSync(new URL("dist/app.js", root), "utf8");
  vm.runInContext(source, context, { filename: "app.js" });
  assert.ok(elements.has("ui-disclosure"));
  assert.ok(elements.has("ui-date-picker"));
  assert.ok(context.Elm.Host);
  assert.equal(Object.keys(context.Elm.ElmWebComponents.Generated).length, 2);
});

test("an Elm host cannot compile against a component omitted from the build", () => {
  const project = mkdtempSync(join(tmpdir(), "elm-web-components-build-"));
  const source = new URL("examples/components/", root);
  mkdirSync(join(project, "src/Ui"), { recursive: true });
  cpSync(fileURLToPath(new URL("src/Host.elm", source)), join(project, "src/Host.elm"));
  cpSync(fileURLToPath(new URL("src/Ui/Disclosure.elm", source)), join(project, "src/Ui/Disclosure.elm"));
  cpSync(fileURLToPath(new URL("src/Ui/DatePicker.elm", source)), join(project, "src/Ui/DatePicker.elm"));
  cpSync(fileURLToPath(new URL("src/Component.elm", root)), join(project, "src/Component.elm"));
  const elmJson = JSON.parse(readFileSync(new URL("elm.json", source), "utf8"));
  elmJson["source-directories"] = ["src"];
  writeFileSync(join(project, "elm.json"), JSON.stringify(elmJson));
  const cli = fileURLToPath(new URL("bin/elm-web-components.ts", root));

  const env = {
    ...process.env,
    ELM_BINARY: fileURLToPath(new URL("node_modules/.bin/elm", root)),
    ELM_HOME: fileURLToPath(new URL(".elm-home", root)),
  };

  try {
    const full = spawnSync(process.execPath, [cli, "build", "--app", "src/Host.elm", "src/Ui/Disclosure.elm", "src/Ui/DatePicker.elm"], { cwd: project, env, encoding: "utf8" });
    assert.equal(full.status, 0, full.stdout + full.stderr);
    const omitted = spawnSync(process.execPath, [cli, "build", "--app", "src/Host.elm", "--output", "dist/omitted.js", "src/Ui/Disclosure.elm"], { cwd: project, env, encoding: "utf8" });
    assert.notEqual(omitted.status, 0);
    assert.match(omitted.stdout + omitted.stderr, /WebComponents\.Ui\.DatePicker/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("a handwritten codec collision fails before changing generated files", () => {
  const project = mkdtempSync(join(tmpdir(), "elm-web-components-codec-collision-"));
  const source = new URL("examples/components/", root);
  mkdirSync(join(project, "src/Ui"), { recursive: true });
  cpSync(fileURLToPath(new URL("src/Ui/Disclosure.elm", source)), join(project, "src/Ui/Disclosure.elm"));
  cpSync(fileURLToPath(new URL("src/Component.elm", root)), join(project, "src/Component.elm"));
  const elmJson = JSON.parse(readFileSync(new URL("elm.json", source), "utf8"));
  elmJson["source-directories"] = ["src"];
  writeFileSync(join(project, "elm.json"), JSON.stringify(elmJson));
  const cli = fileURLToPath(new URL("bin/elm-web-components.ts", root));

  const env = {
    ...process.env,
    ELM_BINARY: fileURLToPath(new URL("node_modules/.bin/elm", root)),
    ELM_HOME: fileURLToPath(new URL(".elm-home", root)),
  };

  try {
    const args = [cli, "build", "src/Ui/Disclosure.elm"];
    const first = spawnSync(process.execPath, args, { cwd: project, env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const codecDirectory = join(project, "src/WebComponents/Codecs");
    const codecPath = join(codecDirectory, readdirSync(codecDirectory)[0]!);
    const hostPath = join(project, "src/WebComponents/Ui/Disclosure.elm");
    const hostBefore = readFileSync(hostPath, "utf8");
    const handwritten = "module Handwritten exposing (value)\nvalue = 1\n";
    writeFileSync(codecPath, handwritten);

    const second = spawnSync(process.execPath, args, { cwd: project, env, encoding: "utf8" });
    assert.notEqual(second.status, 0);
    assert.match(second.stdout + second.stderr, /generated codec module would overwrite a handwritten file/);
    assert.equal(readFileSync(codecPath, "utf8"), handwritten);
    assert.equal(readFileSync(hostPath, "utf8"), hostBefore);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("generated Maybe codecs preserve nested Nothing and Just unit", async () => {
  const project = mkdtempSync(join(tmpdir(), "elm-web-components-maybe-"));
  const source = new URL("examples/components/", root);
  mkdirSync(join(project, "src/Ui"), { recursive: true });
  cpSync(fileURLToPath(new URL("src/Ui/Disclosure.elm", source)), join(project, "src/Ui/Disclosure.elm"));
  cpSync(fileURLToPath(new URL("src/Component.elm", root)), join(project, "src/Component.elm"));
  const elmJson = JSON.parse(readFileSync(new URL("elm.json", source), "utf8"));
  elmJson["source-directories"] = ["src"];
  writeFileSync(join(project, "elm.json"), JSON.stringify(elmJson));
  const elm = fileURLToPath(new URL("node_modules/.bin/elm", root));
  const env = { ...process.env, ELM_BINARY: elm, ELM_HOME: fileURLToPath(new URL(".elm-home", root)) };

  try {
    const cli = fileURLToPath(new URL("bin/elm-web-components.ts", root));
    const built = spawnSync(process.execPath, [cli, "build", "src/Ui/Disclosure.elm"], { cwd: project, env, encoding: "utf8" });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const codecDirectory = join(project, "src/WebComponents/Codecs");
    const codecModule = readdirSync(codecDirectory)[0]!.replace(/\.elm$/u, "");

    const worker = [
      "port module CodecRoundTrip exposing (main)",
      "import Json.Decode as Decode",
      "import Json.Encode as Encode",
      "import Platform",
      "import Platform.Cmd as Cmd",
      "import Platform.Sub as Sub",
      `import WebComponents.Codecs.${codecModule} as Codec`,
      "port requestNested : (String -> msg) -> Sub msg",
      "port requestUnit : (String -> msg) -> Sub msg",
      "port response : String -> Cmd msg",
      "type Msg = Nested String | Unit String",
      "main : Platform.Program () () Msg",
      "main = Platform.worker { init = \\_ -> ( (), Cmd.none ), update = update, subscriptions = \\_ -> Sub.batch [ requestNested Nested, requestUnit Unit ] }",
      "roundTrip decoder encoder raw =",
      "    case Decode.decodeString decoder raw of",
      "        Ok value -> Encode.encode 0 (encoder value)",
      "        Err error -> Decode.errorToString error",
      "update msg model =",
      "    case msg of",
      "        Nested raw -> ( model, response (roundTrip (Codec.decodeMaybe (Codec.decodeMaybe Decode.int)) (Codec.encodeMaybe (Codec.encodeMaybe Encode.int)) raw) )",
      "        Unit raw -> ( model, response (roundTrip (Codec.decodeMaybe (Decode.null ())) (Codec.encodeMaybe (\\_ -> Encode.null)) raw) )",
      "",
    ].join("\n");

    writeFileSync(join(project, "src/CodecRoundTrip.elm"), worker);
    const compiled = spawnSync(elm, ["make", "src/CodecRoundTrip.elm", "--output=codec-worker.js"], { cwd: project, env, encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr + worker);

    type PortInput = { send: (value: string) => void };

    type PortResponse = { subscribe: (callback: (value: string) => void) => void; unsubscribe: (callback: (value: string) => void) => void };

    type Scope = { Elm?: { CodecRoundTrip: { init: () => { ports: { requestNested: PortInput; requestUnit: PortInput; response: PortResponse } } } }; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

    type MaybeValue = { type: "nothing"; args: [] } | { type: "just"; args: [MaybeValue | number | null] };

    const scope: Scope = { setTimeout, clearTimeout };
    vm.runInNewContext(readFileSync(join(project, "codec-worker.js"), "utf8"), scope);
    assert.ok(scope.Elm);
    const app = scope.Elm.CodecRoundTrip.init();

    const roundTrip = (port: PortInput, value: MaybeValue): Promise<void> => new Promise((resolve, reject) => {
      const receive = (output: string): void => {
        app.ports.response.unsubscribe(receive);

        try {
          assert.deepEqual(JSON.parse(output), value);
          resolve();
        } catch (error) {
          reject(error);
        }
      };

      app.ports.response.subscribe(receive);
      port.send(JSON.stringify(value));
    });

    await roundTrip(app.ports.requestNested, { type: "nothing", args: [] });
    await roundTrip(app.ports.requestNested, { type: "just", args: [{ type: "nothing", args: [] }] });
    await roundTrip(app.ports.requestNested, { type: "just", args: [{ type: "just", args: [7] }] });
    await roundTrip(app.ports.requestUnit, { type: "nothing", args: [] });
    await roundTrip(app.ports.requestUnit, { type: "just", args: [null] });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("recursive generic unions compile into a custom element", () => {
  const project = mkdtempSync(join(tmpdir(), "elm-web-components-tree-"));
  const source = new URL("examples/components/", root);
  mkdirSync(join(project, "src/Ui"), { recursive: true });
  cpSync(fileURLToPath(new URL("test/fixtures/Ui/TreeComponent.elm", root)), join(project, "src/Ui/TreeComponent.elm"));
  cpSync(fileURLToPath(new URL("test/fixtures/TreeHost.elm", root)), join(project, "src/TreeHost.elm"));
  cpSync(fileURLToPath(new URL("src/Component.elm", root)), join(project, "src/Component.elm"));
  const elmJson = JSON.parse(readFileSync(new URL("elm.json", source), "utf8"));
  elmJson["source-directories"] = ["src"];
  writeFileSync(join(project, "elm.json"), JSON.stringify(elmJson));
  const cli = fileURLToPath(new URL("bin/elm-web-components.ts", root));

  const env = {
    ...process.env,
    ELM_BINARY: fileURLToPath(new URL("node_modules/.bin/elm", root)),
    ELM_HOME: fileURLToPath(new URL(".elm-home", root)),
  };

  try {
    const result = spawnSync(process.execPath, [cli, "build", "--app", "src/TreeHost.elm", "src/Ui/TreeComponent.elm"], { cwd: project, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(join(project, "dist/components.js"), "utf8"), /ui-tree-component/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("recursive imported unions compile through the project import graph", () => {
  const project = mkdtempSync(join(tmpdir(), "elm-web-components-imported-tree-"));
  const source = new URL("examples/components/", root);
  mkdirSync(join(project, "src/Ui"), { recursive: true });
  mkdirSync(join(project, "src/Data"), { recursive: true });
  cpSync(fileURLToPath(new URL("test/fixtures/Data/Tree.elm", root)), join(project, "src/Data/Tree.elm"));
  cpSync(fileURLToPath(new URL("test/fixtures/Ui/ImportedTree.elm", root)), join(project, "src/Ui/ImportedTree.elm"));
  cpSync(fileURLToPath(new URL("test/fixtures/ImportedTreeHost.elm", root)), join(project, "src/ImportedTreeHost.elm"));
  cpSync(fileURLToPath(new URL("src/Component.elm", root)), join(project, "src/Component.elm"));
  const elmJson = JSON.parse(readFileSync(new URL("elm.json", source), "utf8"));
  elmJson["source-directories"] = ["src"];
  writeFileSync(join(project, "elm.json"), JSON.stringify(elmJson));
  const cli = fileURLToPath(new URL("bin/elm-web-components.ts", root));

  const env = {
    ...process.env,
    ELM_BINARY: fileURLToPath(new URL("node_modules/.bin/elm", root)),
    ELM_HOME: fileURLToPath(new URL(".elm-home", root)),
  };

  try {
    const result = spawnSync(process.execPath, [cli, "build", "--app", "src/ImportedTreeHost.elm", "src/Ui/ImportedTree.elm"], { cwd: project, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(join(project, "dist/components.js"), "utf8"), /ui-imported-tree/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("package aliases and unions compile from Elm package docs", () => {
  const project = mkdtempSync(join(tmpdir(), "elm-web-components-package-url-"));
  const source = new URL("examples/components/", root);
  mkdirSync(join(project, "src/Ui"), { recursive: true });
  cpSync(fileURLToPath(new URL("test/fixtures/Ui/PackageUrl.elm", root)), join(project, "src/Ui/PackageUrl.elm"));
  cpSync(fileURLToPath(new URL("src/Component.elm", root)), join(project, "src/Component.elm"));
  const elmJson = JSON.parse(readFileSync(new URL("elm.json", source), "utf8"));
  elmJson["source-directories"] = ["src"];
  elmJson.dependencies.direct["elm/url"] = elmJson.dependencies.indirect["elm/url"];
  delete elmJson.dependencies.indirect["elm/url"];
  writeFileSync(join(project, "elm.json"), JSON.stringify(elmJson));
  const cli = fileURLToPath(new URL("bin/elm-web-components.ts", root));

  const env = {
    ...process.env,
    ELM_BINARY: fileURLToPath(new URL("node_modules/.bin/elm", root)),
    ELM_HOME: fileURLToPath(new URL(".elm-home", root)),
  };

  try {
    const result = spawnSync(process.execPath, [cli, "build", "src/Ui/PackageUrl.elm"], { cwd: project, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
