import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { generatedAdapter, generatedElm, generatedHost, parseComponent } from "../tool/build.js";

const source = `module Ui.DatePicker exposing (Input, Output(..), component)
import Component exposing (Component)
type alias Input = { startMonth : String, value : Maybe String, disabled : Bool }
type Output = DateRequested { value : String }
component : Component Input State Msg Output
component = Component.define { init = init, receive = receive, update = update, view = view, subscriptions = subscriptions }
`;

function fixture(contents = source) {
  const directory = mkdtempSync(join(tmpdir(), "elm-components-"));
  const path = join(directory, "DatePicker.elm");
  writeFileSync(path, contents);

  return path;
}

test("source types generate attribute codecs and a typed host API", () => {
  const component = parseComponent(fixture());
  assert.equal(component.tag, "ui-date-picker");
  assert.deepEqual(component.inputs.map((field) => field.attribute), ["start-month", "value", "disabled"]);
  assert.match(generatedElm(component), /Decode\.maybe \(Decode\.field "value" Decode\.string\)/);
  assert.match(generatedElm(component), /Component\.program decodeInput encodeOutput/);
  assert.match(generatedHost(component), /onDateRequested : Maybe \(\{ value : String \} -> msg\)/);
  assert.match(generatedHost(component), /Html\.node "ui-date-picker"/);
});

test("unsupported wire types fail with the source path", () => {
  const path = fixture(source.replace("value : Maybe String", "value : Maybe Int"));
  assert.throws(() => parseComponent(path), (error) => error.message.includes(`${path}:3`) && /unsupported field/.test(error.message));
});

test("standard multiline Elm declarations are accepted", () => {
  const path = fixture(source
    .replace("module Ui.DatePicker exposing (Input, Output(..), component)", "module Ui.DatePicker exposing\n    ( Input\n    , Output(..)\n    , component\n    )")
    .replace("type Output = DateRequested { value : String }", "type Output\n    = DateRequested\n        { value : String }")
    .replace("value : Maybe String", "value : Maybe\n      String"));

  const component = parseComponent(path);
  assert.equal(component.tag, "ui-date-picker");
  assert.equal(component.inputs[1].type, "Maybe String");
  assert.equal(component.outputs[0].name, "DateRequested");
});

test("adapter observes attributes, survives detachment, and emits DOM events", () => {
  const component = parseComponent(fixture());
  const registered = new Map();
  const calls = { input: [], connection: [], events: [], flags: [] };
  const suffix = component.suffix;
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

  vm.runInNewContext(generatedAdapter(component), {
    Elm: { ElmWebComponents: { Generated: { [suffix]: {
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

  const Element = registered.get("ui-date-picker");
  const element = new Element();
  element.attributes.set("start-month", "2026-09");
  element.connectedCallback();
  assert.equal(calls.flags[0]["start-month"], "2026-09");
  element.attributes.set("value", "2026-09-24");
  element.attributeChangedCallback();
  assert.equal(calls.input[0].value, "2026-09-24");
  element.disconnectedCallback();
  element.connectedCallback();
  assert.deepEqual(calls.connection, [false, true]);
  assert.equal(calls.flags.length, 1);
  outputSubscriber([
    { name: "date-requested", detail: { value: "2026-09-24" } },
    { name: "date-requested", detail: { value: "2026-09-25" } },
  ]);
  assert.equal(calls.events[0].type, "date-requested");
  assert.equal(calls.events[0].bubbles, true);
  assert.equal(calls.events[0].composed, true);
  assert.deepEqual(calls.events.map((event) => event.detail.value), ["2026-09-24", "2026-09-25"]);
});
