import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildMemoryProgram,
  CExecutionError,
  CParserError
} from '../src/c-interpreter';
import { INTERPRETER_LIMITS } from '../src/interpreter-limits';

const linkedListSource = await readFile(
  new URL('./fixtures/linked-list.c', import.meta.url),
  'utf8'
);

test('interpreta el fixture de C y registra memoria heap', () => {
  const program = buildMemoryProgram(linkedListSource);
  const lastSnapshot = program.instructions.at(-1).memory;
  const node = lastSnapshot.heap[0];

  assert.ok(program.instructions.length > 0);
  assert.equal(node.name, 'node 1');
  assert.equal(node.fields.find((field: { name: string; value: string }) => field.name === 'data').value, '7');
  assert.equal(node.fields.find((field: { name: string; value: string }) => field.name === 'next').value, 'NULL');
});

test('free marca el bloque del heap como liberado y conserva el puntero colgante', () => {
  const source = `struct node { int data; struct node* next; };
int main() {
  struct node* head = malloc(sizeof(struct node));
  free(head);
  return 0;
}`;
  const program = buildMemoryProgram(source);
  const freeInstruction = program.instructions.find((instruction: any) => (
    instruction.code.map((token: { text: string }) => token.text).join('') === 'free(head);'
  ));

  assert.ok(freeInstruction);
  assert.equal(freeInstruction.memory.heap[0].freed, true);
  assert.equal(freeInstruction.memory.heap[0].value, 'liberado');
  assert.equal(freeInstruction.memory.stack.find((item: any) => item.name === 'head').value, '0x300');
});

test('free(NULL) no hace nada', () => {
  const program = buildMemoryProgram('int main() { free(NULL); return 0; }');
  const freeInstruction = program.instructions.find((instruction: any) => (
    instruction.code.map((token: { text: string }) => token.text).join('') === 'free(NULL);'
  ));

  assert.ok(freeInstruction);
  assert.deepEqual(freeInstruction.memory.heap, []);
});

test('distingue punteros colgantes de memoria inalcanzable', () => {
  const source = `struct node { int data; };
int main() {
  struct node* dangling = malloc(sizeof(struct node));
  struct node* orphan = malloc(sizeof(struct node));
  free(dangling);
  orphan = NULL;
  return 0;
}`;
  const program = buildMemoryProgram(source);
  const instructionFor = (code: string) => program.instructions.find((instruction: any) => (
    instruction.code.map((token: { text: string }) => token.text).join('') === code
  ));

  const danglingSnapshot = instructionFor('free(dangling);')?.memory;
  assert.equal(
    danglingSnapshot.stack.find((item: any) => item.name === 'dangling').pointerState,
    'dangling'
  );
  assert.equal(danglingSnapshot.heap.find((item: any) => item.name === 'node 1').freed, true);

  const unreachableSnapshot = instructionFor('orphan = NULL;')?.memory;
  assert.equal(
    unreachableSnapshot.heap.find((item: any) => item.name === 'node 2').unreachable,
    true
  );
  assert.equal(
    unreachableSnapshot.stack.find((item: any) => item.name === 'orphan').value,
    'NULL'
  );
});

test('registra liberar dos veces como un diagnóstico visual', () => {
  const source = `struct node { int data; };
int main() {
  struct node* head = malloc(sizeof(struct node));
  free(head);
  free(head);
  return 0;
}`;

  const program = buildMemoryProgram(source);
  const diagnostic = program.instructions.find((instruction: any) => instruction.kind === 'memory-error');

  assert.equal(diagnostic.diagnostic.type, 'double-free');
  assert.match(diagnostic.diagnostic.message, /liberar memoria dos veces/);
  assert.equal(diagnostic.memory.heap[0].freed, true);
});

test('registra use-after-free, NULL dereference y acceso fuera de rango', () => {
  const source = `struct node { int data; };
int main() {
  int values[2];
  values[2] = 3;
  struct node* pointer = malloc(sizeof(struct node));
  free(pointer);
  pointer->data = 1;
  struct node* nullPointer = NULL;
  nullPointer->data = 2;
  return 0;
}`;
  const diagnostics = buildMemoryProgram(source).instructions
    .filter((instruction: any) => instruction.kind === 'memory-error')
    .map((instruction: any) => instruction.diagnostic.type);

  assert.deepEqual(diagnostics, ['out-of-bounds', 'use-after-free', 'null-dereference']);
});

test('rechaza código que supera el límite de tamaño', () => {
  const source = `${' '.repeat(INTERPRETER_LIMITS.maxSourceLength)}int main() { return 0; }`;

  assert.throws(
    () => buildMemoryProgram(source),
    (error) => error instanceof CParserError
      && error.message.includes(`${INTERPRETER_LIMITS.maxSourceLength} caracteres`)
  );
});

test('detiene un while que excede el límite de pasos', () => {
  const source = 'int main() { int x = 0; while (1) { x = x + 1; } }';

  assert.throws(
    () => buildMemoryProgram(source, { maxSteps: 8 }),
    (error) => error instanceof CExecutionError
      && error.message.includes('límite de pasos de seguridad')
  );
});

test('detiene la recursión que excede la profundidad configurada', () => {
  const source = `int recurse() { return recurse(); }
int main() { return recurse(); }`;

  assert.throws(
    () => buildMemoryProgram(source, { maxCallDepth: 4 }),
    (error) => error instanceof CExecutionError
      && error.message.includes('profundidad de llamadas (4)')
  );
});
