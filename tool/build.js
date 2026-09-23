import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const tagPattern = /^[a-z][a-z0-9._-]*-[a-z0-9._-]+$/;
const attributePattern = /^[a-z][a-z0-9._-]*$/;
const modulePattern = /^[A-Z][A-Za-z0-9]*(\.[A-Z][A-Za-z0-9]*)*$/;

function unique(items) {
  return new Set(items).size === items.length;
}

export function readConfig(configPath) {
  const path = resolve(configPath);
  const project = dirname(path);
  const config = JSON.parse(readFileSync(path, "utf8"));
  const elmJson = JSON.parse(readFileSync(resolve(project, "elm.json"), "utf8"));

  if (elmJson.type !== "application") {
    throw new Error("The component build must run from an Elm application project.");
  }
  if (!Array.isArray(elmJson["source-directories"])) {
    throw new Error("elm.json needs source-directories.");
  }
  if (!Array.isArray(config.components) || config.components.length === 0) {
    throw new Error("Config needs a nonempty components array.");
  }
  if (config.optimize !== undefined && typeof config.optimize !== "boolean") {
    throw new Error("Config optimize must be a boolean.");
  }
  const components = config.components.map((entry, index) => {
    const label = `components[${index}]`;
    if (!entry || typeof entry !== "object") {
      throw new Error(`${label} must be an object.`);
    }
    if (typeof entry.tag !== "string" || !tagPattern.test(entry.tag)) {
      throw new Error(`${label}.tag must be a lowercase custom element name with a hyphen.`);
    }
    if (typeof entry.module !== "string" || !modulePattern.test(entry.module)) {
      throw new Error(`${label}.module must be an Elm module name.`);
    }
    if (typeof entry.output !== "string" || !entry.output.endsWith(".js")) {
      throw new Error(`${label}.output must be a JavaScript file path.`);
    }
    if (!Array.isArray(entry.attributes) || !entry.attributes.every(
      (attribute) => typeof attribute === "string" && attributePattern.test(attribute),
    ) || !unique(entry.attributes)) {
      throw new Error(`${label}.attributes must be unique lowercase attribute names.`);
    }
    return { ...entry, output: resolve(project, entry.output) };
  });
  if (!unique(components.map(({ tag }) => tag))) {
    throw new Error("Each component tag must be unique.");
  }
  if (!unique(components.map(({ output }) => output))) {
    throw new Error("Each component output path must be unique.");
  }
  return { project, elmJson, components, optimize: config.optimize ?? false };
}

export function generatedName(tag) {
  return `Tag${Buffer.from(tag, "utf8").toString("hex")}`;
}

export function generatedElm(moduleName, tag) {
  if (!modulePattern.test(moduleName)) throw new Error("Invalid Elm module name.");
  if (!tagPattern.test(tag)) throw new Error("Invalid custom element tag.");
  const generatedModule = `ElmWebComponents.Generated.${generatedName(tag)}`;
  return `port module ${generatedModule} exposing (main)

import Component
import ${moduleName}
import Json.Decode as Decode
import Json.Encode as Encode
import Platform.Cmd exposing (Cmd)
import Platform.Sub exposing (Sub)

port inputChanged : (Decode.Value -> msg) -> Sub msg
port connectionChanged : (Bool -> msg) -> Sub msg
port outputSent : Encode.Value -> Cmd msg

main =
    Component.program
        { inputChanged = inputChanged
        , connectionChanged = connectionChanged
        , outputSent = outputSent
        }
        ${moduleName}.component
`;
}

export function generatedAdapter({ tag, attributes }) {
  return `
(() => {
  const program = Elm.ElmWebComponents.Generated.${generatedName(tag)};
  const observed = ${JSON.stringify(attributes)};
  class ComponentElement extends HTMLElement {
    static get observedAttributes() { return observed; }

    connectedCallback() {
      if (this.app) {
        this.app.ports.connectionChanged.send(true);
        return;
      }
      const root = this.attachShadow({ mode: "open" });
      const mount = document.createElement("div");
      root.append(mount);
      this.app = program.init({ node: mount, flags: this.attributeSnapshot() });
      this.app.ports.outputSent.subscribe(({ name, detail }) => {
        this.dispatchEvent(new CustomEvent(name, {
          detail, bubbles: true, composed: true,
        }));
      });
    }

    disconnectedCallback() {
      if (this.app) this.app.ports.connectionChanged.send(false);
    }

    attributeChangedCallback() {
      if (this.app) this.app.ports.inputChanged.send(this.attributeSnapshot());
    }

    attributeSnapshot() {
      const snapshot = {};
      for (const name of observed) {
        if (this.hasAttribute(name)) snapshot[name] = this.getAttribute(name);
      }
      return snapshot;
    }
  }
  customElements.define(${JSON.stringify(tag)}, ComponentElement);
})();
`;
}

function elmBinary(project) {
  if (process.env.ELM_BINARY) return process.env.ELM_BINARY;
  let directory = project;
  while (true) {
    const local = resolve(directory, "node_modules/.bin/elm");
    if (existsSync(local)) return local;
    const parent = dirname(directory);
    if (parent === directory) return "elm";
    directory = parent;
  }
}

export function build(configPath) {
  const { project, elmJson, components, optimize } = readConfig(configPath);
  const sourceDirectories = elmJson["source-directories"].map(
    (source) => resolve(project, source),
  );
  for (const component of components) {
    const buildDirectory = resolve(project, ".elm-web-components", component.tag);
    const generatedSource = resolve(buildDirectory, `src/ElmWebComponents/Generated/${generatedName(component.tag)}.elm`);
    const temporaryOutput = resolve(buildDirectory, "component.js");
    mkdirSync(dirname(generatedSource), { recursive: true });
    writeFileSync(generatedSource, generatedElm(component.module, component.tag));
    writeFileSync(resolve(buildDirectory, "elm.json"), JSON.stringify({
      ...elmJson,
      "source-directories": ["src", ...sourceDirectories.map((source) => relative(buildDirectory, source))],
    }, null, 4) + "\n");

    const result = spawnSync(
      elmBinary(project),
      ["make", `src/ElmWebComponents/Generated/${generatedName(component.tag)}.elm`, `--output=${temporaryOutput}`, ...(optimize ? ["--optimize"] : [])],
      { cwd: buildDirectory, env: process.env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Elm build failed for ${component.tag}.`);

    mkdirSync(dirname(component.output), { recursive: true });
    writeFileSync(component.output,
      readFileSync(temporaryOutput, "utf8") + generatedAdapter(component));
    process.stdout.write(`Built ${relative(project, component.output)} for <${component.tag}>\n`);
  }
}
