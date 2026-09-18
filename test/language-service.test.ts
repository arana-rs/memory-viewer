import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeSource,
  buildSymbolTable,
  getCompletions,
  getDefinition,
  getHoverInfo,
  getRenameEdits
} from '../src/language-service';
import { parseC } from '../src/c-interpreter';

test('detecta errores estructurales mientras el código está incompleto', () => {
  const analysis = analyzeSource('int main() {\n\tint value = (1;\n');
  const codes = analysis.diagnostics.map((item) => item.code);

  assert.ok(codes.includes('tab-indentation'));
  assert.ok(codes.includes('unclosed-delimiter'));
  assert.ok(analysis.parseError);
  assert.equal(analysis.symbolTable.symbols.length, 0);
});

test('construye símbolos para structs, campos, funciones, parámetros, variables y ámbitos', () => {
  const source = `struct node {
  int data;
  struct node* next;
};

int sum(int left, int right) {
  int result = left;
  while (result < right) {
    result = result + 1;
  }
  return result;
}

int main() {
  struct node* head = NULL;
  return 0;
}`;
  const analysis = analyzeSource(source);
  const { symbols, scopes } = analysis.symbolTable;

  assert.equal(analysis.parseError, null);
  assert.deepEqual(
    symbols.filter((symbol) => symbol.kind === 'struct').map((symbol) => symbol.name),
    ['node']
  );
  assert.deepEqual(
    symbols.filter((symbol) => symbol.kind === 'field').map((symbol) => symbol.name),
    ['data', 'next']
  );
  assert.deepEqual(
    symbols.filter((symbol) => symbol.kind === 'function').map((symbol) => symbol.name),
    ['sum', 'main']
  );
  assert.deepEqual(
    symbols.filter((symbol) => symbol.kind === 'parameter').map((symbol) => symbol.name),
    ['left', 'right']
  );

  const result = symbols.find((symbol) => symbol.name === 'result');
  const head = symbols.find((symbol) => symbol.name === 'head');
  assert.equal(result?.type, 'int');
  assert.equal(result?.scopeLabel, 'sum()');
  assert.equal(head?.type, 'struct node*');
  assert.equal(head?.scopeLabel, 'main()');
  assert.ok(result?.selectionRange.start.line === 7);
  assert.ok(scopes.some((scope) => scope.kind === 'while' && scope.label === 'while'));
  assert.ok(scopes.some((scope) => scope.kind === 'function' && scope.label === 'sum()'));
});

test('la tabla de símbolos puede construirse desde el AST del intérprete', () => {
  const source = 'int answer; int main() { answer = 42; return 0; }';
  const table = buildSymbolTable(source, parseC(source));
  const answer = table.symbols.find((symbol) => symbol.name === 'answer');

  assert.equal(answer?.kind, 'variable');
  assert.equal(answer?.scopeLabel, 'global');
  assert.ok(table.scopes.some((scope) => scope.id === 'global'));
});

test('resuelve referencias a variables, funciones y campos de structs', () => {
  const source = `struct node { int data; };
struct node* make() {
  struct node* result = malloc(sizeof(struct node));
  return result;
}
int main() {
  struct node* head = make();
  head->data = 7;
  return 0;
}`;
  const references = analyzeSource(source).symbolTable.references;

  const referenceFor = (name: string, context?: string) => references.find((reference) => (
    reference.name === name && (!context || reference.context === context)
  ));

  assert.equal(referenceFor('make', 'function-call')?.resolved, true);
  assert.equal(referenceFor('head')?.targetKind, 'variable');
  assert.equal(referenceFor('data', 'member')?.targetKind, 'field');
  assert.equal(referenceFor('data', 'member')?.receiverName, 'head');
  assert.equal(references.filter((reference) => !reference.resolved).length, 0);
});

test('ofrece autocompletado global y campos después de ->', () => {
  const source = `struct node { int data; struct node* next; };
int main() {
  struct node* head = NULL;
  head->data = 1;
  return 0;
}`;
  const analysis = analyzeSource(source);
  const memberOffset = source.indexOf('head->') + 'head->'.length;
  const memberItems = getCompletions(source, memberOffset, analysis);
  const globalItems = getCompletions(source, source.indexOf('return'), analysis);

  assert.deepEqual(memberItems.map((item) => item.label), ['data', 'next']);
  assert.ok(globalItems.some((item) => item.label === 'head'));
  assert.ok(globalItems.some((item) => item.label === 'main'));
});

test('ofrece hover y definición para una referencia resuelta', () => {
  const source = `struct node { int data; };
int main() {
  struct node* head = NULL;
  head->data = 7;
  return 0;
}`;
  const analysis = analyzeSource(source);
  const referenceOffset = source.indexOf('head->data');
  const head = analysis.symbolTable.symbols.find((symbol) => symbol.name === 'head');
  const hover = getHoverInfo(source, referenceOffset, analysis);
  const definition = getDefinition(source, referenceOffset, analysis);

  assert.equal(hover?.symbol.name, 'head');
  assert.equal(hover?.symbol.type, 'struct node*');
  assert.equal(hover?.symbol.scopeLabel, 'main()');
  assert.deepEqual(definition?.start, head?.selectionRange.start);
  assert.deepEqual(definition?.end, head?.selectionRange.end);
});

test('no trata la declaración de un campo como una dirección de memoria', () => {
  const source = `struct node {
  int data;
  struct node* next;
};`;
  const analysis = analyzeSource(source);
  const fieldOffset = source.indexOf('next');
  const hover = getHoverInfo(source, fieldOffset, analysis);

  assert.equal(hover?.symbol.kind, 'field');
  assert.equal(hover?.reference, null);
});

test('renombra solo las referencias del mismo símbolo', () => {
  const source = `struct node { int data; };
int main() {
  struct node* head = NULL;
  head->data = 7;
  return 0;
}`;
  const analysis = analyzeSource(source);
  const edits = getRenameEdits(source, source.indexOf('head->data'), 'first', analysis);
  let renamed = source;
  edits.slice().reverse().forEach(({ range, newText }) => {
    renamed = `${renamed.slice(0, range.startOffset)}${newText}${renamed.slice(range.endOffset)}`;
  });

  assert.equal(edits.length, 2);
  assert.match(renamed, /struct node\* first = NULL;/);
  assert.match(renamed, /first->data = 7;/);
  assert.equal((renamed.match(/\bhead\b/g) ?? []).length, 0);
});
