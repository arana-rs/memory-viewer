import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryScope } from '../src/memory-model';

test('resuelve referencias y escritura a través de un puntero', () => {
  const memory = new MemoryScope({ baseAddress: 0x100 });
  const value = memory.variable('value', { type: 'int', value: 1 });
  const pointer = memory.variable('pointer', { type: 'int*', value: '&value' });

  assert.equal(value.address, '0x100');
  assert.equal(pointer.value, value.address);
  assert.equal(memory.addressOf('&value'), value.address);

  memory.execute({ type: 'write-through', pointer: 'pointer', value: 9 });
  assert.equal(value.value, 9);
});
