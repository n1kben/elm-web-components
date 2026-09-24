import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { generatedAdapter, generatedElm, generatedHost, parseComponent } from "../tool/build.ts";

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

test("source types generate attribute codecs and a typed host API", async () => {
  const component = await parseComponent(fixture());
  assert.equal(component.tag, "ui-date-picker");
  assert.deepEqual(component.inputs.map((field) => field.attribute), ["start-month", "value", "disabled"]);
  assert.match(generatedElm(component), /Decode\.maybe \(Decode\.field "value" Decode\.string\)/);
  assert.match(generatedElm(component), /Component\.program decodeInput encodeOutput/);
  assert.match(generatedHost(component), /onDateRequested : Maybe \(\{ value : String \} -> msg\)/);
  assert.match(generatedHost(component), /Html\.node "ui-date-picker"/);
});

test("unsupported wire types fail with the source path", async () => {
  const path = fixture(source.replace("value : Maybe String", "value : Maybe Int"));
  await assert.rejects(parseComponent(path), (error) => error instanceof Error && error.message.includes(`${path}:3`) && /unsupported field/.test(error.message));
});

test("standard multiline Elm declarations are accepted", async () => {
  const path = fixture(source
    .replace("module Ui.DatePicker exposing (Input, Output(..), component)", "module Ui.DatePicker exposing\n    ( Input\n    , Output(..)\n    , component\n    )")
    .replace("type Output = DateRequested { value : String }", "type Output\n    = DateRequested\n        { value : String }")
    .replace("value : Maybe String", "value : Maybe\n      String"));

  const component = await parseComponent(path);
  assert.equal(component.tag, "ui-date-picker");
  assert.equal(component.inputs[1].type, "Maybe String");
  assert.equal(component.outputs[0].name, "DateRequested");
});

test("comments cannot impersonate declarations or break type arguments", async () => {
  const path = fixture(source
    .replace("type alias Input =", "{- type alias Input = { wrong : String } -}\ntype alias Input =")
    .replace("value : Maybe String", "value : Maybe {- optional -} String")
    .replace("type Output =", "-- type Output = Wrong { value : String }\ntype Output ="));

  const component = await parseComponent(path);
  assert.deepEqual(component.inputs.map((field) => field.name), ["startMonth", "value", "disabled"]);
  assert.equal(component.inputs[1].type, "Maybe String");
  assert.equal(component.outputs[0].name, "DateRequested");
});

test("exposing all still provides the generated entry with the required types", async () => {
  const path = fixture(source.replace("exposing (Input, Output(..), component)", "exposing (..)"));
  const component = await parseComponent(path);
  assert.equal(component.module, "Ui.DatePicker");
});

test("syntax errors include a source position", async () => {
  const path = fixture(source.replace("value : Maybe String", "value :"));
  await assert.rejects(parseComponent(path), (error) => error instanceof Error && new RegExp(`${path}:3:[0-9]+: Elm syntax error`).test(error.message));
});

test("adapter observes attributes, survives detachment, and emits DOM events", async () => {
  const component = await parseComponent(fixture());

  type EventRecord = { type: string; bubbles: boolean; composed: boolean; detail: { value: string } };

  type OutputRecord = { name: string; detail: { value: string } };

  type Calls = { input: Record<string, string>[]; connection: boolean[]; events: EventRecord[]; flags: Record<string, string>[] };

  const registered = new Map<string, new () => HTMLElement>();
  const calls: Calls = { input: [], connection: [], events: [], flags: [] };
  const suffix = component.suffix;
  let outputSubscriber: (events: OutputRecord[]) => void = () => { throw new Error("Output port was not subscribed"); };

  class HTMLElement {
    attributes = new Map<string, string>();
    hasAttribute(name: string) { return this.attributes.has(name); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    attachShadow() { return { append() {} }; }
    dispatchEvent(event: EventRecord) { calls.events.push(event); }
    connectedCallback() {}
    disconnectedCallback() {}
    attributeChangedCallback() {}
  }

  class CustomEvent {
    type: string;
    bubbles: boolean;
    composed: boolean;
    detail: { value: string };
    constructor(name: string, options: { bubbles: boolean; composed: boolean; detail: { value: string } }) {
      this.type = name;
      this.bubbles = options.bubbles;
      this.composed = options.composed;
      this.detail = options.detail;
    }
  }

  vm.runInNewContext(generatedAdapter(component), {
    Elm: { ElmWebComponents: { Generated: { [suffix]: {
      init({ flags }: { flags: Record<string, string> }) {
        calls.flags.push(flags);

        return { ports: {
          [`inputChanged${suffix}`]: { send: (value: Record<string, string>) => calls.input.push(value) },
          [`connectionChanged${suffix}`]: { send: (value: boolean) => calls.connection.push(value) },
          [`outputSent${suffix}`]: { subscribe: (callback: (events: OutputRecord[]) => void) => { outputSubscriber = callback; } },
        } };
      },
    } } } },
    HTMLElement, CustomEvent,
    customElements: { define: (tag: string, klass: new () => HTMLElement) => registered.set(tag, klass) },
    document: { createElement: () => ({}) },
  });

  const Element = registered.get("ui-date-picker");
  assert.ok(Element);
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
