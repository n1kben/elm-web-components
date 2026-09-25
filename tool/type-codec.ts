import { type Expression, type GeneratedDeclaration, type GeneratedModule, type Pattern, createModule, local, ref } from "../packages/elm-ast/src/emit.ts";
import type { Type } from "../packages/elm-ast/src/index.ts";
import type { TypeNode } from "../packages/elm-ast/src/type-graph.ts";

const variable = (name: string): Pattern => ({ kind: "variable", name });

const string = (value: string): Expression => ({ kind: "string", value });

const call = (fn: Expression, ...args: Expression[]): Expression => ({ kind: "apply", function: fn, arguments: args });

const list = (...items: Expression[]): Expression => ({ kind: "list", items });

const tuple = (...items: Expression[]): Expression => ({ kind: "tuple", items });

type NameSupply = (prefix: string) => string;

function decodeApply(builder: Expression, decoders: Expression[]): Expression {
  let result = call(ref("Json.Decode", "succeed"), builder);

  for (const decoder of decoders) result = call(local("andMap"), decoder, result);

  return result;
}

function upper(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/gu, (letter, index) => `${index ? "-" : ""}${letter.toLowerCase()}`);
}

function codecName(key: string): string {
  return key.replaceAll(".", "_");
}

function tagged(tag: string, ...arguments_: Expression[]): Expression {
  return call(ref("Json.Encode", "object"), list(
    tuple(string("type"), call(ref("Json.Encode", "string"), string(tag))),
    tuple(string("args"), call(ref("Json.Encode", "list"), local("identity"), list(...arguments_))),
  ));
}

function codecFor(type: Type, context: string, direction: "encode" | "decode", fresh: NameSupply): Expression {
  switch (type.kind) {
    case "variable": return local(`${direction}${upper(type.name)}`);
    case "unit": return direction === "encode"
      ? { kind: "lambda", arguments: [{ kind: "wildcard" }], body: ref("Json.Encode", "null") }
      : call(ref("Json.Decode", "null"), { kind: "unit" });
    case "tuple": {
      const names = type.items.map(() => fresh("item"));

      if (direction === "encode") {
        return {
          kind: "lambda",
          arguments: [{ kind: "tuple", items: names.map(variable) }],
          body: call(ref("Json.Encode", "list"), local("identity"), list(...type.items.map((item, index) =>
            call(codecFor(item, context, direction, fresh), local(names[index]!))))),
        };
      }

      const builder: Expression = { kind: "lambda", arguments: names.map(variable), body: tuple(...names.map(local)) };

      const decoders = type.items.map((item, index) => call(
        ref("Json.Decode", "index"), { kind: "integer", value: index }, codecFor(item, context, direction, fresh),
      ));

      return decodeApply(builder, decoders);
    }

    case "record": {
      if (type.extension) throw new Error(`${context}: extensible record codecs are not supported`);
      const names = type.fields.map(() => fresh("field"));

      if (direction === "encode") {
        const recordName = fresh("record");

        return {
          kind: "lambda",
          arguments: [variable(recordName)],
          body: call(ref("Json.Encode", "object"), list(...type.fields.map((field) => tuple(
            string(field.name),
            call(codecFor(field.type, context, direction, fresh), { kind: "field", record: local(recordName), name: field.name }),
          )))),
        };
      }

      const record: Expression = {
        kind: "record",
        fields: type.fields.map((field, index) => ({ name: field.name, value: local(names[index]!) })),
      };

      const builder: Expression = { kind: "lambda", arguments: names.map(variable), body: record };

      const decoders = type.fields.map((field) => call(
        ref("Json.Decode", "field"), string(field.name), codecFor(field.type, context, direction, fresh),
      ));

      return decodeApply(builder, decoders);
    }

    case "named": {
      const builtin = new Map([
        ["String", "string"], ["Bool", "bool"], ["Int", "int"], ["Float", "float"],
      ]);

      const qualifier = type.module.join(".");

      const isPrimitive = qualifier === "" || (qualifier === "String" && type.name === "String")
        || (qualifier === "Basics" && ["Bool", "Int", "Float"].includes(type.name));

      const primitive = isPrimitive ? builtin.get(type.name) : undefined;

      if (primitive && type.arguments.length === 0) return ref(direction === "encode" ? "Json.Encode" : "Json.Decode", primitive);

      if (type.name === "List" && (qualifier === "" || qualifier === "List") && type.arguments.length === 1) {
        return call(ref(direction === "encode" ? "Json.Encode" : "Json.Decode", "list"), codecFor(type.arguments[0]!, context, direction, fresh));
      }

      if (type.name === "Maybe" && (qualifier === "" || qualifier === "Maybe") && type.arguments.length === 1) {
        const itemCodec = codecFor(type.arguments[0]!, context, direction, fresh);

        if (direction === "decode") {
          const tagName = fresh("tag");

          const item = call(ref("Json.Decode", "at"), list(string("args")),
            call(ref("Json.Decode", "index"), { kind: "integer", value: 0 }, itemCodec));

          return call(ref("Json.Decode", "andThen"), {
            kind: "lambda",
            arguments: [variable(tagName)],
            body: {
              kind: "case",
              value: local(tagName),
              branches: [
                { pattern: { kind: "string", value: "nothing" }, body: call(ref("Json.Decode", "succeed"), local("Nothing")) },
                { pattern: { kind: "string", value: "just" }, body: call(ref("Json.Decode", "map"), local("Just"), item) },
                { pattern: { kind: "wildcard" }, body: call(ref("Json.Decode", "fail"), string("unknown Maybe constructor")) },
              ],
            },
          }, call(ref("Json.Decode", "field"), string("type"), ref("Json.Decode", "string")));
        }

        const maybeName = fresh("maybe");
        const itemName = fresh("item");

        return {
          kind: "lambda",
          arguments: [variable(maybeName)],
          body: {
            kind: "case",
            value: local(maybeName),
            branches: [
              { pattern: { kind: "constructor", reference: local("Nothing"), arguments: [] }, body: tagged("nothing") },
              {
                pattern: { kind: "constructor", reference: local("Just"), arguments: [variable(itemName)] },
                body: tagged("just", call(itemCodec, local(itemName))),
              },
            ],
          },
        };
      }

      if (type.name === "Result" && (qualifier === "" || qualifier === "Result") && type.arguments.length === 2) {
        const errorCodec = codecFor(type.arguments[0]!, context, direction, fresh);
        const valueCodec = codecFor(type.arguments[1]!, context, direction, fresh);

        if (direction === "encode") {
          const resultName = fresh("result");
          const errorName = fresh("error");
          const valueName = fresh("resultValue");

          return {
            kind: "lambda",
            arguments: [variable(resultName)],
            body: {
              kind: "case",
              value: local(resultName),
              branches: [
                { pattern: { kind: "constructor", reference: local("Err"), arguments: [variable(errorName)] }, body: tagged("err", call(errorCodec, local(errorName))) },
                { pattern: { kind: "constructor", reference: local("Ok"), arguments: [variable(valueName)] }, body: tagged("ok", call(valueCodec, local(valueName))) },
              ],
            },
          };
        }

        const decodeArgument = (decoder: Expression): Expression => call(
          ref("Json.Decode", "at"), list(string("args")),
          call(ref("Json.Decode", "index"), { kind: "integer", value: 0 }, decoder),
        );

        const tagName = fresh("tag");

        return call(ref("Json.Decode", "andThen"), {
          kind: "lambda",
          arguments: [variable(tagName)],
          body: {
            kind: "case",
            value: local(tagName),
            branches: [
              { pattern: { kind: "string", value: "err" }, body: decodeApply(local("Err"), [decodeArgument(errorCodec)]) },
              { pattern: { kind: "string", value: "ok" }, body: decodeApply(local("Ok"), [decodeArgument(valueCodec)]) },
              { pattern: { kind: "wildcard" }, body: call(ref("Json.Decode", "fail"), string("unknown Result constructor")) },
            ],
          },
        }, call(ref("Json.Decode", "field"), string("type"), ref("Json.Decode", "string")));
      }

      const module = type.module.length ? type.module.join(".") : context;
      const name = `${direction}${codecName(`${module}.${type.name}`)}`;

      return type.arguments.length
        ? call(local(name), ...type.arguments.map((item) => codecFor(item, context, direction, fresh)))
        : local(name);
    }

    default: throw new Error(`${context}: ${type.kind} codec generation is not implemented in TypeScript yet`);
  }
}

function aliasDeclarations(node: TypeNode, fresh: NameSupply): GeneratedDeclaration[] {
  const { definition, key } = node;

  if (definition.declaration.kind !== "alias") throw new Error(`${key}: expected an alias`);
  const alias = definition.declaration;

  return (["encode", "decode"] as const).map((direction) => ({
    kind: "function" as const,
    name: `${direction}${codecName(key)}`,
    arguments: [
      ...alias.parameters.map((parameter) => variable(`${direction}${upper(parameter)}`)),
      ...(direction === "encode" ? [variable("value")] : []),
    ],
    body: direction === "encode"
      ? call(codecFor(alias.type, definition.module, direction, fresh), local("value"))
      : codecFor(alias.type, definition.module, direction, fresh),
  }));
}

function unionDeclarations(node: TypeNode, fresh: NameSupply): GeneratedDeclaration[] {
  const { definition, key } = node;

  if (definition.declaration.kind !== "union") throw new Error(`${key}: expected a union`);

  const union = definition.declaration;
  const encodeName = `encode${codecName(key)}`;
  const decodeName = `decode${codecName(key)}`;
  const encodeArguments = union.parameters.map((name) => variable(`encode${upper(name)}`));
  const decodeArguments = union.parameters.map((name) => variable(`decode${upper(name)}`));

  const encodeBranches = union.constructors.map((constructor) => {
    const argumentNames = constructor.arguments.map((_, index) => `arg${index}`);

    const pattern: Pattern = {
      kind: "constructor",
      reference: ref(definition.module, constructor.name),
      arguments: argumentNames.map(variable),
    };

    const encodedArguments = constructor.arguments.map((type, index) => call(codecFor(type, definition.module, "encode", fresh), local(argumentNames[index]!)));

    const body = call(ref("Json.Encode", "object"), list(
      tuple(string("type"), call(ref("Json.Encode", "string"), string(kebab(constructor.name)))),
      tuple(string("args"), call(ref("Json.Encode", "list"), local("identity"), list(...encodedArguments))),
    ));

    return { pattern, body };
  });

  const decodeBranches: Array<{ pattern: Pattern; body: Expression }> = union.constructors.map((constructor) => {
    const arguments_ = constructor.arguments.map((type, index) => call(
      ref("Json.Decode", "at"),
      list(string("args")),
      call(ref("Json.Decode", "index"), { kind: "integer", value: index }, codecFor(type, definition.module, "decode", fresh)),
    ));

    const body = decodeApply(ref(definition.module, constructor.name), arguments_);

    return { pattern: { kind: "string", value: kebab(constructor.name) }, body };
  });

  decodeBranches.push({
    pattern: { kind: "wildcard" },
    body: call(ref("Json.Decode", "fail"), string(`unknown ${union.name} constructor`)),
  });

  return [
    {
      kind: "function",
      name: encodeName,
      arguments: [...encodeArguments, variable("value")],
      body: { kind: "case", value: local("value"), branches: encodeBranches },
    },
    {
      kind: "function",
      name: decodeName,
      arguments: decodeArguments,
      body: call(ref("Json.Decode", "lazy"), {
        kind: "lambda",
        arguments: [{ kind: "wildcard" }],
        body: call(ref("Json.Decode", "andThen"), {
          kind: "lambda",
          arguments: [variable("tag")],
          body: {
            kind: "case",
            value: local("tag"),
            branches: decodeBranches,
          },
        }, call(ref("Json.Decode", "field"), string("type"), ref("Json.Decode", "string"))),
      }),
    },
  ];
}

/** Generate tagged JSON codecs for parsed unions and record aliases. */
export function generateCodecs(name: string, graph: Map<string, TypeNode>): GeneratedModule {
  const names = [...graph.keys()].flatMap((key) => [`encode${codecName(key)}`, `decode${codecName(key)}`]);
  const module = createModule(name, names);
  let nextName = 0;
  const fresh: NameSupply = (prefix) => `${prefix}${nextName++}`;

  module.declarations.push({
    kind: "function",
    name: "andMap",
    arguments: [variable("decoder"), variable("functionDecoder")],
    body: call(ref("Json.Decode", "map2"), {
      kind: "lambda",
      arguments: [variable("fn"), variable("item")],
      body: call(local("fn"), local("item")),
    }, local("functionDecoder"), local("decoder")),
  });

  for (const node of graph.values()) {
    module.declarations.push(...(node.definition.declaration.kind === "alias" ? aliasDeclarations(node, fresh) : unionDeclarations(node, fresh)));
  }

  return module;
}
