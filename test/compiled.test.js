import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

test("independent compiled components can be loaded on the same page", () => {
  const elements = new Map();
  const context = vm.createContext({
    HTMLElement: class {},
    customElements: { define: (tag, klass) => elements.set(tag, klass) },
  });
  for (const filename of ["disclosure.js", "date-picker.js"]) {
    const source = readFileSync(new URL(`dist/${filename}`, root), "utf8");
    vm.runInContext(source, context, { filename });
  }
  assert.ok(elements.has("ui-disclosure"));
  assert.ok(elements.has("ui-date-picker"));
  assert.ok(context.Elm.ElmWebComponents.Generated);
  assert.equal(Object.keys(context.Elm.ElmWebComponents.Generated).length, 2);
});
