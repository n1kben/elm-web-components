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
  const elements = new Map();

  const context = vm.createContext({
    HTMLElement: class {},
    customElements: { define: (tag, klass) => elements.set(tag, klass) },
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
  const cli = fileURLToPath(new URL("bin/elm-web-components.js", root));

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
