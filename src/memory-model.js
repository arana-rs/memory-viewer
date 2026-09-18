import { alignAddress, formatAddress, parseAddress } from './memory-utils.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const MemoryOperation = Object.freeze({
  DECLARE: 'declare',
  ASSIGN: 'assign',
  WRITE_THROUGH: 'write-through',
  COPY: 'copy',
  ENTER_SCOPE: 'enter-scope',
  EXIT_SCOPE: 'exit-scope'
});

export class MemoryModelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryModelError';
  }
}

function assertIdentifier(name) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new MemoryModelError(`"${name}" no es un identificador válido.`);
  }
}

function parseReference(reference) {
  if (typeof reference !== 'string' || !reference.startsWith('&')) {
    throw new MemoryModelError(`"${reference}" no es una referencia válida. Usa &nombre.`);
  }

  const name = reference.slice(1).trim();
  assertIdentifier(name);
  return name;
}

function layoutFor(type) {
  return String(type).includes('*')
    ? { size: 8, alignment: 8 }
    : { size: 4, alignment: 4 };
}

/**
 * Estado abstracto de una sección de memoria.
 *
 * La vista solo recibe los símbolos ya resueltos. Por ejemplo:
 *   memory.variable('a', { type: 'int', value: 5 });
 *   memory.variable('p', { type: 'int*', value: '&a' });
 *
 * También acepta la forma corta `memory.variable('p', '&a')`; el tipo de
 * puntero se deduce automáticamente.
 *
 * Las referencias se validan aquí, no en el código que dibuja el DOM.
 */
export class MemoryScope {
  constructor({ area = 'STACK', baseAddress = 0x100, parent = null, allocator = null } = {}) {
    this.area = String(area).toUpperCase();
    this.parent = parent;
    this.children = [];
    this.allocator = allocator ?? { nextAddress: baseAddress };
    this.symbols = new Map();

    if (parent) parent.children.push(this);
  }

  get nextAddress() {
    return this.allocator.nextAddress;
  }

  enter({ area = this.area, addressGap = 0 } = {}) {
    if (!Number.isInteger(addressGap) || addressGap < 0) {
      throw new MemoryModelError('La separación de un ámbito debe ser un entero positivo.');
    }

    this.allocator.nextAddress += addressGap;
    return new MemoryScope({
      area,
      parent: this,
      allocator: this.allocator
    });
  }

  exit() {
    if (!this.parent) {
      throw new MemoryModelError('El ámbito raíz no tiene un ámbito padre del que salir.');
    }

    return this.parent;
  }

  variable(name, declaration = {}) {
    assertIdentifier(name);

    const options = declaration !== null && typeof declaration === 'object'
      ? declaration
      : { value: declaration };
    const {
      value = '?',
      address,
      type: declaredType,
      ...metadata
    } = options;
    const type = declaredType ?? (
      typeof value === 'string' && value.trim().startsWith('&') ? 'int*' : 'int'
    );

    if (this.symbols.has(name)) {
      throw new MemoryModelError(`La variable "${name}" ya fue declarada en esta sección.`);
    }

    let resolvedValue = value;
    let pointsTo = null;
    const { size, alignment } = layoutFor(type);

    if (typeof value === 'string' && value.trim().startsWith('&')) {
      const targetName = parseReference(value.trim());
      const target = this.get(targetName);
      resolvedValue = target.address;
      pointsTo = targetName;
    }

    const resolvedAddress = address ?? formatAddress(alignAddress(this.nextAddress, alignment));
    const symbol = {
      name,
      type,
      value: resolvedValue,
      initialValue: resolvedValue,
      address: resolvedAddress,
      size,
      alignment,
      area: metadata.area ?? this.area,
      pointsTo,
      ...metadata,
      aliases: metadata.aliases ?? []
    };

    this.symbols.set(name, symbol);

    if (pointsTo) {
      const target = this.get(pointsTo);
      target.aliases = [...target.aliases, `*${name}`];
    }

    this.allocator.nextAddress = parseAddress(resolvedAddress) + size;
    return symbol;
  }

  get(name) {
    assertIdentifier(name);
    const symbol = this.symbols.get(name) ?? this.parent?.get(name);

    if (!symbol) {
      throw new MemoryModelError(
        `La variable "${name}" no existe en esta sección; no se puede resolver su dirección.`
      );
    }

    return symbol;
  }

  addressOf(reference) {
    return this.get(parseReference(reference)).address;
  }

  execute(operation = {}) {
    switch (operation.type) {
      case MemoryOperation.DECLARE:
        return this.variable(operation.name, operation.declaration);
      case MemoryOperation.ASSIGN:
        return this.assign(operation.target, operation.value);
      case MemoryOperation.WRITE_THROUGH:
        return this.assign(`*${operation.pointer}`, operation.value);
      case MemoryOperation.COPY: {
        const source = this.get(operation.source);
        const target = this.get(operation.target);
        const previousValue = target.value;
        target.value = source.value;
        return { target, previousValue, value: target.value, source };
      }
      case MemoryOperation.ENTER_SCOPE:
        return this.enter(operation.options);
      case MemoryOperation.EXIT_SCOPE:
        return this.exit();
      default:
        throw new MemoryModelError(`Operación de memoria desconocida: "${operation.type}".`);
    }
  }

  assign(expression, value) {
    const target = typeof expression === 'string' && expression.startsWith('*')
      ? this.get(expression.slice(1).trim()).pointsTo
        ? this.get(this.get(expression.slice(1).trim()).pointsTo)
        : null
      : this.get(expression);

    if (!target) {
      throw new MemoryModelError(`"${expression}" no apunta a una variable asignable.`);
    }

    const previousValue = target.value;
    target.value = value;
    return { target, previousValue, value };
  }

  reset() {
    this.symbols.forEach((symbol) => {
      symbol.value = symbol.initialValue;
    });
    this.children.forEach((child) => child.reset());
  }
}
