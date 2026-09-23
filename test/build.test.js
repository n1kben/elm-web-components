import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { generatedAdapter, generatedElm, generatedName, readConfig } from "../tool/build.js";

test("builder validates the public manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "elm-components-"));
  writeFileSync(join(directory, "elm.json"), JSON.stringify({
    type: "application", "source-directories": ["src"],
  }));
  const path = join(directory, "elm-web-components.json");
  writeFileSync(path, JSON.stringify({ components: [
    { tag: "ui-picker", module: "Picker", attributes: ["value"], output: "dist/picker.js" },
  ] }));
  assert.equal(readConfig(path).components[0].tag, "ui-picker");
  writeFileSync(path, JSON.stringify({ output: "dist/components.js", components: [
    { tag: "ui-picker", module: "Picker", attributes: ["value"] },
  ] }));
  assert.equal(readConfig(path).bundleOutput, join(directory, "dist/components.js"));
  writeFileSync(path, JSON.stringify({ output: "dist/components.js", components: [
    { tag: "ui-picker", module: "Picker", attributes: ["value"], output: "dist/picker.js" },
  ] }));
  assert.throws(() => readConfig(path), /cannot be used with top-level output/);
  writeFileSync(path, JSON.stringify({ components: [
    { tag: "Picker", module: "Picker", attributes: ["value"], output: "dist/picker.js" },
  ] }));
  assert.throws(() => readConfig(path), /lowercase custom element name/);
  assert.match(generatedElm("Picker", "ui-picker"), /Component\.program/);
  assert.notEqual(generatedName("ui-picker"), generatedName("ui-picker-alt"));
});

test("adapter sends changed attributes, pauses on detach, and emits DOM events", () => {
  const registered = new Map();
  const calls = { input: [], connection: [], events: [], flags: [] };
  const suffix = generatedName("ui-test");
  let outputSubscriber;
  class HTMLElement {
    constructor() { this.attributes = new Map(); }
    hasAttribute(name) { return this.attributes.has(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    attachShadow() { return { append() {} }; }
    dispatchEvent(event) { calls.events.push(event); }
  }
  class CustomEvent {
    constructor(name, options) { this.type = name; Object.assign(this, options); }
  }
  vm.runInNewContext(generatedAdapter({ tag: "ui-test", attributes: ["value"] }), {
    Elm: { ElmWebComponents: { Generated: { [generatedName("ui-test")]: {
      init({ flags }) {
        calls.flags.push(flags);
        return { ports: {
          [`inputChanged${suffix}`]: { send: (value) => calls.input.push(value) },
          [`connectionChanged${suffix}`]: { send: (value) => calls.connection.push(value) },
          [`outputSent${suffix}`]: { subscribe: (callback) => { outputSubscriber = callback; } },
        } };
      },
    } } } },
    HTMLElement, CustomEvent,
    customElements: { define: (tag, klass) => registered.set(tag, klass) },
    document: { createElement: () => ({}) },
  });
  const Element = registered.get("ui-test");
  const element = new Element();
  element.attributes.set("value", "one");
  element.connectedCallback();
  assert.equal(calls.flags[0].value, "one");
  element.attributes.set("value", "two");
  element.attributeChangedCallback();
  assert.equal(calls.input[0].value, "two");
  element.disconnectedCallback();
  element.connectedCallback();
  assert.deepEqual(calls.connection, [false, true]);
  assert.equal(calls.flags.length, 1);
  outputSubscriber({ name: "selected", detail: { value: "two" } });
  assert.equal(calls.events[0].type, "selected");
  assert.equal(calls.events[0].detail.value, "two");
  assert.equal(calls.events[0].bubbles, true);
  assert.equal(calls.events[0].composed, true);
});
