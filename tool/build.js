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
  if (config.output !== undefined && (typeof config.output !== "string" || !config.output.endsWith(".js"))) {
    throw new Error("Config output must be a JavaScript file path.");
  }
  const bundleOutput = config.output === undefined ? null : resolve(project, config.output);
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
    if (bundleOutput && entry.output !== undefined) {
      throw new Error(`${label}.output cannot be used with top-level output.`);
    }
    if (!bundleOutput && (typeof entry.output !== "string" || !entry.output.endsWith(".js"))) {
      throw new Error(`${label}.output must be a JavaScript file path when there is no top-level output.`);
    }
    if (!Array.isArray(entry.attributes) || !entry.attributes.every(
      (attribute) => typeof attribute === "string" && attributePattern.test(attribute),
    ) || !unique(entry.attributes)) {
      throw new Error(`${label}.attributes must be unique lowercase attribute names.`);
    }
    return { ...entry, output: bundleOutput ? null : resolve(project, entry.output) };
  });
  if (!unique(components.map(({ tag }) => tag))) {
    throw new Error("Each component tag must be unique.");
  }
  if (!bundleOutput && !unique(components.map(({ output }) => output))) {
    throw new Error("Each component output path must be unique.");
  }
  return { project, elmJson, components, bundleOutput, optimize: config.optimize ?? false };
}

export function generatedName(tag) {
  return `Tag${Buffer.from(tag, "utf8").toString("hex")}`;
}

export function generatedElm(moduleName, tag) {
  if (!modulePattern.test(moduleName)) throw new Error("Invalid Elm module name.");
  if (!tagPattern.test(tag)) throw new Error("Invalid custom element tag.");
  const suffix = generatedName(tag);
  const generatedModule = `ElmWebComponents.Generated.${suffix}`;
  const inputPort = `inputChanged${suffix}`;
  const connectionPort = `connectionChanged${suffix}`;
  const outputPort = `outputSent${suffix}`;
  return `port module ${generatedModule} exposing (main)

import Component
import ${moduleName}
import Json.Decode as Decode
import Json.Encode as Encode
import Platform.Cmd exposing (Cmd)
import Platform.Sub exposing (Sub)

port ${inputPort} : (Decode.Value -> msg) -> Sub msg
port ${connectionPort} : (Bool -> msg) -> Sub msg
port ${outputPort} : Encode.Value -> Cmd msg

main =
    Component.program
        { inputChanged = ${inputPort}
        , connectionChanged = ${connectionPort}
        , outputSent = ${outputPort}
        }
        ${moduleName}.component
`;
}

export function generatedAdapter({ tag, attributes }) {
  const suffix = generatedName(tag);
  return `
(() => {
  const program = Elm.ElmWebComponents.Generated.${suffix};
  const observed = ${JSON.stringify(attributes)};
  class ComponentElement extends HTMLElement {
    static get observedAttributes() { return observed; }

    connectedCallback() {
      if (this.app) {
        this.app.ports.connectionChanged${suffix}.send(true);
        return;
      }
      const root = this.attachShadow({ mode: "open" });
      const mount = document.createElement("div");
      root.append(mount);
      this.app = program.init({ node: mount, flags: this.attributeSnapshot() });
      this.app.ports.outputSent${suffix}.subscribe(({ name, detail }) => {
        this.dispatchEvent(new CustomEvent(name, {
          detail, bubbles: true, composed: true,
        }));
      });
    }

    disconnectedCallback() {
      if (this.app) this.app.ports.connectionChanged${suffix}.send(false);
    }

    attributeChangedCallback() {
      if (this.app) this.app.ports.inputChanged${suffix}.send(this.attributeSnapshot());
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
  const { project, elmJson, components, bundleOutput, optimize } = readConfig(configPath);
  const sourceDirectories = elmJson["source-directories"].map(
    (source) => resolve(project, source),
  );
  const groups = bundleOutput
    ? [{ components, output: bundleOutput, directory: "bundle" }]
    : components.map((component) => ({
        components: [component], output: component.output, directory: component.tag,
      }));
  for (const group of groups) {
    const buildDirectory = resolve(project, ".elm-web-components", group.directory);
    const temporaryOutput = resolve(buildDirectory, "component.js");
    const generatedSources = group.components.map((component) => {
      const source = `src/ElmWebComponents/Generated/${generatedName(component.tag)}.elm`;
      const path = resolve(buildDirectory, source);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, generatedElm(component.module, component.tag));
      return source;
    });
    writeFileSync(resolve(buildDirectory, "elm.json"), JSON.stringify({
      ...elmJson,
      "source-directories": ["src", ...sourceDirectories.map((source) => relative(buildDirectory, source))],
    }, null, 4) + "\n");

    const result = spawnSync(
      elmBinary(project),
      ["make", ...generatedSources, `--output=${temporaryOutput}`, ...(optimize ? ["--optimize"] : [])],
      { cwd: buildDirectory, env: process.env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Elm build failed for ${group.directory}.`);

    mkdirSync(dirname(group.output), { recursive: true });
    writeFileSync(group.output,
      readFileSync(temporaryOutput, "utf8") + group.components.map(generatedAdapter).join(""));
    process.stdout.write(`Built ${relative(project, group.output)} for ${group.components.map(({ tag }) => `<${tag}>`).join(", ")}\n`);
  }
}
