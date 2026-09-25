export type Position = { offset: number; row: number; column: number };

export type Range = { start: Position; end: Position };

export type Diagnostic = { message: string; position: Position };

export type Type =
  | { kind: "variable"; name: string }
  | { kind: "named"; module: string[]; name: string; arguments: Type[] }
  | { kind: "record"; extension?: string; fields: Array<{ name: string; type: Type }> }
  | { kind: "tuple"; items: Type[] }
  | { kind: "function"; argument: Type; result: Type }
  | { kind: "unit" };

export type Exposure = { name: string; kind: "value" | "type" | "operator"; constructors: boolean };

export type Import = { module: string; alias?: string; exposing?: Exposure[] | "all"; range: Range };

export type Constructor = { name: string; arguments: Type[]; range: Range };

export type Declaration =
  | { kind: "alias"; name: string; parameters: string[]; type: Type; range: Range }
  | { kind: "union"; name: string; parameters: string[]; constructors: Constructor[]; range: Range }
  | { kind: "signature"; name: string; type: Type; range: Range }
  | { kind: "value"; name: string; head?: string; source: string; range: Range }
  | { kind: "other"; source: string; range: Range };

export type ElmModule = {
  name: string;
  kind: "module" | "port module" | "effect module";
  effect?: { command?: string; subscription?: string };
  exposing: Exposure[] | "all";
  imports: Import[];
  declarations: Declaration[];
  comments: Array<{ text: string; range: Range }>;
};

type Token = { text: string; kind: "word" | "symbol" | "string" | "comment"; range: Range };

export class ElmSyntaxError extends Error {
  readonly position: Position;

  constructor(message: string, position: Position) {
    super(`${position.row}:${position.column}: ${message}`);
    this.position = position;
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let row = 1;
  let column = 1;

  const position = (): Position => ({ offset, row, column });

  const advance = (): string => {
    const char = source[offset++] ?? "";

    if (char === "\n") {
      row++;
      column = 1;
    } else {
      column++;
    }

    return char;
  };

  const add = (start: Position, kind: Token["kind"]): void => {
    tokens.push({ text: source.slice(start.offset, offset), kind, range: { start, end: position() } });
  };

  while (offset < source.length) {
    const char = source[offset] ?? "";

    if (/\s/u.test(char)) {
      advance();
      continue;
    }

    const start = position();

    if (source.startsWith("--", offset)) {
      while (offset < source.length && source[offset] !== "\n") advance();
      add(start, "comment");
      continue;
    }

    if (source.startsWith("{-", offset)) {
      advance();
      advance();
      let depth = 1;

      while (offset < source.length && depth > 0) {
        if (source.startsWith("{-", offset)) {
          advance();
          advance();
          depth++;
        } else if (source.startsWith("-}", offset)) {
          advance();
          advance();
          depth--;
        } else {
          advance();
        }
      }

      if (depth > 0) throw new ElmSyntaxError("unclosed comment", start);
      add(start, "comment");
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      const multiline = quote === '"' && source.startsWith('"""', offset);
      const delimiter = multiline ? '"""' : quote;

      for (let index = 0; index < delimiter.length; index++) advance();

      while (offset < source.length && !source.startsWith(delimiter, offset)) {
        if (source[offset] === "\\") advance();

        if (offset < source.length) advance();
      }

      if (offset >= source.length) throw new ElmSyntaxError("unclosed string or character literal", start);

      for (let index = 0; index < delimiter.length; index++) advance();
      add(start, "string");
      continue;
    }

    if (/[\p{L}_]/u.test(char)) {
      advance();

      while (offset < source.length && /[\p{L}\p{N}_']/u.test(source[offset] ?? "")) advance();
      add(start, "word");
      continue;
    }

    if (source.startsWith("->", offset) || source.startsWith("..", offset)) {
      advance();
      advance();
      add(start, "symbol");
      continue;
    }

    advance();
    add(start, "symbol");
  }

  return tokens;
}

class Cursor {
  private index = 0;
  readonly tokens: Token[];
  readonly end: Position;

  constructor(tokens: Token[], end: Position) {
    this.tokens = tokens.filter((token) => token.kind !== "comment");
    this.end = end;
  }

  peek(): Token | undefined { return this.tokens[this.index]; }
  peekAfter(distance: number): Token | undefined { return this.tokens[this.index + distance]; }
  next(): Token | undefined { return this.tokens[this.index++]; }
  take(text: string): boolean {
    if (this.peek()?.text !== text) return false;
    this.index++;

    return true;
  }

  expect(text: string): Token {
    const token = this.next();

    if (token?.text !== text) throw new ElmSyntaxError(`expected ${text}`, token?.range.start ?? this.end);

    return token;
  }

  word(): string {
    const token = this.next();

    if (token?.kind !== "word") throw new ElmSyntaxError("expected a name", token?.range.start ?? this.end);

    return token.text;
  }

  remaining(): boolean { return this.peek() !== undefined; }
}

function parseName(cursor: Cursor): string {
  let name = cursor.word();

  while (cursor.take(".")) name += `.${cursor.word()}`;

  return name;
}

function parseExposing(cursor: Cursor): Exposure[] | "all" {
  cursor.expect("(");

  if (cursor.take("..")) {
    cursor.expect(")");

    return "all";
  }

  const items: Exposure[] = [];

  while (!cursor.take(")")) {
    let kind: Exposure["kind"] = "value";
    let name: string;

    if (cursor.take("(")) {
      const operator: string[] = [];

      while (cursor.peek()?.text !== ")" && cursor.remaining()) {
        const token = cursor.next()!;

        if (token.kind !== "symbol") throw new ElmSyntaxError("expected an operator", token.range.start);
        operator.push(token.text);
      }

      if (operator.length === 0) throw new ElmSyntaxError("expected an operator", cursor.peek()?.range.start ?? cursor.end);
      name = operator.join("");
      cursor.expect(")");
      kind = "operator";
    } else {
      name = cursor.word();

      if (/^\p{Lu}/u.test(name)) kind = "type";
    }

    let constructors = false;

    if (cursor.take("(")) {
      cursor.expect("..");
      cursor.expect(")");
      constructors = true;
    }

    items.push({ name, kind, constructors });

    if (!cursor.take(",")) cursor.expect(")");
    else continue;
    break;
  }

  return items;
}

function startsTypeAtom(token: Token | undefined): boolean {
  return token?.kind === "word" || token?.text === "(" || token?.text === "{";
}

function parseTypeAtom(cursor: Cursor): Type {
  const open = cursor.peek();

  if (cursor.take("(")) {
    if (cursor.peek()?.text === ")") {
      if (open?.range.end.offset !== cursor.peek()?.range.start.offset) throw new ElmSyntaxError("unit type must be ()", open?.range.start ?? cursor.end);
      cursor.next();

      return { kind: "unit" };
    }

    const first = parseType(cursor);

    if (!cursor.take(",")) {
      cursor.expect(")");

      return first;
    }

    const items = [first, parseType(cursor)];

    while (cursor.take(",")) items.push(parseType(cursor));

    if (items.length > 3) throw new ElmSyntaxError("Elm tuples have at most three items", open?.range.start ?? cursor.end);
    cursor.expect(")");

    return { kind: "tuple", items };
  }

  if (cursor.take("{")) {
    let extension: string | undefined;

    if (cursor.peek()?.kind === "word" && cursor.peekAfter(1)?.text === "|") {
      extension = cursor.word();
      cursor.expect("|");
    }

    const fields: Array<{ name: string; type: Type }> = [];

    while (!cursor.take("}")) {
      const name = cursor.word();
      cursor.expect(":");
      fields.push({ name, type: parseType(cursor) });

      if (!cursor.take(",")) {
        cursor.expect("}");
        break;
      }
    }

    if (extension !== undefined && fields.length === 0) throw new ElmSyntaxError("extensible records need a field", open?.range.start ?? cursor.end);

    return extension === undefined ? { kind: "record", fields } : { kind: "record", extension, fields };
  }

  const name = parseName(cursor);

  if (/^\p{Ll}/u.test(name)) return { kind: "variable", name };

  const parts = name.split(".");

  return { kind: "named", module: parts.slice(0, -1), name: parts.at(-1) ?? name, arguments: [] };
}

function parseTypeApplication(cursor: Cursor): Type {
  const head = parseTypeAtom(cursor);

  if (head.kind !== "named") return head;
  const args: Type[] = [...head.arguments];

  while (startsTypeAtom(cursor.peek())) args.push(parseTypeAtom(cursor));

  return { ...head, arguments: args };
}

function parseType(cursor: Cursor): Type {
  const argument = parseTypeApplication(cursor);

  return cursor.take("->") ? { kind: "function", argument, result: parseType(cursor) } : argument;
}

export function parseTypeAnnotation(source: string): Type {
  const tokens = tokenize(source);
  const cursor = new Cursor(tokens, { offset: source.length, row: 1, column: source.length + 1 });
  const type = parseType(cursor);

  if (cursor.remaining()) throw new ElmSyntaxError("unexpected token in type", cursor.peek()?.range.start ?? cursor.end);

  return type;
}

function parseTypeDeclaration(source: string, tokens: Token[], range: Range): Declaration {
  const cursor = new Cursor(tokens, range.end);
  cursor.expect("type");
  const alias = cursor.take("alias");
  const name = cursor.word();
  const parameters: string[] = [];

  while (cursor.peek()?.kind === "word" && cursor.peek()?.text !== "=") parameters.push(cursor.word());
  cursor.expect("=");

  if (alias) {
    const type = parseType(cursor);

    if (cursor.remaining()) throw new ElmSyntaxError("unexpected token after type alias", cursor.peek()?.range.start ?? range.end);

    return { kind: "alias", name, parameters, type, range };
  }

  const constructors: Constructor[] = [];

  do {
    const start = cursor.peek()?.range.start ?? range.end;
    const constructorName = cursor.word();
    const args: Type[] = [];

    while (startsTypeAtom(cursor.peek())) args.push(parseTypeAtom(cursor));
    constructors.push({ name: constructorName, arguments: args, range: { start, end: cursor.peek()?.range.start ?? range.end } });
  } while (cursor.take("|"));

  if (cursor.remaining()) throw new ElmSyntaxError("unexpected token after type constructors", cursor.peek()?.range.start ?? range.end);

  return { kind: "union", name, parameters, constructors, range };
}

function parseValueDeclaration(source: string, tokens: Token[], range: Range): Declaration {
  const cursor = new Cursor(tokens, range.end);
  const name = cursor.word();

  if (cursor.take(":")) {
    const type = parseType(cursor);

    if (cursor.remaining()) throw new ElmSyntaxError("unexpected token after type signature", cursor.peek()?.range.start ?? range.end);

    return { kind: "signature", name, type, range };
  }

  if (cursor.take("=")) {
    let head: string | undefined;

    if (cursor.peek()?.kind === "word") head = parseName(cursor);

    return { kind: "value", name, head, source, range };
  }

  return { kind: "other", source, range };
}

export function parseModule(source: string): ElmModule {
  const tokens = tokenize(source);
  const visible = tokens.filter((token) => token.kind !== "comment");
  const end: Position = { offset: source.length, row: source.split("\n").length, column: (source.split("\n").at(-1)?.length ?? 0) + 1 };
  const cursor = new Cursor(visible, end);
  let kind: ElmModule["kind"] = "module";

  if (cursor.take("port")) kind = "port module";
  else if (cursor.take("effect")) kind = "effect module";
  cursor.expect("module");
  const name = parseName(cursor);
  let effect: ElmModule["effect"];

  if (kind === "effect module") {
    cursor.expect("where");
    cursor.expect("{");
    effect = {};

    while (!cursor.take("}")) {
      const field = cursor.word();

      if (field !== "command" && field !== "subscription") throw new ElmSyntaxError("expected command or subscription", cursor.peek()?.range.start ?? end);
      cursor.expect("=");
      effect[field] = cursor.word();

      if (!cursor.take(",")) {
        cursor.expect("}");
        break;
      }
    }
  }

  cursor.expect("exposing");
  const exposing = parseExposing(cursor);
  const headerEnd = cursor.peek()?.range.start.offset ?? source.length;
  const imports: Import[] = [];

  while (cursor.peek()?.text === "import") {
    const start = cursor.next()?.range.start ?? end;
    const module = parseName(cursor);
    const alias = cursor.take("as") ? parseName(cursor) : undefined;
    const importExposing = cursor.take("exposing") ? parseExposing(cursor) : undefined;
    imports.push({ module, alias, exposing: importExposing, range: { start, end: cursor.peek()?.range.start ?? end } });
  }

  const declarationStarts = visible.filter((token) => token.range.start.column === 1 && token.range.start.offset >= headerEnd && token.text !== "import");
  const declarations: Declaration[] = [];

  for (let index = 0; index < declarationStarts.length; index++) {
    const start = declarationStarts[index]?.range.start ?? end;
    const next = declarationStarts[index + 1]?.range.start ?? end;
    const range = { start, end: next };
    const declarationTokens = visible.filter((token) => token.range.start.offset >= start.offset && token.range.start.offset < next.offset);
    const text = source.slice(start.offset, next.offset).trimEnd();

    if (declarationTokens[0]?.text === "type") declarations.push(parseTypeDeclaration(text, declarationTokens, range));
    else if (declarationTokens[0]?.kind === "word") declarations.push(parseValueDeclaration(text, declarationTokens, range));
    else declarations.push({ kind: "other", source: text, range });
  }

  const module: ElmModule = {
    name,
    kind,
    exposing,
    imports,
    declarations,
    comments: tokens.filter((token) => token.kind === "comment").map((token) => ({ text: token.text, range: token.range })),
  };

  if (effect) module.effect = effect;

  return module;
}
