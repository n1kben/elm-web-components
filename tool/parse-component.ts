import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import wasmUrl from "@lumis-sh/wasm-elm";
import { Language, Node, Parser } from "web-tree-sitter";

type Field = { name: string; type: string; attribute: string };

type Output = { name: string; fields: Field[]; event: string };

export type ComponentSource = {
  path: string;
  module: string;
  tag: string;
  suffix: string;
  inputs: Field[];
  outputs: Output[];
};

const inputTypes = new Set(["String", "Maybe String", "Bool"]);

const outputTypes = new Set(["String", "Bool", "Int", "Float"]);

let parserReady: Promise<Parser> | undefined;

function fail(path: string, message: string, node?: Node): never {
  const location = node ? `:${node.startPosition.row + 1}:${node.startPosition.column + 1}` : "";
  throw new Error(`${path}${location}: ${message}`);
}

function parser(): Promise<Parser> {
  parserReady ??= (async () => {
    await Parser.init();
    const ready = new Parser();
    ready.setLanguage(await Language.load(fileURLToPath(wasmUrl)));

    return ready;
  })();

  return parserReady;
}

function firstSyntaxError(node: Node): Node | undefined {
  if (node.isError || node.isMissing) return node;

  if (!node.hasError) return undefined;

  for (const child of node.children) {
    const error = firstSyntaxError(child);

    if (error) return error;
  }

  return node;
}

function required(node: Node, field: string, path: string, message: string): Node {
  return node.childForFieldName(field) ?? fail(path, message, node);
}

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replaceAll("_", "-").toLowerCase();
}

function typeNames(node: Node): string[] {
  if (node.type === "upper_case_qid") return [node.text];

  return node.namedChildren.filter((child) => !child.isExtra).flatMap(typeNames);
}

function fields(record: Node, path: string, allowed: ReadonlySet<string>): Field[] {
  if (record.childForFieldName("baseRecord")) return fail(path, "extensible records are not supported for component inputs or outputs", record);

  const declarations = record.namedChildren.filter((child) => child.type === "field_type");

  if (!declarations.length) return fail(path, "a record needs at least one field", record);

  return declarations.map((declaration) => {
    const name = required(declaration, "name", path, "expected a record field name").text;
    const typeNode = required(declaration, "typeExpression", path, `expected a type for ${name}`);
    const type = typeNames(typeNode).join(" ");

    if (!allowed.has(type)) {
      return fail(path, `unsupported field ${name} : ${type || typeNode.text}; supported types: ${[...allowed].join(", ")}`, typeNode);
    }

    return { name, type, attribute: kebab(name) };
  });
}

function declaration(root: Node, kind: string, name: string): Node | undefined {
  return root.namedChildren.find((child) => child.type === kind && child.childForFieldName("name")?.text === name);
}

function parse(root: Node, path: string): ComponentSource {
  const syntaxError = firstSyntaxError(root);

  if (syntaxError) return fail(path, "Elm syntax error; run elm make for the full compiler message", syntaxError);

  const moduleNode = root.childForFieldName("moduleDeclaration");

  if (!moduleNode) return fail(path, "expected a module declaration");

  const moduleName = required(moduleNode, "name", path, "expected a module name");
  const module = moduleName.text;

  if (!module.includes(".")) return fail(path, "expected a namespaced module, such as Ui.DatePicker", moduleName);

  const exposing = required(moduleNode, "exposing", path, "expected a module exposing list");
  const exposesAll = exposing.childForFieldName("doubleDot") !== null;
  const exposed = exposing.namedChildren.filter((child) => !child.isExtra);
  const hasInput = exposed.some((child) => child.type === "exposed_type" && child.namedChildren.some((name) => name.type === "upper_case_identifier" && name.text === "Input"));
  const hasOutput = exposed.some((child) => child.type === "exposed_type" && child.namedChildren.some((name) => name.type === "upper_case_identifier" && name.text === "Output") && child.namedChildren.some((part) => part.type === "exposed_union_constructors"));
  const hasComponent = exposed.some((child) => child.type === "exposed_value" && child.namedChildren.some((name) => name.text === "component"));

  if (!exposesAll && (!hasInput || !hasOutput || !hasComponent)) return fail(path, "expose Input, Output(..), and component", exposing);

  const input = declaration(root, "type_alias_declaration", "Input");

  if (!input) return fail(path, "expected type alias Input = { ... }", moduleNode);

  if (input.namedChildren.some((child) => child.type === "lower_type_name")) return fail(path, "Input cannot take type parameters", input);

  const inputType = required(input, "typeExpression", path, "expected an Input record");
  const inputParts = inputType.namedChildren.filter((child) => !child.isExtra);

  if (inputParts.length !== 1 || inputParts[0].type !== "record_type") return fail(path, "Input must be a record type alias", inputType);

  const inputs = fields(inputParts[0], path, inputTypes);
  const output = declaration(root, "type_declaration", "Output");

  if (!output) return fail(path, "expected type Output = EventName { field : String }", moduleNode);

  if (output.namedChildren.some((child) => child.type === "lower_type_name")) return fail(path, "Output cannot take type parameters", output);

  const variants = output.namedChildren.filter((child) => child.type === "union_variant");

  const outputs = variants.map((variant): Output => {
    const name = required(variant, "name", path, "expected an Output constructor").text;
    const parts = variant.namedChildren.filter((child) => !child.isExtra && child.type !== "upper_case_identifier");

    if (parts.length !== 1 || parts[0].type !== "record_type") return fail(path, "each Output constructor needs one flat record payload", variant);

    const outputFields = fields(parts[0], path, outputTypes);

    if (outputFields.length > 8) return fail(path, "at most eight Output fields are supported in v1", parts[0]);

    if (new Set(outputFields.map((field) => field.attribute)).size !== outputFields.length) return fail(path, "Output fields map to duplicate event detail keys", parts[0]);

    return { name, fields: outputFields, event: kebab(name) };
  });

  if (inputs.length > 8) return fail(path, "at most eight Input fields are supported in v1", input);

  if (new Set(inputs.map((field) => field.attribute)).size !== inputs.length) return fail(path, "Input fields map to duplicate attribute names", input);

  if (new Set(outputs.map((item) => item.event)).size !== outputs.length) return fail(path, "Output constructors map to duplicate event names", output);

  const annotation = declaration(root, "type_annotation", "component");
  const annotationType = annotation?.childForFieldName("typeExpression");
  const names = annotationType ? typeNames(annotationType) : [];

  if (names.length !== 5 || !["Component", "Component.Component"].includes(names[0]) || names[1] !== "Input" || names[4] !== "Output") {
    return fail(path, "expected component : Component Input State Msg Output (with your State and Msg names)", annotation ?? moduleNode);
  }

  const definition = root.namedChildren.find((child) => child.type === "value_declaration" && child.childForFieldName("functionDeclarationLeft")?.text === "component");
  const body = definition?.childForFieldName("body");

  if (body?.type !== "function_call_expr" || body.childForFieldName("target")?.text !== "Component.define") {
    return fail(path, "expected component = Component.define", definition ?? moduleNode);
  }

  const tag = module.split(".").map(kebab).join("-");
  const suffix = `Tag${Buffer.from(tag, "utf8").toString("hex")}`;

  return { path, module, tag, suffix, inputs, outputs };
}

export async function parseComponent(path: string): Promise<ComponentSource> {
  const source = readFileSync(path, "utf8");
  const ready = await parser();
  const tree = ready.parse(source);

  if (!tree) return fail(path, "Elm parser failed to return a syntax tree");

  try {
    return parse(tree.rootNode, path);
  } finally {
    tree.delete();
  }
}
