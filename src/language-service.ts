import { parseC } from './c-interpreter';

export type SourceSeverity = 'error' | 'warning' | 'info';

export interface SourcePosition {
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
  startOffset: number;
  endOffset: number;
}

export interface LanguageDiagnostic {
  severity: SourceSeverity;
  code: string;
  message: string;
  range: SourceRange;
}

export type SymbolKind = 'variable' | 'function' | 'struct' | 'field' | 'parameter';

export interface SourceSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  type: string;
  scopeId: string;
  scopeLabel: string;
  range: SourceRange;
  selectionRange: SourceRange;
  childScopeId: string | null;
}

export type ReferenceContext = 'identifier' | 'function-call' | 'member';

export interface SourceReference {
  name: string;
  context: ReferenceContext;
  receiverName: string | null;
  range: SourceRange;
  targetId: string | null;
  targetKind: SymbolKind | null;
  resolved: boolean;
}

export interface CompletionItem {
  label: string;
  detail: string;
  kind: string;
  replaceStart: number;
  replaceEnd: number;
}

export interface HoverInfo {
  symbol: SourceSymbol;
  range: SourceRange;
  reference: SourceReference | null;
}

export interface SourceTextEdit {
  range: SourceRange;
  newText: string;
}

export interface SourceScope {
  id: string;
  kind: string;
  label: string;
  parentId: string | null;
  depth: number;
  range: SourceRange;
}

export interface SymbolTable {
  symbols: SourceSymbol[];
  scopes: SourceScope[];
  references: SourceReference[];
}

export interface LanguageAnalysis {
  diagnostics: LanguageDiagnostic[];
  symbolTable: SymbolTable;
  ast: any;
  parseError: unknown;
}

type Token = {
  type?: string;
  value: string;
  line: number;
  column: number;
};

const delimiterPairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

function positionAtOffset(source: string, offset: number): SourcePosition {
  const safeOffset = Math.max(0, Math.min(offset, source.length));
  const before = source.slice(0, safeOffset);
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1
  };
}

function offsetAtPosition(source: string, line: number, column: number): number {
  const lines = source.split('\n');
  const lineIndex = Math.max(0, Math.min(lines.length - 1, line - 1));
  const lineStart = lines
    .slice(0, lineIndex)
    .reduce((offset, text) => offset + text.length + 1, 0);
  return Math.min(source.length, lineStart + Math.max(0, column - 1));
}

function rangeFromOffsets(source: string, startOffset: number, endOffset: number): SourceRange {
  const safeStart = Math.max(0, Math.min(startOffset, source.length));
  const safeEnd = Math.max(safeStart, Math.min(endOffset, source.length));
  return {
    start: positionAtOffset(source, safeStart),
    end: positionAtOffset(source, safeEnd),
    startOffset: safeStart,
    endOffset: safeEnd
  };
}

function rangeFromToken(source: string, token: Token | null | undefined): SourceRange {
  if (!token) return rangeFromOffsets(source, 0, 0);
  const startOffset = offsetAtPosition(source, token.line, token.column);
  return rangeFromOffsets(source, startOffset, startOffset + token.value.length);
}

function diagnostic(
  source: string,
  severity: SourceSeverity,
  code: string,
  message: string,
  startOffset: number,
  endOffset = startOffset + 1
): LanguageDiagnostic {
  return {
    severity,
    code,
    message,
    range: rangeFromOffsets(source, startOffset, endOffset)
  };
}

/**
 * Fast editor-only checks that do not require a complete AST. Keeping these
 * checks independent means incomplete code can still receive useful feedback
 * while the user is typing.
 */
export function scanSourceStructure(source: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const opening = new Set(Object.keys(delimiterPairs));
  const closing = new Set(Object.values(delimiterPairs));
  const stack: Array<{ character: string; index: number }> = [];
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const nextCharacter = source[index + 1] ?? '';

    if (inBlockComment) {
      if (character === '*' && nextCharacter === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (character === '/' && nextCharacter === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      const lineEnd = source.indexOf('\n', index);
      index = lineEnd === -1 ? source.length : lineEnd - 1;
      continue;
    }

    if (character === '"' || character === "'") {
      const quote = character;
      const quoteStart = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        index += 1;
      }
      if (index >= source.length) {
        diagnostics.push(diagnostic(
          source,
          'error',
          'unterminated-string',
          'Literal sin cerrar.',
          quoteStart,
          quoteStart + 1
        ));
        break;
      }
      continue;
    }

    if (opening.has(character)) {
      stack.push({ character, index });
      continue;
    }

    if (closing.has(character)) {
      const expected = stack.at(-1) ? delimiterPairs[stack.at(-1)!.character] : null;
      if (!expected || expected !== character) {
        diagnostics.push(diagnostic(
          source,
          'error',
          'unmatched-delimiter',
          `Cierre inesperado de "${character}".`,
          index,
          index + 1
        ));
      } else {
        stack.pop();
      }
    }
  }

  stack.reverse().forEach(({ character, index }) => {
    diagnostics.push(diagnostic(
      source,
      'error',
      'unclosed-delimiter',
      `Falta cerrar "${delimiterPairs[character]}".`,
      index,
      index + 1
    ));
  });

  source.split('\n').forEach((line, index) => {
    const lineStart = offsetAtPosition(source, index + 1, 1);
    if (line.length > 120) {
      diagnostics.push(diagnostic(
        source,
        'warning',
        'line-length',
        'La línea supera 120 columnas; considera dividirla.',
        lineStart + 120,
        lineStart + line.length
      ));
    }
    if (line.includes('\t')) {
      const tabOffset = line.indexOf('\t');
      diagnostics.push(diagnostic(
        source,
        'warning',
        'tab-indentation',
        'Usa dos espacios en lugar de tabulaciones para mantener el formato.',
        lineStart + tabOffset,
        lineStart + tabOffset + 1
      ));
    }
    if (/[ \t]+$/.test(line)) {
      const whitespaceOffset = line.search(/[ \t]+$/);
      diagnostics.push(diagnostic(
        source,
        'info',
        'trailing-whitespace',
        'Hay espacios al final de la línea.',
        lineStart + whitespaceOffset,
        lineStart + line.length
      ));
    }
  });

  return diagnostics;
}

function formatType(type: any): string {
  if (!type) return '?';
  const pointerSuffix = '*'.repeat(type.pointerDepth ?? 0);
  const arraySuffix = type.arrayLength ? `[${type.arrayLength}]` : '';
  return `${type.base ?? '?'}${pointerSuffix}${arraySuffix}`;
}

function findToken(tokens: Token[] | undefined, value: string): Token | null {
  return tokens?.find((token) => token.value === value) ?? null;
}

function findNameToken(tokens: Token[] | undefined, name: string): Token | null {
  return findToken(tokens, name);
}

function scopeRange(source: string, block: any): SourceRange {
  return rangeFromOffsets(
    source,
    rangeFromToken(source, block?.openToken).startOffset,
    rangeFromToken(source, block?.closeToken).endOffset
  );
}

function symbolRange(source: string, tokens: Token[] | undefined, name: string): SourceRange {
  return rangeFromToken(source, findNameToken(tokens, name) ?? tokens?.[0]);
}

function createSymbol(
  source: string,
  table: SymbolTable,
  data: Omit<SourceSymbol, 'id' | 'range' | 'selectionRange'>,
  tokens: Token[] | undefined
): void {
  const selectionRange = symbolRange(source, tokens, data.name);
  const id = `${data.kind}:${data.name}:${selectionRange.startOffset}`;
  table.symbols.push({ ...data, id, range: selectionRange, selectionRange });
}

function addScope(
  source: string,
  table: SymbolTable,
  block: any,
  parentId: string | null,
  depth: number,
  kind: string,
  label: string,
  id = block?.scopeId
): string {
  const scopeId = id ?? `scope-${table.scopes.length + 1}`;
  table.scopes.push({
    id: scopeId,
    kind,
    label,
    parentId,
    depth,
    range: scopeRange(source, block)
  });
  return scopeId;
}

function scopeLabel(table: SymbolTable, scopeId: string): string {
  return table.scopes.find((scope) => scope.id === scopeId)?.label ?? scopeId;
}

function addDeclarationSymbol(
  source: string,
  table: SymbolTable,
  declaration: any,
  scopeId: string
): void {
  createSymbol(source, table, {
    name: declaration.name,
    kind: 'variable',
    type: formatType(declaration.type),
    scopeId,
    scopeLabel: scopeLabel(table, scopeId),
    childScopeId: null
  }, declaration.tokens);
}

function walkBlock(
  source: string,
  table: SymbolTable,
  block: any,
  parentId: string,
  depth: number,
  kind: string,
  label: string,
  parameters: any[] = [],
  parameterTokens: Token[] | undefined = undefined
): void {
  const currentId = addScope(source, table, block, parentId, depth, kind, label);

  parameters.forEach((parameter) => {
    createSymbol(source, table, {
      name: parameter.name,
      kind: 'parameter',
      type: formatType(parameter.type),
      scopeId: currentId,
      scopeLabel: label,
      childScopeId: null
    }, parameterTokens ?? block.tokens);
  });

  const walkStatement = (statement: any): void => {
    if (statement.kind === 'declaration') {
      addDeclarationSymbol(source, table, statement, currentId);
      return;
    }
    if (statement.kind === 'block') {
      walkBlock(source, table, statement, currentId, depth + 1, statement.scopeKind, statement.scopeLabel);
      return;
    }
    if (statement.kind === 'while') {
      if (statement.body?.kind === 'block') {
        walkBlock(
          source,
          table,
          statement.body,
          currentId,
          depth + 1,
          statement.body.scopeKind,
          statement.body.scopeLabel
        );
      } else if (statement.body) {
        walkStatement(statement.body);
      }
    }
  };

  block.statements?.forEach(walkStatement);
}

export function buildSymbolTable(source: string, ast: any): SymbolTable {
  const table: SymbolTable = { symbols: [], scopes: [], references: [] };
  const wholeSource = rangeFromOffsets(source, 0, source.length);
  table.scopes.push({
    id: 'global',
    kind: 'global',
    label: 'global',
    parentId: null,
    depth: 0,
    range: wholeSource
  });

  ast.structs?.forEach((definition: any) => {
    const structScopeId = `struct:${definition.name}`;
    const structToken = findToken(definition.tokens, definition.name);
    table.scopes.push({
      id: structScopeId,
      kind: 'struct',
      label: `struct ${definition.name}`,
      parentId: 'global',
      depth: 1,
      range: rangeFromToken(source, structToken ?? definition.tokens?.[0])
    });
    createSymbol(source, table, {
      name: definition.name,
      kind: 'struct',
      type: `struct ${definition.name}`,
      scopeId: 'global',
      scopeLabel: 'global',
      childScopeId: structScopeId
    }, definition.tokens);

    definition.fields?.forEach((field: any) => {
      createSymbol(source, table, {
        name: field.name,
        kind: 'field',
        type: formatType(field.type),
        scopeId: structScopeId,
        scopeLabel: `struct ${definition.name}`,
        childScopeId: null
      }, definition.tokens);
    });
  });

  ast.globals?.forEach((declaration: any) => {
    addDeclarationSymbol(source, table, declaration, 'global');
  });

  ast.functions?.forEach((functionNode: any) => {
    const functionScopeId = functionNode.body?.scopeId ?? `function:${functionNode.name}`;
    createSymbol(source, table, {
      name: functionNode.name,
      kind: 'function',
      type: `${formatType(functionNode.returnType)} ${functionNode.name}()`,
      scopeId: 'global',
      scopeLabel: 'global',
      childScopeId: functionScopeId
    }, functionNode.headerTokens ?? functionNode.tokens);
    walkBlock(
      source,
      table,
      functionNode.body,
      'global',
      1,
      'function',
      `${functionNode.name}()`,
      functionNode.parameters,
      functionNode.headerTokens
    );
  });

  table.symbols.sort((left, right) => (
    left.selectionRange.startOffset - right.selectionRange.startOffset
    || left.name.localeCompare(right.name)
  ));
  table.scopes.sort((left, right) => (
    left.range.startOffset - right.range.startOffset
    || left.depth - right.depth
  ));
  table.references = collectReferences(source, ast, table);
  return table;
}

function scopeById(table: SymbolTable, id: string | null): SourceScope | null {
  return table.scopes.find((scope) => scope.id === id) ?? null;
}

function enclosingScope(table: SymbolTable, offset: number): SourceScope {
  return table.scopes
    .filter((scope) => scope.kind !== 'struct'
      && scope.range.startOffset <= offset
      && scope.range.endOffset >= offset)
    .sort((left, right) => right.depth - left.depth)[0]
    ?? table.scopes.find((scope) => scope.id === 'global')!;
}

function resolveSymbol(
  table: SymbolTable,
  name: string,
  scopeId: string,
  offset: number,
  allowedKinds: SymbolKind[] = ['variable', 'parameter', 'function', 'struct']
): SourceSymbol | null {
  let currentId: string | null = scopeId;
  while (currentId) {
    const candidates = table.symbols
      .filter((symbol) => symbol.name === name
        && allowedKinds.includes(symbol.kind)
        && symbol.scopeId === currentId
        && symbol.selectionRange.startOffset <= offset)
      .sort((left, right) => right.selectionRange.startOffset - left.selectionRange.startOffset);
    if (candidates[0]) return candidates[0];
    currentId = scopeById(table, currentId)?.parentId ?? null;
  }
  return null;
}

function structNameFromType(type: string | null): string | null {
  return type?.match(/^struct\s+([A-Za-z_]\w*)/)?.[1] ?? null;
}

function fieldForType(table: SymbolTable, type: string | null, name: string): SourceSymbol | null {
  const structName = structNameFromType(type);
  if (!structName) return null;
  return table.symbols.find((symbol) => (
    symbol.kind === 'field'
      && symbol.name === name
      && symbol.scopeId === `struct:${structName}`
  )) ?? null;
}

function returnTypeFromFunction(type: string): string {
  return type.replace(/\s+[A-Za-z_]\w*\(\)$/, '').trim();
}

function collectReferences(source: string, ast: any, table: SymbolTable): SourceReference[] {
  const references: SourceReference[] = [];

  const addReference = (
    name: string,
    token: Token | null | undefined,
    context: ReferenceContext,
    target: SourceSymbol | null,
    receiverName: string | null = null
  ): void => {
    if (!token || ['NULL', 'malloc', 'free'].includes(name)) return;
    const range = rangeFromToken(source, token);
    references.push({
      name,
      context,
      receiverName,
      range,
      targetId: target?.id ?? null,
      targetKind: target?.kind ?? null,
      resolved: Boolean(target)
    });
  };

  const visitExpression = (expression: any, scopeId: string): string | null => {
    if (!expression) return null;

    if (expression.kind === 'identifier') {
      const target = resolveSymbol(table, expression.name, scopeId, rangeFromToken(source, expression.tokens?.[0]).startOffset);
      addReference(expression.name, expression.tokens?.[0], 'identifier', target);
      return target?.type ?? null;
    }

    if (expression.kind === 'literal' || expression.kind === 'null') return null;

    if (expression.kind === 'call') {
      const target = resolveSymbol(
        table,
        expression.callee,
        scopeId,
        rangeFromToken(source, expression.tokens?.[0]).startOffset,
        ['function']
      );
      addReference(expression.callee, expression.tokens?.[0], 'function-call', target);
      expression.args?.forEach((argument: any) => visitExpression(argument, scopeId));
      return target ? returnTypeFromFunction(target.type) : null;
    }

    if (expression.kind === 'member') {
      const objectType = visitExpression(expression.object, scopeId);
      const field = fieldForType(table, objectType, expression.field);
      const receiver = expression.object?.kind === 'identifier'
        ? resolveSymbol(
          table,
          expression.object.name,
          scopeId,
          rangeFromToken(source, expression.object.tokens?.[0]).startOffset
        )
        : null;
      addReference(
        expression.field,
        expression.tokens?.at(-1),
        'member',
        field,
        receiver?.name ?? null
      );
      return field?.type ?? null;
    }

    if (expression.kind === 'index') {
      const objectType = visitExpression(expression.object, scopeId);
      visitExpression(expression.index, scopeId);
      return objectType?.replace(/\[\d+\]$/, '') ?? null;
    }

    if (expression.kind === 'unary') return visitExpression(expression.operand, scopeId);

    if (expression.kind === 'binary') {
      const leftType = visitExpression(expression.left, scopeId);
      visitExpression(expression.right, scopeId);
      return leftType;
    }

    return null;
  };

  const visitStatement = (statement: any, scopeId: string): void => {
    if (!statement) return;
    if (statement.kind === 'declaration') {
      visitExpression(statement.initializer, scopeId);
      return;
    }
    if (statement.kind === 'expression-statement') {
      visitExpression(statement.expression, scopeId);
      return;
    }
    if (statement.kind === 'return') {
      visitExpression(statement.expression, scopeId);
      return;
    }
    if (statement.kind === 'while') {
      visitExpression(statement.condition, scopeId);
      if (statement.body?.kind === 'block') visitBlock(statement.body);
      else visitStatement(statement.body, scopeId);
      return;
    }
    if (statement.kind === 'block') visitBlock(statement);
  };

  const visitBlock = (block: any): void => {
    block.statements?.forEach((statement: any) => visitStatement(statement, block.scopeId));
  };

  ast.globals?.forEach((declaration: any) => visitExpression(declaration.initializer, 'global'));
  ast.functions?.forEach((functionNode: any) => visitBlock(functionNode.body));
  return references.sort((left, right) => left.range.startOffset - right.range.startOffset);
}

const completionKeywords = [
  'auto', 'bool', 'break', 'char', 'continue', 'double', 'else', 'float', 'for',
  'if', 'int', 'long', 'return', 'short', 'sizeof', 'struct', 'void', 'while'
];

function completionItem(
  label: string,
  detail: string,
  kind: string,
  replaceStart: number,
  replaceEnd: number
): CompletionItem {
  return { label, detail, kind, replaceStart, replaceEnd };
}

export function getCompletions(
  source: string,
  offset: number,
  analysis: LanguageAnalysis | null
): CompletionItem[] {
  const table = analysis?.symbolTable;
  if (!table) return [];

  const safeOffset = Math.max(0, Math.min(offset, source.length));
  const before = source.slice(0, safeOffset);
  const wordMatch = before.match(/[A-Za-z_]\w*$/);
  const prefix = wordMatch?.[0] ?? '';
  const replaceStart = safeOffset - prefix.length;
  const memberMatch = source
    .slice(0, replaceStart)
    .match(/([A-Za-z_]\w*)\s*(->|\.)$/);
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (item: CompletionItem): void => {
    if (seen.has(item.label)) return;
    if (!item.label.toLowerCase().startsWith(prefix.toLowerCase())) return;
    seen.add(item.label);
    items.push(item);
  };

  if (memberMatch) {
    const objectName = memberMatch[1] ?? '';
    const objectOffset = replaceStart - memberMatch[0].length;
    const scope = enclosingScope(table, objectOffset);
    const object = resolveSymbol(table, objectName, scope.id, objectOffset);
    const structName = structNameFromType(object?.type ?? null);
    table.symbols
      .filter((symbol) => symbol.kind === 'field' && symbol.scopeId === `struct:${structName}`)
      .forEach((symbol) => add(completionItem(
        symbol.name,
        symbol.type,
        'field',
        replaceStart,
        safeOffset
      )));
  } else {
    const scope = enclosingScope(table, safeOffset);
    completionKeywords.forEach((keyword) => add(completionItem(
      keyword,
      'palabra clave',
      'keyword',
      replaceStart,
      safeOffset
    )));
    table.symbols
      .filter((symbol) => ['variable', 'parameter', 'function', 'struct'].includes(symbol.kind))
      .filter((symbol) => symbol.kind === 'function' || symbol.kind === 'struct'
        ? symbol.selectionRange.startOffset <= safeOffset
        : Boolean(resolveSymbol(table, symbol.name, scope.id, safeOffset)
          && resolveSymbol(table, symbol.name, scope.id, safeOffset)?.id === symbol.id))
      .forEach((symbol) => add(completionItem(
        symbol.name,
        symbol.type,
        symbol.kind,
        replaceStart,
        safeOffset
      )));
    add(completionItem('NULL', 'puntero nulo', 'constant', replaceStart, safeOffset));
    add(completionItem('malloc', 'asignación de heap', 'function', replaceStart, safeOffset));
    add(completionItem('free', 'liberación de heap', 'function', replaceStart, safeOffset));
  }

  return items
    .sort((left, right) => {
      const rank = (kind: string) => ({
        variable: 0,
        parameter: 0,
        function: 1,
        field: 1,
        struct: 2,
        type: 3,
        constant: 4,
        keyword: 5
      }[kind] ?? 6);
      return rank(left.kind) - rank(right.kind) || left.label.localeCompare(right.label);
    })
    .slice(0, 16);
}

function rangeContainsOffset(range: SourceRange, offset: number): boolean {
  return range.startOffset <= offset && offset <= range.endOffset;
}

function symbolById(table: SymbolTable, id: string | null): SourceSymbol | null {
  return table.symbols.find((symbol) => symbol.id === id) ?? null;
}

function symbolAtOffset(table: SymbolTable, offset: number): HoverInfo | null {
  const rangeLength = (range: SourceRange): number => range.endOffset - range.startOffset;
  const reference = table.references
    .filter((item) => rangeContainsOffset(item.range, offset) && item.targetId)
    .sort((left, right) => rangeLength(left.range) - rangeLength(right.range))[0];
  const referenceSymbol = symbolById(table, reference?.targetId ?? null);
  if (referenceSymbol) {
    return { symbol: referenceSymbol, range: reference!.range, reference: reference ?? null };
  }

  const declaration = table.symbols
    .filter((symbol) => rangeContainsOffset(symbol.selectionRange, offset))
    .sort((left, right) => rangeLength(left.selectionRange) - rangeLength(right.selectionRange))[0];
  return declaration
    ? { symbol: declaration, range: declaration.selectionRange, reference: null }
    : null;
}

export function getHoverInfo(
  _source: string,
  offset: number,
  analysis: LanguageAnalysis | null
): HoverInfo | null {
  const table = analysis?.symbolTable;
  if (!table) return null;
  return symbolAtOffset(table, Math.max(0, Math.min(offset, _source.length)));
}

export function getDefinition(
  _source: string,
  offset: number,
  analysis: LanguageAnalysis | null
): SourceRange | null {
  return getHoverInfo(_source, offset, analysis)?.symbol.selectionRange ?? null;
}

export function getRenameEdits(
  source: string,
  offset: number,
  newName: string,
  analysis: LanguageAnalysis | null
): SourceTextEdit[] {
  if (!/^[A-Za-z_]\w*$/.test(newName)) return [];
  const hover = getHoverInfo(source, offset, analysis)
    ?? getHoverInfo(source, Math.max(0, offset - 1), analysis);
  if (!hover) return [];

  const ranges = [
    hover.symbol.selectionRange,
    ...(analysis?.symbolTable.references ?? [])
      .filter((reference) => reference.targetId === hover.symbol.id)
      .map((reference) => reference.range)
  ];
  const seen = new Set<string>();
  return ranges
    .filter((range) => {
      const key = `${range.startOffset}:${range.endOffset}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.startOffset - right.startOffset)
    .map((range) => ({ range, newText: newName }));
}

export function analyzeSource(source: string): LanguageAnalysis {
  const diagnostics = scanSourceStructure(source);
  try {
    const ast = parseC(source);
    return {
      diagnostics,
      symbolTable: buildSymbolTable(source, ast),
      ast,
      parseError: null
    };
  } catch (parseError) {
    return {
      diagnostics,
      symbolTable: { symbols: [], scopes: [], references: [] },
      ast: null,
      parseError
    };
  }
}
