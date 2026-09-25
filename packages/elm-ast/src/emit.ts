import type { ElmModule, Exposure, Import, Type } from "./index.ts";

export type Reference = { kind: "reference"; module?: string; name: string };

export type Pattern =
  | { kind: "variable"; name: string }
  | { kind: "string"; value: string }
  | { kind: "wildcard" }
  | { kind: "tuple"; items: Pattern[] }
  | { kind: "constructor"; reference: Reference; arguments: Pattern[] };

export type Expression =
  | Reference
  | { kind: "string"; value: string }
  | { kind: "integer"; value: number }
  | { kind: "unit" }
  | { kind: "list"; items: Expression[] }
  | { kind: "tuple"; items: Expression[] }
  | { kind: "record"; fields: Array<{ name: string; value: Expression }> }
  | { kind: "field"; record: Expression; name: string }
  | { kind: "apply"; function: Expression; arguments: Expression[] }
  | { kind: "lambda"; arguments: Pattern[]; body: Expression }
  | { kind: "case"; value: Expression; branches: Array<{ pattern: Pattern; body: Expression }> }
  | { kind: "infix"; operator: string; left: Expression; right: Expression };

export type GeneratedDeclaration =
  | { kind: "function"; name: string; arguments: Pattern[]; annotation?: Type; body: Expression }
  | { kind: "alias"; name: string; parameters: string[]; type: Type }
  | { kind: "union"; name: string; parameters: string[]; constructors: Array<{ name: string; arguments: Type[] }> }
  | { kind: "port"; name: string; type: Type };

export type GeneratedModule = {
  name: string;
  exposing: string[] | "all";
  imports?: Import[];
  declarations: GeneratedDeclaration[];
};

export function ref(module: string, name: string): Reference {
  return { kind: "reference", module, name };
}

export function local(name: string): Reference {
  return { kind: "reference", name };
}

export function createModule(name: string, exposing: string[] | "all" = "all"): GeneratedModule {
  return { name, exposing, declarations: [] };
}

/** Copy parsed type declarations into the builder AST for inspection or rewriting. */
export function typeModuleFromParsed(parsed: ElmModule): GeneratedModule {
  const copiedTypes = new Set(parsed.declarations.filter((item) => item.kind === "alias" || item.kind === "union").map((item) => item.name));
  const exposing = parsed.exposing === "all" ? "all" : parsed.exposing.filter((item) => item.kind === "type" && copiedTypes.has(item.name)).map(printExposure);
  const module = createModule(parsed.name, exposing);
  module.imports = parsed.imports;

  for (const declaration of parsed.declarations) {
    if (declaration.kind === "alias") {
      module.declarations.push({ kind: "alias", name: declaration.name, parameters: declaration.parameters, type: declaration.type });
    } else if (declaration.kind === "union") {
      module.declarations.push({ kind: "union", name: declaration.name, parameters: declaration.parameters, constructors: declaration.constructors });
    }
  }

  return module;
}

function printExposure(item: Exposure): string {
  if (item.kind === "operator") return `(${item.name})`;

  return item.constructors ? `${item.name}(..)` : item.name;
}

function printImport(item: Import): string {
  const alias = item.alias ? ` as ${item.alias}` : "";
  const exposing = item.exposing ? ` exposing (${item.exposing === "all" ? ".." : item.exposing.map(printExposure).join(", ")})` : "";

  return `import ${item.module}${alias}${exposing}`;
}

function quoteElm(value: string): string {
  let result = '"';

  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;

    if (char === "\\") result += "\\\\";
    else if (char === '"') result += '\\"';
    else if (char === "\n") result += "\\n";
    else if (char === "\r") result += "\\r";
    else if (char === "\t") result += "\\t";
    else if (code < 32 || code === 127) result += `\\u{${code.toString(16)}}`;
    else result += char;
  }

  return result + '"';
}

function nameOf(reference: Reference): string {
  return reference.module ? `${reference.module}.${reference.name}` : reference.name;
}

export function printTypeAnnotation(type: Type, nested = false): string {
  let result: string;

  switch (type.kind) {
    case "variable": result = type.name; break;
    case "named": {
      const name = [...type.module, type.name].join(".");
      result = [name, ...type.arguments.map((item) => printTypeAnnotation(item, true))].join(" ");
      break;
    }

    case "record": {
      const fields = type.fields.map((field) => `${field.name} : ${printTypeAnnotation(field.type)}`);
      result = `{ ${type.extension ? `${type.extension} | ` : ""}${fields.join(", ")} }`;
      break;
    }

    case "tuple": result = `( ${type.items.map((item) => printTypeAnnotation(item)).join(", ")} )`; break;
    case "unit": result = "()"; break;
    case "function": result = `${printTypeAnnotation(type.argument, true)} -> ${printTypeAnnotation(type.result)}`; break;
  }

  return nested && (type.kind === "function" || (type.kind === "named" && type.arguments.length > 0)) ? `(${result})` : result;
}

function printPattern(pattern: Pattern): string {
  switch (pattern.kind) {
    case "variable": return pattern.name;
    case "string": return quoteElm(pattern.value);
    case "wildcard": return "_";
    case "tuple": return `( ${pattern.items.map(printPattern).join(", ")} )`;
    case "constructor": return [nameOf(pattern.reference), ...pattern.arguments.map((item) => item.kind === "constructor" ? `(${printPattern(item)})` : printPattern(item))].join(" ");
  }
}

function printArgumentPattern(pattern: Pattern): string {
  const rendered = printPattern(pattern);

  return pattern.kind === "constructor" && pattern.arguments.length > 0 ? `(${rendered})` : rendered;
}

function printExpression(expression: Expression, level: number, nested = false): string {
  const indent = "    ".repeat(level);
  let result: string;

  switch (expression.kind) {
    case "reference": result = nameOf(expression); break;
    case "string": result = quoteElm(expression.value); break;
    case "integer": result = String(expression.value); break;
    case "unit": result = "()"; break;
    case "list": result = `[ ${expression.items.map((item) => printExpression(item, level, false)).join(", ")} ]`; break;
    case "tuple": result = `( ${expression.items.map((item) => printExpression(item, level, false)).join(", ")} )`; break;
    case "record": result = `{ ${expression.fields.map((field) => `${field.name} = ${printExpression(field.value, level)}`).join(", ")} }`; break;
    case "field": result = `${printExpression(expression.record, level, true)}.${expression.name}`; break;
    case "apply": {
      result = [printExpression(expression.function, level, true), ...expression.arguments.map((item) => printExpression(item, level, true))].join(" ");
      break;
    }

    case "lambda": result = `\\${expression.arguments.map(printArgumentPattern).join(" ")} -> ${printExpression(expression.body, level)}`; break;
    case "infix": result = `${printExpression(expression.left, level, true)} ${expression.operator} ${printExpression(expression.right, level, true)}`; break;
    case "case": {
      result = `case ${printExpression(expression.value, level)} of\n`;

      for (const branch of expression.branches) {
        result += `${indent}    ${printPattern(branch.pattern)} ->\n${indent}        ${printExpression(branch.body, level + 2)}\n`;
      }

      result = result.trimEnd();
      break;
    }
  }

  return nested && ["apply", "lambda", "case", "infix"].includes(expression.kind) ? `(${result})` : result;
}

function collectTypeImports(type: Type, imports: Set<string>): void {
  switch (type.kind) {
    case "named":
      if (type.module.length > 0) imports.add(type.module.join("."));

      for (const argument of type.arguments) collectTypeImports(argument, imports);
      break;
    case "record":
      for (const field of type.fields) collectTypeImports(field.type, imports);
      break;
    case "tuple":
      for (const item of type.items) collectTypeImports(item, imports);
      break;
    case "function":
      collectTypeImports(type.argument, imports);
      collectTypeImports(type.result, imports);
      break;
  }
}

function collectPatternImports(pattern: Pattern, imports: Set<string>): void {
  if (pattern.kind === "tuple") {
    for (const item of pattern.items) collectPatternImports(item, imports);

    return;
  }

  if (pattern.kind !== "constructor") return;

  if (pattern.reference.module) imports.add(pattern.reference.module);

  for (const argument of pattern.arguments) collectPatternImports(argument, imports);
}

function collectExpressionImports(expression: Expression, imports: Set<string>): void {
  switch (expression.kind) {
    case "reference": if (expression.module) imports.add(expression.module); break;
    case "list": case "tuple":
      for (const item of expression.items) collectExpressionImports(item, imports);
      break;
    case "record":
      for (const field of expression.fields) collectExpressionImports(field.value, imports);
      break;
    case "field": collectExpressionImports(expression.record, imports); break;
    case "apply":
      collectExpressionImports(expression.function, imports);

      for (const argument of expression.arguments) collectExpressionImports(argument, imports);
      break;
    case "lambda":
      for (const argument of expression.arguments) collectPatternImports(argument, imports);
      collectExpressionImports(expression.body, imports);
      break;
    case "case":
      collectExpressionImports(expression.value, imports);

      for (const branch of expression.branches) {
        collectPatternImports(branch.pattern, imports);
        collectExpressionImports(branch.body, imports);
      }

      break;
    case "infix":
      collectExpressionImports(expression.left, imports);
      collectExpressionImports(expression.right, imports);
      break;
  }
}

function printDeclaration(declaration: GeneratedDeclaration): string {
  switch (declaration.kind) {
    case "function": {
      const signature = declaration.annotation ? `${declaration.name} : ${printTypeAnnotation(declaration.annotation)}\n` : "";
      const head = [declaration.name, ...declaration.arguments.map(printArgumentPattern)].join(" ");

      return `${signature}${head} =\n    ${printExpression(declaration.body, 1)}`;
    }

    case "alias": return `type alias ${declaration.name}${declaration.parameters.length ? ` ${declaration.parameters.join(" ")}` : ""} =\n    ${printTypeAnnotation(declaration.type)}`;
    case "union": return `type ${declaration.name}${declaration.parameters.length ? ` ${declaration.parameters.join(" ")}` : ""}\n    = ${declaration.constructors.map((constructor) => [constructor.name, ...constructor.arguments.map((item) => printTypeAnnotation(item, true))].join(" ")).join("\n    | ")}`;
    case "port": return `port ${declaration.name} : ${printTypeAnnotation(declaration.type)}`;
  }
}

export function printModule(module: GeneratedModule): string {
  const imports = new Set<string>();

  for (const declaration of module.declarations) {
    if (declaration.kind === "function") {
      if (declaration.annotation) collectTypeImports(declaration.annotation, imports);

      for (const argument of declaration.arguments) collectPatternImports(argument, imports);
      collectExpressionImports(declaration.body, imports);
    } else if (declaration.kind === "alias") collectTypeImports(declaration.type, imports);
    else if (declaration.kind === "union") {
      for (const constructor of declaration.constructors) for (const argument of constructor.arguments) collectTypeImports(argument, imports);
    } else collectTypeImports(declaration.type, imports);
  }

  imports.delete(module.name);
  const kind = module.declarations.some((declaration) => declaration.kind === "port") ? "port module" : "module";
  const exposing = module.exposing === "all" ? ".." : module.exposing.join(", ");
  const header = `${kind} ${module.name} exposing (${exposing})`;
  const explicit = new Map((module.imports ?? []).map((item) => [item.module, item]));

  const importLines = [...new Set([...imports, ...explicit.keys()])].sort().map((name) => {
    const item = explicit.get(name);

    return item ? printImport(item) : `import ${name}`;
  }).join("\n");

  const declarations = module.declarations.map(printDeclaration).join("\n\n");

  return [header, importLines, declarations].filter(Boolean).join("\n\n") + "\n";
}
