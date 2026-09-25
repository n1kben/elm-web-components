import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
