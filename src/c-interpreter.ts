// The parser is migrated to TypeScript without changing its execution model;
// its domain types will be tightened independently from the UI migration.
// @ts-nocheck

import { INTERPRETER_LIMITS } from './interpreter-limits';
import { alignAddress, formatAddress } from './memory-utils';

const TYPE_KEYWORDS = new Set(['void', 'char', 'int', 'short', 'long', 'float', 'double', 'bool']);
const KEYWORDS = new Set([
  ...TYPE_KEYWORDS,
  'struct',
  'return',
  'while',
  'if',
  'else',
  'for',
  'sizeof',
  'NULL',
  'malloc',
  'free'
]);

const PRECEDENCE = new Map([
  ['=', 1],
  ['||', 2],
  ['&&', 3],
  ['==', 4],
  ['!=', 4],
  ['<', 5],
  ['>', 5],
  ['<=', 5],
  ['>=', 5],
  ['+', 6],
  ['-', 6],
  ['*', 7],
  ['/', 7],
  ['%', 7]
]);

export class CParserError extends Error {
  constructor(message, token = null) {
    super(token?.line ? `${message} Línea ${token.line}, columna ${token.column}.` : message);
    this.name = 'CParserError';
  }
}

export class CExecutionError extends Error {
  constructor(message, code = 'execution-error', targetId = null) {
    super(message);
    this.name = 'CExecutionError';
    this.code = code;
    this.targetId = targetId;
  }
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const add = (type, value, startLine, startColumn) => {
    tokens.push({ type, value, line: startLine, column: startColumn });
  };

  const advance = (count = 1) => {
    for (let offset = 0; offset < count; offset += 1) {
      if (source[index] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      index += 1;
    }
  };

  while (index < source.length) {
    const character = source[index];
    const startLine = line;
    const startColumn = column;

    if (/\s/.test(character)) {
      advance();
      continue;
    }

    if (source.startsWith('//', index)) {
      while (index < source.length && source[index] !== '\n') advance();
      continue;
    }

    if (source.startsWith('/*', index)) {
      advance(2);
      while (index < source.length && !source.startsWith('*/', index)) advance();
      if (index >= source.length) throw new CParserError('Comentario sin cerrar.');
      advance(2);
      continue;
    }

    if (character === '#') {
      throw new CParserError('No se admiten macros ni directivas del preprocesador.', {
        line: startLine,
        column: startColumn
      });
    }

    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) advance();
      const value = source.slice(start, index);
      add(KEYWORDS.has(value) ? 'keyword' : 'identifier', value, startLine, startColumn);
      continue;
    }

    if (/\d/.test(character)) {
      const start = index;
      while (index < source.length && /[0-9.]/.test(source[index])) advance();
      add('number', source.slice(start, index), startLine, startColumn);
      continue;
    }

    if (character === '"' || character === "'") {
      const quote = character;
      const start = index;
      advance();
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') advance();
        advance();
      }
      if (source[index] !== quote) throw new CParserError('Literal sin cerrar.', {
        line: startLine,
        column: startColumn
      });
      advance();
      add('literal', source.slice(start, index), startLine, startColumn);
      continue;
    }

    const twoCharacter = source.slice(index, index + 2);
    if (['->', '==', '!=', '<=', '>=', '&&', '||', '++', '--'].includes(twoCharacter)) {
      add('operator', twoCharacter, startLine, startColumn);
      advance(2);
      continue;
    }

    if ('+-*/%<>=&!'.includes(character)) {
      add('operator', character, startLine, startColumn);
      advance();
      continue;
    }

    if (';{},().[]'.includes(character)) {
      add('punctuation', character, startLine, startColumn);
      advance();
      continue;
    }

    throw new CParserError(`Símbolo no admitido: ${character}.`, {
      line: startLine,
      column: startColumn
    });
  }

  tokens.push({ type: 'eof', value: 'EOF', line, column });
  return tokens;
}

function node(kind, tokens, data = {}) {
  return { kind, tokens, ...data } as Record<string, any>;
}

class Parser {
  private tokens: ReturnType<typeof tokenize>;
  private cursor: number;
  private nextScopeId: number;

  constructor(source) {
    this.tokens = tokenize(source);
    this.cursor = 0;
    this.nextScopeId = 0;
  }

  current() {
    return this.tokens[this.cursor];
  }

  peek(offset = 1) {
    return this.tokens[this.cursor + offset];
  }

  match(value) {
    return this.current().value === value;
  }

  consume(value = null) {
    const token = this.current();
    if (value !== null && token.value !== value) {
      throw new CParserError(`Se esperaba "${value}" y se encontró "${token.value}".`, token);
    }
    this.cursor += 1;
    return token;
  }

  expectIdentifier() {
    const token = this.consume();
    if (token.type !== 'identifier') {
      throw new CParserError('Se esperaba un identificador.', token);
    }
    return token;
  }

  isTypeStart(token = this.current()) {
    return TYPE_KEYWORDS.has(token.value) || token.value === 'struct';
  }

  parseType() {
    const start = this.cursor;
    let base;
    if (this.match('struct')) {
      this.consume('struct');
      const name = this.expectIdentifier();
      base = `struct ${name.value}`;
    } else {
      base = this.consume().value;
    }

    let pointerDepth = 0;
    while (this.match('*')) {
      this.consume('*');
      pointerDepth += 1;
    }

    return {
      base,
      pointerDepth,
      tokens: this.tokens.slice(start, this.cursor)
    };
  }

  parseStructDefinition() {
    const start = this.cursor;
    this.consume('struct');
    const name = this.expectIdentifier();
    this.consume('{');
    const fields = [];

    while (!this.match('}')) {
      if (this.current().type === 'eof') throw new CParserError('Struct sin cerrar.', this.current());
      const type = this.parseType();
      const field = this.expectIdentifier();
      this.consume(';');
      fields.push({ name: field.value, type });
    }

    this.consume('}');
    this.consume(';');
    return node('struct-definition', this.tokens.slice(start, this.cursor), {
      name: name.value,
      fields
    });
  }

  parseDeclaration(type = null) {
    const start = this.cursor;
    const declaredType = type ?? this.parseType();
    const name = this.expectIdentifier();
    let arrayLength = null;
    if (this.match('[')) {
      this.consume('[');
      const lengthToken = this.consume();
      if (lengthToken.type !== 'number' || !/^\d+$/.test(lengthToken.value) || Number(lengthToken.value) < 1) {
        throw new CParserError('El tamaño del arreglo debe ser un entero positivo.', lengthToken);
      }
      arrayLength = Number(lengthToken.value);
      this.consume(']');
    }
    let initializer = null;
    if (this.match('=')) {
      this.consume('=');
      initializer = this.parseExpression();
    }
    this.consume(';');
    return node('declaration', this.tokens.slice(start, this.cursor), {
      name: name.value,
      type: arrayLength === null ? declaredType : { ...declaredType, arrayLength },
      initializer
    });
  }

  parseParameter() {
    const type = this.parseType();
    const name = this.expectIdentifier();
    return { name: name.value, type };
  }

  parseFunction(type = null) {
    const start = this.cursor;
    const returnType = type ?? this.parseType();
    const name = this.expectIdentifier();
    this.consume('(');
    const parameters = [];

    if (!this.match(')')) {
      if (!this.match('void')) {
        parameters.push(this.parseParameter());
        while (this.match(',')) {
          this.consume(',');
          parameters.push(this.parseParameter());
        }
      } else {
        this.consume('void');
      }
    }

    this.consume(')');
    const body = this.parseBlock({
      scopeKind: 'function',
      scopeLabel: `${name.value}()`
    });
    const tokens = this.tokens.slice(start, this.cursor);
    const headerEnd = tokens.findIndex((token) => token.value === '{');
    return node('function', tokens, {
      name: name.value,
      returnType,
      parameters,
      body,
      headerTokens: [
        ...(type ? returnType.tokens : []),
        ...tokens.slice(0, headerEnd)
      ]
    });
  }

  parseBlock({ scopeKind = 'block', scopeLabel = 'ámbito' } = {}) {
    const start = this.cursor;
    const openToken = this.consume('{');
    const statements = [];
    while (!this.match('}')) {
      if (this.current().type === 'eof') throw new CParserError('Bloque sin cerrar.', this.current());
      statements.push(this.parseStatement());
    }
    const closeToken = this.consume('}');
    return node('block', this.tokens.slice(start, this.cursor), {
      statements,
      openToken,
      closeToken,
      scopeId: `scope-${++this.nextScopeId}`,
      scopeKind,
      scopeLabel
    });
  }

  parseStatement() {
    if (this.match('{')) return this.parseBlock();

    if (this.match('while')) {
      const start = this.cursor;
      this.consume('while');
      this.consume('(');
      const condition = this.parseExpression();
      this.consume(')');
      const headerEnd = this.cursor;
      const body = this.match('{')
        ? this.parseBlock({ scopeKind: 'while', scopeLabel: 'while' })
        : this.parseStatement();
      return node('while', this.tokens.slice(start, this.cursor), {
        condition,
        body,
        headerTokens: this.tokens.slice(start, headerEnd)
      });
    }

    if (this.match('return')) {
      const start = this.cursor;
      this.consume('return');
      const expression = this.match(';') ? null : this.parseExpression();
      this.consume(';');
      return node('return', this.tokens.slice(start, this.cursor), { expression });
    }

    if (this.isTypeStart()) return this.parseDeclaration();

    const start = this.cursor;
    const expression = this.parseExpression();
    this.consume(';');
    return node('expression-statement', this.tokens.slice(start, this.cursor), { expression });
  }

  parsePrimary() {
    const token = this.current();
    if (token.type === 'number' || token.type === 'literal') {
      this.consume();
      return node('literal', [token], { value: token.value });
    }

    if (token.value === 'NULL') {
      this.consume();
      return node('null', [token]);
    }

    if (token.type === 'identifier' || ['malloc', 'free'].includes(token.value)) {
      this.consume();
      return node('identifier', [token], { name: token.value });
    }

    if (this.match('(')) {
      this.consume('(');
      const expression = this.parseExpression();
      this.consume(')');
      return expression;
    }

    throw new CParserError('Expresión no reconocida.', token);
  }

  parsePostfix(expression) {
    let result = expression;
    while (true) {
      if (this.match('(')) {
        this.consume('(');
        const args = [];
        if (!this.match(')')) {
          args.push(this.parseExpression());
          while (this.match(',')) {
            this.consume(',');
            args.push(this.parseExpression());
          }
        }
        this.consume(')');
        result = node('call', [...(result.tokens ?? []), ...args.flatMap((arg) => arg.tokens)], {
          callee: result.name,
          args
        });
        continue;
      }

      if (this.match('->') || this.match('.')) {
        const operator = this.consume().value;
        const field = this.expectIdentifier();
        result = node('member', [...(result.tokens ?? []), field], {
          object: result,
          field: field.value,
          operator
        });
        continue;
      }

      if (this.match('[')) {
        this.consume('[');
        const index = this.parseExpression();
        this.consume(']');
        result = node('index', [...(result.tokens ?? []), ...(index.tokens ?? [])], {
          object: result,
          index
        });
        continue;
      }

      break;
    }
    return result;
  }

  parseUnary() {
    if (['&', '*', '!', '-', '+'].includes(this.current().value)) {
      const operator = this.consume();
      const operand = this.parseUnary();
      return node('unary', [operator, ...(operand.tokens ?? [])], { operator: operator.value, operand });
    }

    if (this.match('sizeof')) {
      const start = this.cursor;
      this.consume('sizeof');
      this.consume('(');
      const type = this.parseType();
      this.consume(')');
      return node('sizeof', this.tokens.slice(start, this.cursor), { type });
    }

    return this.parsePostfix(this.parsePrimary());
  }

  parseExpression(minimumPrecedence = 1) {
    let left = this.parseUnary();

    while (PRECEDENCE.has(this.current().value)
      && PRECEDENCE.get(this.current().value) >= minimumPrecedence) {
      const operator = this.consume().value;
      const precedence = PRECEDENCE.get(operator);
      const right = this.parseExpression(operator === '=' ? precedence : precedence + 1);
      left = node('binary', [...(left.tokens ?? []), { value: operator }, ...(right.tokens ?? [])], {
        operator,
        left,
        right
      });
    }

    return left;
  }

  parse() {
    const structs = new Map();
    const functions = new Map();
    const globals = [];

    while (this.current().type !== 'eof') {
      if (this.match('struct') && this.peek(2)?.value === '{') {
        const definition = this.parseStructDefinition();
        structs.set(definition.name, definition);
        continue;
      }

      const type = this.parseType();
      const name = this.expectIdentifier();
      if (this.match('(')) {
        this.cursor -= 1;
        const functionNode = this.parseFunction(type);
        functions.set(functionNode.name, functionNode);
      } else {
        this.cursor -= 1;
        globals.push(this.parseDeclaration(type));
      }
    }

    return { kind: 'program', structs, functions, globals };
  }
}

export function parseC(source) {
  if (typeof source !== 'string') {
    throw new CParserError('El código debe ser texto.');
  }

  if (source.length > INTERPRETER_LIMITS.maxSourceLength) {
    throw new CParserError(
      `El código supera el límite de ${INTERPRETER_LIMITS.maxSourceLength} caracteres.`
    );
  }

  return new Parser(source).parse();
}

function typeKey(type) {
  return `${type.base}${'*'.repeat(type.pointerDepth)}${type.arrayLength ? `[${type.arrayLength}]` : ''}`;
}

function isPointer(type) {
  return type.pointerDepth > 0;
}

function pointerType(type) {
  return { base: type.base, pointerDepth: type.pointerDepth + 1 };
}

function clonePointer(pointer) {
  return pointer && pointer.kind === 'pointer'
    ? { ...pointer, target: pointer.target ? { ...pointer.target } : null }
    : pointer;
}

function formatScalar(value) {
  if (value === undefined) return '?';
  if (value === null) return 'NULL';
  if (value?.kind === 'pointer') return value.target ? formatAddress(value.target.address) : 'NULL';
  if (value?.kind === 'array') return '[...]';
  return String(value);
}

function pointerTargetKey(pointer) {
  if (!pointer?.target) return 'NULL';
  return pointer.target.id;
}

class ReturnSignal {
  value: any;
  tokens: any;

  constructor(value, tokens) {
    this.value = value;
    this.tokens = tokens;
  }
}

class CInterpreter {
  [key: string]: any;

  constructor(ast, {
    maxSteps = INTERPRETER_LIMITS.maxSteps,
    maxCallDepth = INTERPRETER_LIMITS.maxCallDepth
  } = {}) {
    this.ast = ast;
    this.structs = ast.structs;
    this.functions = ast.functions;
    this.frames = [];
    this.heap = [];
    this.trace = [];
    this.activeScopes = [];
    this.nextStackAddress = 0x100;
    this.nextHeapAddress = 0x300;
    this.frameId = 0;
    this.objectId = 0;
    this.scopeActivationId = 0;
    this.maxSteps = maxSteps;
    this.maxCallDepth = maxCallDepth;
    this.lastContext = null;
  }

  typeSize(type) {
    let scalarSize;
    if (isPointer(type)) scalarSize = 8;
    else if (type.base === 'char') scalarSize = 1;
    else if (type.base === 'short') scalarSize = 2;
    else if (type.base === 'long' || type.base === 'double') scalarSize = 8;
    else if (type.base.startsWith('struct ')) scalarSize = this.structLayout(type.base.slice(7)).size;
    else scalarSize = 4;
    return scalarSize * (type.arrayLength ?? 1);
  }

  typeAlignment(type) {
    if (isPointer(type)) return 8;
    if (type.base.startsWith('struct ')) return this.structLayout(type.base.slice(7)).alignment;
    return Math.min(this.typeSize({ ...type, arrayLength: null }), 8);
  }

  structLayout(name) {
    const definition = this.structs.get(name);
    if (!definition) throw new CExecutionError(`El struct "${name}" no está declarado.`);
    let offset = 0;
    let alignment = 1;
    const fields = definition.fields.map((field) => {
      const fieldAlignment = this.typeAlignment(field.type);
      offset = alignAddress(offset, fieldAlignment);
      const layout = { ...field, offset, size: this.typeSize(field.type) };
      offset += layout.size;
      alignment = Math.max(alignment, fieldAlignment);
      return layout;
    });
    return { fields, alignment, size: alignAddress(offset, alignment) };
  }

  defaultValue(type) {
    if (type.arrayLength) {
      return {
        kind: 'array',
        type: { ...type, arrayLength: null },
        values: Array.from({ length: type.arrayLength }, () => this.defaultValue({ ...type, arrayLength: null }))
      };
    }
    if (isPointer(type)) return { kind: 'pointer', type: pointerType(type), target: null };
    return undefined;
  }

  pushFrame(functionNode) {
    if (this.frames.length >= this.maxCallDepth) {
      throw new CExecutionError(
        `La ejecución superó el límite de profundidad de llamadas (${this.maxCallDepth}).`
      );
    }

    const gap = this.frames.length === 0 ? 0 : 0x20;
    const baseAddress = alignAddress(this.nextStackAddress + gap, 8);
    const frame = {
      id: `frame-${++this.frameId}`,
      name: functionNode.name,
      functionNode,
      variables: new Map(),
      nextAddress: baseAddress
    };
    this.nextStackAddress = baseAddress + 0x20;
    this.frames.push(frame);
    return frame;
  }

  popFrame() {
    return this.frames.pop();
  }

  currentFrame() {
    const frame = this.frames.at(-1);
    if (!frame) throw new CExecutionError('No existe un marco de ejecución activo.');
    return frame;
  }

  currentScope() {
    return this.activeScopes.at(-1) ?? null;
  }

  enterScope(scopeNode, { includeExisting = false } = {}) {
    const frame = this.currentFrame();
    const scope = {
      id: `${scopeNode.scopeId}:${frame.id}:${++this.scopeActivationId}`,
      sourceId: scopeNode.scopeId,
      kind: scopeNode.scopeKind,
      label: scopeNode.scopeLabel,
      openToken: scopeNode.openToken,
      closeToken: scopeNode.closeToken,
      frame,
      variableIds: new Set()
    };

    if (includeExisting) {
      frame.variables.forEach((cell) => scope.variableIds.add(cell.id));
    }

    this.activeScopes.push(scope);
    this.record([scopeNode.openToken], `Entrando al ámbito ${scope.label}.`, {
      kind: 'scope-open',
      sourceKey: `${scopeNode.scopeId}:open`,
      scopeId: scope.id,
      scopeKind: scope.kind,
      scopeLabel: scope.label,
      scopeDepth: this.activeScopes.length - 1
    });
    return scope;
  }

  exitScope(scope, { record = true } = {}) {
    if (this.activeScopes.at(-1) !== scope) {
      throw new CExecutionError('Cierre de ámbito fuera de orden.');
    }

    scope.variableIds.forEach((id) => scope.frame.variables.delete(
      [...scope.frame.variables.entries()].find(([, cell]) => cell.id === id)?.[0]
    ));
    this.activeScopes.pop();
    if (record) {
      this.record([scope.closeToken], `Saliendo del ámbito ${scope.label}.`, {
        kind: 'scope-close',
        sourceKey: `${scope.sourceId}:close`,
        scopeId: scope.id,
        scopeKind: scope.kind,
        scopeLabel: scope.label,
        scopeDepth: this.activeScopes.length
      });
    }
  }

  lookup(name) {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const cell = this.frames[index].variables.get(name);
      if (cell) return cell;
    }
    throw new CExecutionError(`La variable "${name}" no está declarada.`);
  }

  declare(frame, name, type, value) {
    if (frame.variables.has(name)) throw new CExecutionError(`La variable "${name}" ya fue declarada.`);
    const alignment = this.typeAlignment(type);
    frame.nextAddress = alignAddress(frame.nextAddress, alignment);
    const cell = {
      id: `stack:${frame.id}:${name}`,
      kind: 'cell',
      name,
      type,
      value,
      address: formatAddress(frame.nextAddress),
      frameId: frame.id,
      frameName: frame.name
    };
    frame.variables.set(name, cell);
    if (this.currentScope()?.frame === frame) this.currentScope().variableIds.add(cell.id);
    frame.nextAddress += this.typeSize(type);
    return cell;
  }

  createPointer(type, target = null) {
    return { kind: 'pointer', type, target: target ? { ...target } : null };
  }

  refAddress(ref) {
    return ref?.address ?? null;
  }

  pointerFromRef(ref, type) {
    return this.createPointer(type, {
      id: ref.id,
      kind: ref.kind,
      address: ref.address,
      cell: ref.kind === 'cell' ? ref : null,
      object: ref.object,
      field: ref.kind === 'field' ? ref : null
    });
  }

  readRef(ref) {
    if (!ref) throw new CExecutionError('Referencia inválida.');
    if (ref.kind === 'cell') return ref.value;
    if (ref.kind === 'array-element') return ref.array.values[ref.index];
    if (ref.kind === 'heap-object') {
      if (ref.freed) throw new CExecutionError(
        'Se intentó leer memoria después de liberarla.',
        'use-after-free',
        ref.id
      );
      return ref.value;
    }
    if (ref.kind === 'field') {
      if (ref.object.freed) throw new CExecutionError(
        'Se intentó leer un nodo después de liberarlo.',
        'use-after-free',
        ref.object.id
      );
      return ref.value;
    }
    throw new CExecutionError('La referencia no es legible.');
  }

  writeRef(ref, value) {
    if (!ref) throw new CExecutionError('Referencia inválida.');
    if (ref.kind === 'array-element') {
      ref.array.values[ref.index] = value;
      return;
    }
    if (ref.kind === 'heap-object') {
      if (ref.freed) throw new CExecutionError(
        'Se intentó escribir en memoria después de liberarla.',
        'use-after-free',
        ref.id
      );
      ref.value = value;
      return;
    }
    if (ref.kind === 'field' && ref.object.freed) {
      throw new CExecutionError(
        'Se intentó escribir en un nodo después de liberarlo.',
        'use-after-free',
        ref.object.id
      );
    }
    ref.value = value;
  }

  pointerSourceId(expression) {
    if (expression?.kind !== 'identifier') return null;
    return this.lookup(expression.name)?.id ?? null;
  }

  objectFromPointer(pointer, sourceId = null) {
    if (!pointer?.target) throw new CExecutionError(
      'No se puede desreferenciar NULL.',
      'null-dereference',
      sourceId
    );
    if (pointer.target.object) {
      if (pointer.target.object.freed) throw new CExecutionError(
        'El puntero se usa después de liberar su memoria.',
        'use-after-free',
        pointer.target.object.id
      );
      return pointer.target.object;
    }
    throw new CExecutionError('El puntero no apunta a un struct.');
  }

  fieldRef(object, fieldName) {
    const layout = this.structLayout(object.typeName);
    const fieldLayout = layout.fields.find((field) => field.name === fieldName);
    if (!fieldLayout) throw new CExecutionError(`El struct no tiene un campo "${fieldName}".`);
    return object.fields.get(fieldName);
  }

  resolveLvalue(expression) {
    if (expression.kind === 'identifier') return this.lookup(expression.name);

    if (expression.kind === 'unary' && expression.operator === '*') {
      const pointer = this.evaluate(expression.operand);
      if (!pointer?.target) throw new CExecutionError(
        'No se puede escribir a través de NULL.',
        'null-dereference',
        this.pointerSourceId(expression.operand)
      );
      if (pointer.target.cell) return pointer.target.cell;
      if (pointer.target.field) return pointer.target.field;
      if (pointer.target.object) {
        return pointer.target.object;
      }
      throw new CExecutionError('El puntero no apunta a un valor asignable.');
    }

    if (expression.kind === 'index') {
      const arrayRef = expression.object.kind === 'identifier'
        ? this.lookup(expression.object.name)
        : this.resolveLvalue(expression.object);
      const array = arrayRef?.value;
      const index = this.evaluate(expression.index);
      if (arrayRef?.kind !== 'cell' || array?.kind !== 'array') {
        throw new CExecutionError('El valor no es un arreglo indexable.');
      }
      if (!Number.isInteger(index) || index < 0 || index >= array.values.length) {
        throw new CExecutionError(
          `Acceso fuera de rango: índice ${index} para un arreglo de ${array.values.length} elementos.`,
          'out-of-bounds',
          arrayRef.id
        );
      }
      return {
        id: `${arrayRef.id}[${index}]`,
        kind: 'array-element',
        name: `[${index}]`,
        type: { ...array.type },
        value: array.values[index],
        array,
        index,
        parent: arrayRef
      };
    }

    if (expression.kind === 'member') {
      const object = expression.operator === '->'
        ? this.objectFromPointer(
          this.evaluate(expression.object),
          this.pointerSourceId(expression.object)
        )
        : this.evaluate(expression.object);
      return this.fieldRef(object, expression.field);
    }

    throw new CExecutionError('La expresión no es asignable.');
  }

  literalValue(value) {
    if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    return value;
  }

  evaluate(expression, { returnTarget = null } = {}) {
    if (!expression) return undefined;

    switch (expression.kind) {
      case 'literal':
        return this.literalValue(expression.value);
      case 'null':
        return this.createPointer({ base: 'void', pointerDepth: 1 });
      case 'identifier':
        return this.readRef(this.lookup(expression.name));
      case 'sizeof':
        return this.typeSize(expression.type);
      case 'member':
        return this.readRef(this.resolveLvalue(expression));
      case 'index':
        return this.readRef(this.resolveLvalue(expression));
      case 'unary': {
        if (expression.operator === '&') {
          const ref = this.resolveLvalue(expression.operand);
          return this.pointerFromRef(ref, pointerType(ref.type));
        }
        if (expression.operator === '*') {
          return this.readRef(this.resolveLvalue(expression));
        }
        const value = this.evaluate(expression.operand);
        if (expression.operator === '!') return this.truthy(value) ? 0 : 1;
        if (expression.operator === '-') return -Number(value);
        if (expression.operator === '+') return Number(value);
        return value;
      }
      case 'binary': {
        if (expression.operator === '=') {
          const target = this.resolveLvalue(expression.left);
          const value = this.evaluate(expression.right, { returnTarget: target });
          this.writeRef(target, value);
          return value;
        }
        const left = this.evaluate(expression.left);
        if (expression.operator === '&&' && !this.truthy(left)) return 0;
        if (expression.operator === '||' && this.truthy(left)) return 1;
        const right = this.evaluate(expression.right);
        return this.binaryValue(expression.operator, left, right);
      }
      case 'call':
        return this.evaluateCall(expression, { returnTarget });
      default:
        throw new CExecutionError('Expresión no soportada por el intérprete.');
    }
  }

  binaryValue(operator, left, right) {
    if (['==', '!='].includes(operator)) {
      const equal = left?.kind === 'pointer' || right?.kind === 'pointer'
        ? pointerTargetKey(left) === pointerTargetKey(right)
        : left === right;
      return operator === '==' ? (equal ? 1 : 0) : (equal ? 0 : 1);
    }
    if (['<', '>', '<=', '>='].includes(operator)) {
      const result = operator === '<' ? left < right
        : operator === '>' ? left > right
          : operator === '<=' ? left <= right : left >= right;
      return result ? 1 : 0;
    }
    if (operator === '&&') return this.truthy(left) && this.truthy(right) ? 1 : 0;
    if (operator === '||') return this.truthy(left) || this.truthy(right) ? 1 : 0;
    const numericLeft = Number(left);
    const numericRight = Number(right);
    if (Number.isNaN(numericLeft) || Number.isNaN(numericRight)) {
      throw new CExecutionError(`No se puede aplicar ${operator} a esos valores.`);
    }
    if (operator === '+') return numericLeft + numericRight;
    if (operator === '-') return numericLeft - numericRight;
    if (operator === '*') return numericLeft * numericRight;
    if (operator === '/') return numericLeft / numericRight;
    if (operator === '%') return numericLeft % numericRight;
    throw new CExecutionError(`Operador no soportado: ${operator}.`);
  }

  truthy(value) {
    if (value?.kind === 'pointer') return Boolean(value.target);
    return Boolean(value);
  }

  allocateHeap(type) {
    const name = type.base.startsWith('struct ') ? type.base.slice(7) : null;
    const size = name ? this.structLayout(name).size : this.typeSize(type);
    const address = formatAddress(alignAddress(this.nextHeapAddress, this.typeAlignment(type)));
    const object = {
      id: `heap-${++this.objectId}`,
      kind: 'heap-object',
      name: name ? `node ${this.objectId}` : `bloque ${this.objectId}`,
      typeName: name,
      type,
      address,
      size,
      freed: false,
      value: undefined,
      fields: new Map()
    };

    if (name) {
      this.structLayout(name).fields.forEach((field) => {
        const fieldAddress = formatAddress(Number.parseInt(address.slice(2), 16) + field.offset);
        object.fields.set(field.name, {
          id: `${object.id}:${field.name}`,
          kind: 'field',
          name: field.name,
          type: field.type,
          value: this.defaultValue(field.type),
          address: fieldAddress,
          object
        });
      });
    }

    this.heap.push(object);
    this.nextHeapAddress = Number.parseInt(address.slice(2), 16) + size;
    return this.createPointer(type, { id: object.id, kind: 'object', address, object });
  }

  evaluateCall(expression, { returnTarget = null } = {}) {
    if (expression.callee === 'malloc') {
      const sizeExpression = expression.args[0];
      const type = sizeExpression?.kind === 'sizeof'
        ? sizeExpression.type
        : { base: 'char', pointerDepth: 0 };
      return this.allocateHeap(type);
    }

    if (expression.callee === 'free') {
      if (expression.args.length !== 1) {
        throw new CExecutionError('free requiere exactamente un puntero.');
      }
      const pointer = this.evaluate(expression.args[0]);
      if (pointer?.kind !== 'pointer') {
        throw new CExecutionError('free necesita un puntero de heap válido.');
      }
      if (!pointer.target) return undefined;
      if (!pointer.target.object) {
        throw new CExecutionError('free necesita un puntero de heap válido.');
      }
      if (pointer.target.object.freed) {
        throw new CExecutionError(
          'Se intentó liberar memoria dos veces.',
          'double-free',
          pointer.target.object.id
        );
      }
      pointer.target.object.freed = true;
      return undefined;
    }

    return this.callFunction(
      expression.callee,
      expression.args.map((argument) => this.evaluate(argument)),
      expression.args,
      returnTarget
    );
  }

  bindParameter(frame, parameter, value) {
    this.declare(frame, parameter.name, parameter.type, parameter.type.pointerDepth > 0
      ? clonePointer(value)
      : value);
  }

  parameterTokens(parameter, argumentExpression) {
    const sourceToken = argumentExpression?.tokens?.[0] ?? parameter.type.tokens[0];
    const position = {
      line: sourceToken?.line ?? 1,
      column: sourceToken?.column ?? 1
    };
    return [
      ...parameter.type.tokens,
      { type: 'identifier', value: parameter.name, ...position },
      { type: 'operator', value: '=', ...position },
      ...(argumentExpression?.tokens ?? []),
      { type: 'punctuation', value: ';', ...position }
    ];
  }

  callFunction(name, args, argumentExpressions = [], returnTarget = null) {
    const functionNode = this.functions.get(name);
    if (!functionNode) throw new CExecutionError(`La función "${name}" no está declarada.`);
    const frame = this.pushFrame(functionNode);
    const functionScope = this.enterScope(functionNode.body);
    functionNode.parameters.forEach((parameter, index) => {
      this.bindParameter(frame, parameter, args[index]);
      this.record(
        this.parameterTokens(parameter, argumentExpressions[index]),
        `Declarando ${parameter.name} como parámetro.`,
        {
          sourceKey: `function:${functionNode.name}:parameter:${parameter.name}`,
          implicit: true
        }
      );
    });

    let result;
    let returnSignal = null;
    try {
      functionNode.body.statements.forEach((statement) => this.executeStatement(statement));
    } catch (signal) {
      if (!(signal instanceof ReturnSignal)) throw signal;
      result = signal.value;
      returnSignal = signal;
    } finally {
      // A function return is one atomic transfer: its frame disappears and
      // the caller receives the value in the same trace snapshot. The closing
      // brace remains visible in the source, but is not another executable
      // step for the function.
      this.exitScope(functionScope, { record: false });
      this.popFrame();
    }

    if (returnSignal) {
      if (returnTarget) this.writeRef(returnTarget, result);
      this.record(returnSignal.tokens, `Retornando ${formatScalar(result)}.`, {
        kind: 'return',
        sourceKey: traceOperationKey(functionNode.name, returnSignal.tokens),
        scopeId: functionScope.id,
        scopeKind: 'function',
        scopeLabel: functionScope.label,
        scopeDepth: this.activeScopes.length,
        functionReturn: true
      });
    } else {
      // A void function still needs an explicit executable endpoint. This
      // lets the renderer treat a collapsed call as one atomic transition
      // even when the function has no `return` statement of its own.
      this.record([functionScope.closeToken], `Saliendo del ámbito ${functionScope.label}.`, {
        kind: 'scope-close',
        sourceKey: `${functionScope.sourceId}:close`,
        scopeId: functionScope.id,
        scopeKind: 'function',
        scopeLabel: functionScope.label,
        scopeDepth: this.activeScopes.length
      });
    }
    return result;
  }

  executeStatement(statement) {
    this.lastContext = {
      functionName: this.currentFrame().name,
      line: statement.tokens?.[0]?.line ?? '?'
    };

    try {
      return this.executeStatementUnsafe(statement);
    } catch (error) {
      if (error instanceof CExecutionError && [
        'use-after-free',
        'double-free',
        'null-dereference',
        'out-of-bounds'
      ].includes(error.code)) {
        this.recordError(statement, error);
        return undefined;
      }
      throw error;
    }
  }

  executeStatementUnsafe(statement) {

    if (statement.kind === 'block') {
      const blockScope = this.enterScope(statement);
      try {
        statement.statements.forEach((child) => this.executeStatement(child));
      } finally {
        this.exitScope(blockScope);
      }
      return;
    }

    if (statement.kind === 'declaration') {
      const frame = this.currentFrame();
      const sourceKey = `${frame.name}:declaration:${statement.tokens?.[0]?.line ?? '?'}:${statement.name}`;
      const isFunctionCall = statement.initializer?.kind === 'call'
        && this.functions.has(statement.initializer.callee);

      if (isFunctionCall) {
        // Reserve the destination before entering the called function. The
        // value remains unknown until the return value comes back.
        const cell = this.declare(frame, statement.name, statement.type, undefined);
        this.record(statement.tokens, `Declarando ${statement.name} sin valor.`, { sourceKey });
        this.evaluate(statement.initializer, { returnTarget: cell });
        return;
      }

      const value = statement.initializer
        ? this.evaluate(statement.initializer)
        : this.defaultValue(statement.type);
      this.declare(frame, statement.name, statement.type, value);
      this.record(statement.tokens, `Declarando ${statement.name}.`, { sourceKey });
      return;
    }

    if (statement.kind === 'expression-statement') {
      this.evaluate(statement.expression);
      this.record(statement.tokens, 'Ejecutando la expresión.');
      return;
    }

    if (statement.kind === 'while') {
      let iterations = 0;
      while (true) {
        const condition = this.evaluate(statement.condition);
        this.record(statement.headerTokens, `Evaluando while: ${this.truthy(condition) ? 'verdadero' : 'falso'}.`);
        if (!this.truthy(condition)) break;
        iterations += 1;
        if (iterations > this.maxSteps) {
          throw new CExecutionError('El while superó el límite de seguridad de iteraciones.');
        }
        this.executeStatement(statement.body);
      }
      return;
    }

    if (statement.kind === 'return') {
      const value = statement.expression ? this.evaluate(statement.expression) : undefined;
      throw new ReturnSignal(value, statement.tokens);
    }

    throw new CExecutionError(`Sentencia no soportada: ${statement.kind}.`);
  }

  snapshot() {
    const stack = [];
    const stackCells = this.frames.flatMap((frame) => [...frame.variables.values()]);
    const aliasesByTarget = new Map();
    const reachableHeapIds = new Set();
    const visitedObjects = new Set();

    const visitPointer = (pointer) => {
      if (pointer?.kind !== 'pointer' || !pointer.target) return;
      const target = pointer.target;
      if (target.object) {
        if (target.object.freed || visitedObjects.has(target.object.id)) return;
        visitedObjects.add(target.object.id);
        reachableHeapIds.add(target.object.id);
        target.object.fields.forEach((field) => visitPointer(field.value));
        return;
      }
      if (target.cell) {
        visitPointer(target.cell.value);
        return;
      }
      if (target.field) visitPointer(target.field.value);
    };

    const pointerState = (value) => (
      value?.kind === 'pointer'
      && value.target?.object?.freed
        ? 'dangling'
        : null
    );

    stackCells.forEach((cell) => visitPointer(cell.value));
    const addAlias = (target, alias) => {
      if (!target?.id) return;
      const aliases = aliasesByTarget.get(target.id) ?? [];
      if (!aliases.includes(alias)) aliases.push(alias);
      aliasesByTarget.set(target.id, aliases);
    };

    stackCells.forEach((cell) => {
      const pointer = cell.value;
      if (pointer?.kind !== 'pointer' || !pointer.target) return;
      if (pointer.target.cell) addAlias(pointer.target.cell, `*${cell.name}`);
      if (pointer.target.field) addAlias(pointer.target.field, `*${cell.name}`);
    });

    this.frames.forEach((frame, frameIndex) => {
      frame.variables.forEach((cell) => {
        const item = {
          id: cell.id,
          area: 'STACK',
          address: cell.address,
          name: cell.name,
          value: formatScalar(cell.value),
          type: typeKey(cell.type),
          pointerTargetId: cell.value?.kind === 'pointer' ? cell.value.target?.id ?? null : null,
          pointerState: pointerState(cell.value),
          size: this.typeSize(cell.type),
          alignment: this.typeAlignment(cell.type),
          frameId: frame.id,
          frameName: frame.name,
          frameLabel: `${frame.name}()`,
          frameIndex,
          aliases: aliasesByTarget.get(cell.id) ?? []
        };
        if (cell.value?.kind === 'array') {
          const elementType = { ...cell.type, arrayLength: null };
          item.fields = cell.value.values.map((value, index) => ({
            id: `${cell.id}[${index}]`,
            name: `[${index}]`,
            address: formatAddress(Number.parseInt(cell.address.slice(2), 16) + index * this.typeSize(elementType)),
            value: formatScalar(value),
            type: typeKey(elementType),
            pointerTargetId: value?.kind === 'pointer' ? value.target?.id ?? null : null,
            pointerState: pointerState(value),
            aliases: []
          }));
        }
        stack.push(item);
      });
    });

    const heap = this.heap.map((object) => ({
      id: object.id,
      area: 'HEAP',
      address: object.address,
      name: object.name,
      value: object.freed
        ? 'liberado'
        : object.typeName
          ? ''
          : formatScalar(object.value),
      size: object.size,
      freed: object.freed,
      unreachable: !object.freed && !reachableHeapIds.has(object.id),
      fields: [...object.fields.values()].map((field) => ({
        id: field.id,
        name: field.name,
        address: field.address,
        value: formatScalar(field.value),
        type: typeKey(field.type),
        pointerTargetId: field.value?.kind === 'pointer' ? field.value.target?.id ?? null : null,
        pointerState: pointerState(field.value),
        aliases: aliasesByTarget.get(field.id) ?? []
      }))
    }));

    const scopes = this.activeScopes.map((scope, scopeDepth) => ({
      id: scope.id,
      kind: scope.kind,
      label: scope.label,
      frameIndex: this.frames.indexOf(scope.frame),
      active: true,
      scopeDepth,
      visibleIds: [...scope.variableIds].filter((id) => (
        [...scope.frame.variables.values()].some((cell) => cell.id === id)
      ))
    }));

    return { stack, heap, scopes };
  }

  recordError(statement, error) {
    const tokens = statement.kind === 'while' ? statement.headerTokens : statement.tokens;
    const safeTokens = tokens.filter((token) => token?.value && token.value !== 'EOF');
    const code = tokensToCode(safeTokens);
    const detail = {
      type: error.code,
      message: error.message,
      targetId: error.targetId ?? null
    };
    const memory = this.snapshot();
    memory.diagnostic = detail;
    const status = `⚠ ${memoryErrorLabel(error.code)}: ${error.message}`;
    const functionName = this.currentFrame().name;
    const sourceKey = statement.kind === 'declaration'
      ? traceDeclarationKey(functionName, statement)
      : traceOperationKey(functionName, safeTokens);
    this.trace.push({
      kind: 'memory-error',
      sourceKey,
      code,
      buttonLabel: `Revisar ${code}`,
      runningStatus: status,
      readyStatus: status,
      indent: Math.max(this.activeScopes.length, this.frames.length - 1),
      scopeId: this.currentScope()?.id,
      scopeKind: this.currentScope()?.kind,
      scopeLabel: this.currentScope()?.label,
      scopeDepth: this.activeScopes.length,
      memory,
      diagnostic: detail
    });
  }

  record(tokens, status, metadata: Record<string, any> = {}) {
    if (this.trace.length >= this.maxSteps) {
      throw new CExecutionError('La ejecución superó el límite de pasos de seguridad.');
    }
    const safeTokens = tokens.filter((token) => token?.value && token.value !== 'EOF');
    const code = tokensToCode(safeTokens);
    const text = safeTokens.map((token) => token.value).join(' ');
    const memory = this.snapshot();
    this.trace.push({
      kind: metadata.kind ?? 'operation',
      sourceKey: metadata.sourceKey
        ?? `${this.currentFrame().name}:${safeTokens[0]?.line ?? '?'}:${metadata.kind ?? 'operation'}:${text}`,
      code,
      buttonLabel: `Ejecutar ${text}`,
      runningStatus: status,
      readyStatus: status,
      indent: metadata.indent
        ?? metadata.scopeDepth
        ?? Math.max(this.activeScopes.length, this.frames.length - 1),
      scopeId: metadata.scopeId,
      scopeKind: metadata.scopeKind,
      scopeLabel: metadata.scopeLabel,
      scopeDepth: metadata.scopeDepth,
      implicit: Boolean(metadata.implicit),
      functionReturn: Boolean(metadata.functionReturn),
      memory
    });
  }

  run() {
    if (!this.functions.has('main')) throw new CExecutionError('El programa debe definir int main().');
    try {
      this.callFunction('main', [], []);
    } catch (error) {
      if (error instanceof CExecutionError && this.lastContext && !error.message.includes('Función')) {
        error.message = `${error.message} Función ${this.lastContext.functionName}, línea ${this.lastContext.line}.`;
      }
      throw error;
    }
    return this.trace;
  }
}

function memoryErrorLabel(code) {
  return {
    'use-after-free': 'USE-AFTER-FREE',
    'double-free': 'DOUBLE-FREE',
    'null-dereference': 'NULL DEREFERENCE',
    'out-of-bounds': 'OUT-OF-BOUNDS'
  }[code] ?? 'ERROR DE MEMORIA';
}

function unaryOperatorAt(tokens, index) {
  const value = tokens[index]?.value;
  const previous = tokens[index - 1]?.value;
  return ['*', '&', '!'].includes(value)
    && (index === 0 || ['=', '(', '{', ';', ','].includes(previous)
      || TYPE_KEYWORDS.has(previous));
}

function tokensToCode(tokens) {
  const needsSpace = (index) => {
    if (index === 0) return false;
    const previous = tokens[index - 1];
    const current = tokens[index];
    if ([';', ')', ']', ',', '['].includes(current.value)) return false;
    if (current.value === '(') return ['while', 'if', 'for', 'switch'].includes(previous.value);
    if (['(', '['].includes(previous.value)) return false;
    if (previous.value === '*' && TYPE_KEYWORDS.has(tokens[index - 2]?.value)) return true;
    if (unaryOperatorAt(tokens, index - 1) && ['*', '&', '!'].includes(previous.value)) return false;
    if (current.value === '*' && TYPE_KEYWORDS.has(previous.value)) return false;
    return true;
  };

  return tokens.flatMap((token, index) => [
    ...(needsSpace(index) ? [{ text: ' ' }] : []),
    {
      text: token.value,
      className: token.type === 'keyword' && token.value === 'return'
        ? 'cpp-keyword'
        : token.type === 'keyword'
          ? 'cpp-type'
          : token.type === 'identifier'
            ? 'cpp-identifier'
            : token.type === 'number'
              ? 'cpp-number'
              : token.type === 'operator'
                ? 'cpp-operator'
                : 'cpp-punctuation'
    }
  ]);
}

function traceOperationKey(functionName, tokens) {
  const safeTokens = tokens.filter((token) => token?.value && token.value !== 'EOF');
  return `${functionName}:${safeTokens[0]?.line ?? '?'}:operation:${safeTokens.map((token) => token.value).join(' ')}`;
}

function traceDeclarationKey(functionName, statement) {
  return `${functionName}:declaration:${statement.tokens?.[0]?.line ?? '?'}:${statement.name}`;
}

function syntheticTraceToken(type, value, sourceToken = null) {
  return {
    type,
    value,
    line: sourceToken?.line ?? 1,
    column: sourceToken?.column ?? 1
  };
}

function createTraceSource(ast, instructions) {
  const instructionBySourceKey = new Map();
  instructions.forEach((instruction) => {
    if (!instructionBySourceKey.has(instruction.sourceKey)) {
      instructionBySourceKey.set(instruction.sourceKey, instruction);
    }
  });

  const sourceLines = [];
  const addLine = (sourceKey, tokens, indent, options: Record<string, any> = {}) => {
    const instruction = instructionBySourceKey.get(sourceKey);
    sourceLines.push({
      sourceKey,
      code: options.implicit ? tokensToCode(tokens) : instruction?.code ?? tokensToCode(tokens),
      indent,
      implicit: Boolean(options.implicit),
      functionGroup: options.functionGroup,
      functionHeader: options.functionHeader,
      collapsible: Boolean(options.collapsible)
    });
  };

  const addStatement = (statement, functionName, indent) => {
    if (statement.kind === 'block') {
      addBlock(statement, functionName, indent);
      return;
    }

    if (statement.kind === 'while') {
      addLine(traceOperationKey(functionName, statement.headerTokens), statement.headerTokens, indent, {
        functionGroup: functionName
      });
      addBlock(statement.body, functionName, indent);
      return;
    }

    const sourceKey = statement.kind === 'declaration'
      ? traceDeclarationKey(functionName, statement)
      : traceOperationKey(functionName, statement.tokens);
    addLine(sourceKey, statement.tokens, indent, { functionGroup: functionName });
  };

  const addBlock = (block, functionName, indent, parameters = []) => {
    addLine(`${block.scopeId}:open`, [block.openToken], indent, { functionGroup: functionName });
    parameters.forEach((parameter) => {
      const sourceKey = `function:${functionName}:parameter:${parameter.name}`;
      const sourceToken = parameter.type.tokens[0];
      const fallbackTokens = [
        ...parameter.type.tokens,
        syntheticTraceToken('identifier', parameter.name, sourceToken),
        syntheticTraceToken('operator', '=', sourceToken),
        syntheticTraceToken('identifier', '?', sourceToken),
        syntheticTraceToken('punctuation', ';', sourceToken)
      ];
      addLine(sourceKey, fallbackTokens, indent + 1, {
        implicit: true,
        functionGroup: functionName
      });
    });
    block.statements.forEach((statement) => addStatement(statement, functionName, indent + 1));
    addLine(`${block.scopeId}:close`, [block.closeToken], indent, { functionGroup: functionName });
  };

  [...ast.functions.values()]
    .sort((left, right) => (left.headerTokens[0]?.line ?? 0) - (right.headerTokens[0]?.line ?? 0))
    .forEach((functionNode) => {
      addLine(`function:${functionNode.name}:header`, functionNode.headerTokens, 0, {
        functionHeader: functionNode.name,
        collapsible: functionNode.name !== 'main'
      });
      addBlock(functionNode.body, functionNode.name, 0, functionNode.parameters);
    });

  return sourceLines;
}

export function buildMemoryProgram(source, options = {}) {
  const ast = parseC(source);
  const interpreter = new CInterpreter(ast, options);
  const instructions = interpreter.run();
  return {
    ast,
    instructions,
    sourceLines: createTraceSource(ast, instructions),
    structs: ast.structs,
    functions: ast.functions
  };
}
