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
