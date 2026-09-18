import { alignAddress, formatAddress, parseAddress } from './memory-utils';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface MemoryDeclaration {
  value?: unknown;
  address?: string;
  type?: string;
  [key: string]: unknown;
}

export interface MemorySymbol {
  name: string;
  type: string;
  value: unknown;
  initialValue: unknown;
  address: string;
  size: number;
  alignment: number;
  area: string;
  pointsTo: string | null;
  aliases: string[];
  [key: string]: unknown;
}

interface MemoryAllocator {
  nextAddress: number;
}

interface EnterScopeOptions {
  area?: string;
  addressGap?: number;
}

export const MemoryOperation = Object.freeze({
  DECLARE: 'declare',
  ASSIGN: 'assign',
  WRITE_THROUGH: 'write-through',
  COPY: 'copy',
  ENTER_SCOPE: 'enter-scope',
  EXIT_SCOPE: 'exit-scope'
} as const);

type MemoryOperationInput =
  | { type: typeof MemoryOperation.DECLARE; name: string; declaration?: MemoryDeclaration | unknown }
  | { type: typeof MemoryOperation.ASSIGN; target: string; value: unknown }
  | { type: typeof MemoryOperation.WRITE_THROUGH; pointer: string; value: unknown }
  | { type: typeof MemoryOperation.COPY; source: string; target: string }
  | { type: typeof MemoryOperation.ENTER_SCOPE; options?: EnterScopeOptions }
  | { type: typeof MemoryOperation.EXIT_SCOPE };

export class MemoryModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryModelError';
  }
}

function assertIdentifier(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new MemoryModelError(`"${name}" no es un identificador válido.`);
  }
}

function parseReference(reference: unknown): string {
  if (typeof reference !== 'string' || !reference.startsWith('&')) {
    throw new MemoryModelError(`"${reference}" no es una referencia válida. Usa &nombre.`);
  }

  const name = reference.slice(1).trim();
  assertIdentifier(name);
  return name;
}

function layoutFor(type: string): { size: number; alignment: number } {
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
  public readonly area: string;
  public readonly parent: MemoryScope | null;
  public readonly children: MemoryScope[];
  public readonly allocator: MemoryAllocator;
  public readonly symbols: Map<string, MemorySymbol>;

  constructor({ area = 'STACK', baseAddress = 0x100, parent = null, allocator = null }: {
    area?: string;
    baseAddress?: number;
    parent?: MemoryScope | null;
    allocator?: MemoryAllocator | null;
  } = {}) {
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

  enter({ area = this.area, addressGap = 0 }: EnterScopeOptions = {}): MemoryScope {
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

  exit(): MemoryScope {
    if (!this.parent) {
      throw new MemoryModelError('El ámbito raíz no tiene un ámbito padre del que salir.');
    }

    return this.parent;
  }

  variable(name: string, declaration: MemoryDeclaration | unknown = {}): MemorySymbol {
    assertIdentifier(name);

    const options = declaration !== null && typeof declaration === 'object'
      ? declaration as MemoryDeclaration
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
    let pointsTo: string | null = null;
    const { size, alignment } = layoutFor(type);

    if (typeof value === 'string' && value.trim().startsWith('&')) {
      const targetName = parseReference(value.trim());
      const target = this.get(targetName);
      resolvedValue = target.address;
      pointsTo = targetName;
    }

    const resolvedAddress = address ?? formatAddress(alignAddress(this.nextAddress, alignment));
    const metadataArea = typeof metadata.area === 'string' ? metadata.area : this.area;
    const aliases = Array.isArray(metadata.aliases)
      ? metadata.aliases.filter((alias): alias is string => typeof alias === 'string')
      : [];
    const symbol: MemorySymbol = {
      name,
      type,
      value: resolvedValue,
      initialValue: resolvedValue,
      address: resolvedAddress,
      size,
      alignment,
      area: metadataArea,
      pointsTo,
      ...metadata,
      aliases
    };

    this.symbols.set(name, symbol);

    if (pointsTo) {
      const target = this.get(pointsTo);
      target.aliases = [...target.aliases, `*${name}`];
    }

    this.allocator.nextAddress = parseAddress(resolvedAddress) + size;
    return symbol;
  }

  get(name: string): MemorySymbol {
    assertIdentifier(name);
    const symbol = this.symbols.get(name) ?? this.parent?.get(name);

    if (!symbol) {
      throw new MemoryModelError(
        `La variable "${name}" no existe en esta sección; no se puede resolver su dirección.`
      );
    }

    return symbol;
  }

  addressOf(reference: string): string {
    return this.get(parseReference(reference)).address;
  }

  execute(operation = {} as MemoryOperationInput): unknown {
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
        throw new MemoryModelError(
          `Operación de memoria desconocida: "${String((operation as { type: unknown }).type)}".`
        );
    }
  }

  assign(expression: string, value: unknown): {
    target: MemorySymbol;
    previousValue: unknown;
    value: unknown;
  } {
    let target: MemorySymbol | null;
    if (expression.startsWith('*')) {
      const pointer = this.get(expression.slice(1).trim());
      target = pointer.pointsTo ? this.get(pointer.pointsTo) : null;
    } else {
      target = this.get(expression);
    }

    if (!target) {
      throw new MemoryModelError(`"${expression}" no apunta a una variable asignable.`);
    }

    const previousValue = target.value;
    target.value = value;
    return { target, previousValue, value };
  }

  reset(): void {
    this.symbols.forEach((symbol) => {
      symbol.value = symbol.initialValue;
    });
    this.children.forEach((child) => child.reset());
  }
}
