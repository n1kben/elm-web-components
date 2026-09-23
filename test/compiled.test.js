import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

function load(files) {
  const elements = new Map();
  const context = vm.createContext({
    HTMLElement: class {},
    customElements: { define: (tag, klass) => elements.set(tag, klass) },
  });
  for (const filename of files) {
    const source = readFileSync(new URL(`dist/${filename}`, root), "utf8");
    vm.runInContext(source, context, { filename });
  }
  return { elements, context };
}

test("one compiled bundle registers every component", () => {
  const { elements, context } = load(["components.js"]);
  assert.ok(elements.has("ui-disclosure"));
  assert.ok(elements.has("ui-date-picker"));
  assert.equal(Object.keys(context.Elm.ElmWebComponents.Generated).length, 2);
});

test("independent compiled components can be loaded on the same page", () => {
  const { elements, context } = load(["split/disclosure.js", "split/date-picker.js"]);
  assert.ok(elements.has("ui-disclosure"));
  assert.ok(elements.has("ui-date-picker"));
  assert.ok(context.Elm.ElmWebComponents.Generated);
  assert.equal(Object.keys(context.Elm.ElmWebComponents.Generated).length, 2);
});
