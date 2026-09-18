// The renderer is DOM-heavy and remains behavior-preserving during this
// migration. Its public data contracts are tightened in the typed core first.
// @ts-nocheck

import { setIcon } from './icons';

const normalizeArea = (area = 'STACK') => String(area).toUpperCase();

let accessibilityPreferences = {
  highlightChanges: false,
  pointerArrows: false
};
let activeAccessibilityRefresh = null;

export function setAccessibilityPreferences(nextPreferences = {}) {
  accessibilityPreferences = {
    ...accessibilityPreferences,
    ...nextPreferences
  };
  activeAccessibilityRefresh?.();
}

function snapshotItems(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  return [...(snapshot?.stack ?? []), ...(snapshot?.heap ?? [])];
}

function snapshotScopes(snapshot) {
  return Array.isArray(snapshot) ? [] : (snapshot?.scopes ?? []);
}

export function createMemoryArea(area, label = area) {
  const normalizedArea = normalizeArea(area);
  const section = document.createElement('section');
  section.className = `memory-area memory-area--${normalizedArea.toLowerCase()}`;
  section.dataset.memoryArea = normalizedArea;

  const title = document.createElement('h2');
  title.className = 'memory-area__title';
  title.textContent = label;

  section.append(title);
  return section;
}

export function createCodeLine(tokens) {
  const paragraph = document.createElement('p');
  paragraph.className = 'code';

  const code = document.createElement('code');
  tokens.forEach(({ text, className = '' }) => {
    const token = document.createElement('span');
    token.className = className;
    token.textContent = text;
    code.append(token);
  });

  paragraph.append(code);
  return paragraph;
}

export function createMemoryBlock({
  id = '',
  area = 'STACK',
  address = '',
  name = '',
  value = '',
  alias = '',
  aliases = [],
  frameLabel = '',
  frameId = '',
  fields = [],
  size = 4,
  freed = false,
  steps = {}
} = {}) {
  const normalizedArea = normalizeArea(area);
  const block = document.createElement('article');
  block.className = `memory-block memory-block--${normalizedArea.toLowerCase()}`;
  block.dataset.memoryArea = normalizedArea;
  block.dataset.memoryName = name;
  block.dataset.memoryItemId = id;
  block.dataset.memorySize = String(size);
  block.dataset.memoryFrameId = frameId;
  block.classList.toggle('memory-block--freed', freed);
  block.setAttribute('aria-label', `${normalizedArea}: ${name || 'bloque de memoria'}`);

  const addressElement = document.createElement('span');
  addressElement.className = 'memory-block__address';
  addressElement.dataset.memoryField = 'address';
  addressElement.textContent = address;
  markMemoryStep(addressElement, steps.address ?? 3);

  const valueElement = document.createElement('span');
  valueElement.className = 'memory-block__value';
  valueElement.dataset.memoryField = 'value';
  valueElement.textContent = value;
  markMemoryStep(valueElement, steps.value ?? 2);

  const nameElement = document.createElement('span');
  nameElement.className = 'memory-block__name';
  nameElement.dataset.memoryField = 'name';
  nameElement.textContent = name;
  markMemoryStep(nameElement, steps.name ?? 1);

  block.append(addressElement, valueElement, nameElement);

  if (frameLabel) {
    const frameElement = document.createElement('span');
    frameElement.className = 'memory-block__frame';
    frameElement.textContent = frameLabel;
    frameElement.dataset.memoryField = 'frame';
    block.append(frameElement);
  }

  if (fields.length > 0) {
    const fieldsElement = document.createElement('div');
    fieldsElement.className = 'memory-block__fields';
    fields.forEach((field) => {
      const fieldElement = document.createElement('div');
      fieldElement.className = 'memory-block__field';
      fieldElement.dataset.memoryFieldName = field.name;
      fieldElement.dataset.memoryFieldId = field.id ?? '';

      const fieldName = document.createElement('span');
      fieldName.className = 'memory-field__name';
      fieldName.textContent = field.name;

      const fieldValue = document.createElement('span');
      fieldValue.className = 'memory-field__value';
      fieldValue.dataset.memoryField = 'value';
      fieldValue.textContent = field.value;

      const fieldAddress = document.createElement('span');
      fieldAddress.className = 'memory-field__address';
      fieldAddress.dataset.memoryField = 'address';
      fieldAddress.textContent = field.address;

      fieldElement.append(fieldName, fieldValue, fieldAddress);
      (field.aliases ?? []).forEach((text, index) => {
        const aliasElement = document.createElement('span');
        aliasElement.className = 'memory-field__alias memory-alias';
        aliasElement.textContent = text;
        aliasElement.dataset.aliasIndex = String(index);
        aliasElement.setAttribute('aria-hidden', 'true');
        fieldElement.append(aliasElement);
      });
      fieldsElement.append(fieldElement);
    });
    block.append(fieldsElement);
  }

  const allAliases = alias ? [alias, ...aliases] : aliases;
  allAliases.forEach((text, index) => {
    const aliasElement = document.createElement('span');
    aliasElement.className = 'memory-block__alias memory-alias';
    aliasElement.textContent = text;
    aliasElement.dataset.aliasIndex = String(index);
    aliasElement.setAttribute('aria-hidden', 'true');
    block.append(aliasElement);
  });

  return block;
}

function markMemoryStep(element, step) {
  element.classList.add('memory-step');
  element.dataset.memoryStep = String(step);
}

export function renderMemoryBlock(container, data) {
  const block = createMemoryBlock(data);
  container.append(block);
  return block;
}

export function bindMemoryHighlights(root) {
  const memoryExamples = root.matches?.('[id$="-memory"]')
    ? [root]
    : [...root.querySelectorAll('[id$="-memory"]')];
  const addressPattern = /^0x[0-9a-f]+$/i;

  memoryExamples.forEach((memoryExample) => {
    const fields = [...memoryExample.querySelectorAll(
      '[data-memory-field="address"], [data-memory-field="value"]'
    )];
    const blockAddresses = [...memoryExample.querySelectorAll('.memory-block__address')];

    const clearHighlights = () => {
      memoryExample.querySelectorAll('.memory-highlight-field').forEach((field) => {
        field.classList.remove('memory-highlight-field');
      });
      memoryExample.querySelectorAll('.memory-highlight-block').forEach((block) => {
        block.classList.remove('memory-highlight-block');
      });
    };

    fields.forEach((field) => {
      const highlight = () => {
        const address = field.textContent.trim();
        if (!addressPattern.test(address)) return;

        clearHighlights();
        const matchingBlocks = blockAddresses.filter(
          (candidate) => candidate.textContent.trim() === address
        );

        // Keep the source field as the only highlighted part of its own
        // block. The destination is resolved through a block's base address,
        // so a pointer value such as 0x310 highlights node 2, not node 1.
        field.classList.add('memory-highlight-field');
        matchingBlocks.forEach((matchingBlock) => {
          matchingBlock.classList.add('memory-highlight-field');
          matchingBlock.closest('.memory-block')?.classList.add('memory-highlight-block');
        });
      };

      field.addEventListener('pointerenter', highlight);
      field.addEventListener('pointerleave', clearHighlights);
    });
  });
}

export function createMemoryExample({
  id,
  code,
  buttonLabel,
  symbol,
  area = 'STACK',
  description,
  idleStatus,
  runningStatus,
  readyStatus
}) {
  const example = document.createElement('section');
  example.className = 'example';
  example.setAttribute('aria-labelledby', `${id}-title`);

  const codeLine = document.createElement('div');
  codeLine.className = 'code-line';

  const playButton = document.createElement('button');
  playButton.id = `${id}-play`;
  playButton.className = 'play-button';
  playButton.type = 'button';
  playButton.setAttribute('aria-label', buttonLabel);
  setIcon(playButton, 'play');

  const codeElement = createCodeLine(code);
  codeElement.id = `${id}-title`;
  codeLine.append(playButton, codeElement);

  const memory = document.createElement('div');
  memory.id = `${id}-memory`;
  memory.setAttribute('aria-label', `Representación de ${buttonLabel.toLowerCase()}`);

  const memoryArea = createMemoryArea(symbol?.area ?? area);
  const stack = document.createElement('div');
  stack.className = 'stack-memory';

  ['top', 'bottom'].forEach((position) => {
    const line = document.createElement('div');
    line.className = `memory-line memory-line--${position}`;
    line.setAttribute('aria-hidden', 'true');
    stack.append(line);
  });

  const block = renderMemoryBlock(stack, {
    area: symbol?.area ?? area,
    address: symbol?.address,
    name: symbol?.name,
    value: symbol?.value,
    aliases: symbol?.aliases ?? []
  });
  block.classList.add('draw-on-play');
  block.setAttribute('aria-hidden', 'true');
  memoryArea.append(stack);
  memory.append(memoryArea);

  const descriptionElement = document.createElement('p');
  descriptionElement.className = 'description';
  descriptionElement.textContent = description;

  const status = document.createElement('p');
  status.className = 'status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = idleStatus;

  example.append(codeLine, memory, descriptionElement, status);

  return {
    example,
    block,
    playButton,
    status,
    runningStatus,
    readyStatus
  };
}

export function bindMemoryAnimation({
  block,
  playButton,
  status,
  runningStatus,
  readyStatus
}) {
  const timers = [];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stepStart = reducedMotion ? 0 : 430;
  const stepDelay = reducedMotion ? 0 : 150;

  const schedule = (callback, delay) => {
    const timer = window.setTimeout(callback, delay);
    timers.push(timer);
  };

  const reset = () => {
    timers.splice(0).forEach(window.clearTimeout);
    block.classList.remove('is-drawn');
    block.querySelectorAll('.memory-step').forEach((step) => {
      step.classList.remove('is-visible');
    });
    block.setAttribute('aria-hidden', 'true');
    playButton.disabled = false;
    status.textContent = status.dataset.idle;
  };

  playButton.addEventListener('click', () => {
    playButton.disabled = true;
    status.textContent = runningStatus;
    block.classList.add('is-drawn');
    block.removeAttribute('aria-hidden');

    const steps = [...block.querySelectorAll('.memory-step')]
      .sort((first, second) => Number(first.dataset.memoryStep) - Number(second.dataset.memoryStep));

    steps.forEach((step, index) => {
      schedule(() => {
        step.classList.add('is-visible');
      }, stepStart + index * stepDelay);
    });

    schedule(() => {
      status.textContent = readyStatus;
    }, stepStart + Math.max(steps.length - 1, 0) * stepDelay + (reducedMotion ? 0 : 180));
  });

  status.dataset.idle = status.textContent;
  return reset;
}

export function createMemorySequence({
  id,
  instructions,
  area = 'STACK',
  description,
  idleStatus,
  showScopeBoundary = false,
  scopeBoundaryLabel = 'Límite del ámbito interno',
  stageVariant = '',
  source = [],
  sourceInteractive = false,
  layoutMode = 'fixed'
}) {
  const example = document.createElement('section');
  example.className = 'example';
  example.setAttribute('aria-labelledby', `${id}-title`);

  const codeSequence = document.createElement('div');
  codeSequence.className = 'code-sequence';

  const sourceCode = document.createElement('div');
  sourceCode.className = 'function-source';
  source.forEach(({ tokens, indent = 0 }, index) => {
    const sourceLine = document.createElement('div');
    sourceLine.className = 'code-line code-line--sequence function-source__line';
    sourceLine.dataset.sourceIndex = String(index);
    sourceLine.dataset.indent = String(indent);

    const codeElement = createCodeLine(tokens);
    codeElement.id = index === 0 ? `${id}-title` : `${id}-source-line-${index + 1}`;
    sourceLine.append(codeElement);
    sourceCode.append(sourceLine);
  });

  const playButton = document.createElement('button');
  playButton.id = `${id}-play`;
  playButton.className = 'play-button';
  playButton.type = 'button';
  playButton.setAttribute('aria-label', instructions[0].buttonLabel);
  setIcon(playButton, 'play');

  const lines: HTMLElement[] = sourceInteractive
    ? instructions.map((instruction, index) => {
      const line = sourceCode.children[instruction.sourceIndex] as HTMLElement;
      line.dataset.step = String(index);
      if (!line.hasAttribute('aria-label')) line.setAttribute('aria-label', instruction.buttonLabel);
      return line;
    })
    : instructions.map((instruction, index) => {
      const line = document.createElement('div');
      line.className = 'code-line code-line--sequence';
      line.dataset.step = String(index);
      line.dataset.indent = String(instruction.indent ?? 0);

      const codeElement = createCodeLine(instruction.code);
      codeElement.id = index === 0 ? `${id}-title` : `${id}-line-${index + 1}`;
      line.setAttribute('aria-label', instruction.buttonLabel);
      line.append(codeElement);

      return line;
    });

  if (sourceInteractive) {
    lines[0].classList.add('is-active');
    sourceCode.classList.add('function-source--interactive');
    [...sourceCode.children].forEach((line) => codeSequence.append(line));
  } else {
    lines[0].classList.add('is-active');
    lines.forEach((line) => codeSequence.append(line));
  }

  codeSequence.append(playButton);

  const memory = document.createElement('div');
  memory.id = `${id}-memory`;
  memory.setAttribute('aria-label', 'Representación de las instrucciones de memoria');

  const memoryArea = createMemoryArea(area);
  const stack = document.createElement('div');
  stack.className = [
    'stack-memory',
    'memory-sequence-stage',
    'memory-sequence-stage--separated',
    layoutMode === 'dynamic' ? 'memory-sequence-stage--dynamic' : '',
    showScopeBoundary ? 'memory-sequence-stage--scope' : '',
    stageVariant ? `memory-sequence-stage--${stageVariant}` : ''
  ].filter(Boolean).join(' ');

  ['top', 'bottom'].forEach((position) => {
    const line = document.createElement('div');
    line.className = `memory-line memory-line--${position}`;
    line.setAttribute('aria-hidden', 'true');
    stack.append(line);
  });

  let scopeBoundary = null;
  if (showScopeBoundary) {
    scopeBoundary = document.createElement('div');
    scopeBoundary.className = 'memory-scope-boundary';
    scopeBoundary.setAttribute('role', 'separator');
    scopeBoundary.setAttribute('aria-label', scopeBoundaryLabel);
    scopeBoundary.setAttribute('aria-hidden', 'true');
    stack.append(scopeBoundary);
  }

  let memorySlot = 0;
  const blocks = instructions.map((instruction, index) => {
    const symbol = instruction.symbol;
    if (!symbol) return null;

    const block = renderMemoryBlock(stack, {
      area: symbol.area,
      address: symbol.address,
      name: symbol.name,
      value: symbol.value,
      aliases: symbol.aliases ?? []
    });
    block.classList.add('draw-on-play', `memory-block--step-${index}`);
    block.dataset.memorySlot = String(memorySlot);
    memorySlot += 1;
    block.setAttribute('aria-hidden', 'true');
    return block;
  });

  memoryArea.append(stack);
  memory.append(memoryArea);

  const descriptionElement = document.createElement('p');
  descriptionElement.className = 'description';
  descriptionElement.textContent = description;

  const status = document.createElement('p');
  status.className = 'status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = idleStatus;

  if (source.length > 0 && !sourceInteractive) example.append(sourceCode);
  example.append(codeSequence, memory, descriptionElement, status);

  return {
    example,
    codeSequence,
    stack,
    blocks,
    lines,
    playButton,
    status,
    instructions,
    scopeBoundary,
    layoutMode
  };
}

export function bindMemorySequence({
  stack,
  codeSequence,
  blocks,
  lines,
  playButton,
  status,
  instructions,
  scopeBoundary,
  layoutMode = 'fixed'
}) {
  const timers = [];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stepStart = reducedMotion ? 0 : 430;
  const stepDelay = reducedMotion ? 0 : 150;
  let currentStep = 0;

  const schedule = (callback, delay) => {
    const timer = window.setTimeout(callback, delay);
    timers.push(timer);
  };

  const layoutDynamicBlocks = (extraBlock = null) => {
    if (layoutMode !== 'dynamic') return;

    const visibleBlocks = blocks.filter((block) => (
      block && (block.classList.contains('is-drawn') || block === extraBlock)
    ));
    const gap = 16;
    const availableWidth = stack.clientWidth || 680;
    const width = Math.min(180, Math.max(48, (availableWidth - gap * Math.max(visibleBlocks.length - 1, 0)) / Math.max(visibleBlocks.length, 1)));
    const rowWidth = visibleBlocks.length * width + Math.max(visibleBlocks.length - 1, 0) * gap;
    const start = (availableWidth - rowWidth) / 2;

    visibleBlocks.forEach((block, index) => {
      block.style.width = `${width}px`;
      block.style.left = `${start + index * (width + gap) + width / 2}px`;
    });
  };

  const resolveVisibleLine = (line: HTMLElement | undefined): HTMLElement | undefined => line;

  const positionPlayButton = (targetLine: HTMLElement | undefined, animate = true) => {
    const visibleTarget = resolveVisibleLine(targetLine);
    if (!visibleTarget) return;
    const targetTop = visibleTarget.offsetTop + (visibleTarget.offsetHeight - playButton.offsetHeight) / 2;
    const currentTop = playButton.offsetTop;
    const deltaY = currentTop - targetTop;

    playButton.style.transition = 'none';
    playButton.style.top = `${targetTop}px`;
    playButton.style.transform = animate ? `translateY(${deltaY}px)` : '';

    window.requestAnimationFrame(() => {
      playButton.style.transition = !animate || reducedMotion
        ? 'none'
        : 'transform 360ms cubic-bezier(0.22, 0.8, 0.25, 1)';
      playButton.style.transform = animate ? 'translateY(0)' : '';
    });

    schedule(() => {
      playButton.style.transition = '';
      playButton.style.transform = '';
    }, !animate || reducedMotion ? 0 : 380);
  };

  const revealBlock = (block, { spawnDelay = 0, fieldsDelay = stepStart } = {}) => {
    const showBlock = () => {
      layoutDynamicBlocks(block);
      block.classList.add('is-drawn');
      block.removeAttribute('aria-hidden');
    };

    if (spawnDelay === 0) showBlock();
    else schedule(showBlock, spawnDelay);

    const steps = [...block.querySelectorAll('.memory-step')]
      .sort((first, second) => Number(first.dataset.memoryStep) - Number(second.dataset.memoryStep));

    steps.forEach((step, index) => {
      schedule(() => step.classList.add('is-visible'), fieldsDelay + index * stepDelay);
    });

    return Math.max(spawnDelay, fieldsDelay + Math.max(steps.length - 1, 0) * stepDelay);
  };

  const revealAliases = (symbol, delay) => {
    if (!symbol?.pointsTo) return;

    const targetBlock = blocks.find((block) => block.dataset.memoryName === symbol.pointsTo);
    targetBlock?.querySelectorAll('.memory-alias').forEach((alias) => {
      schedule(() => {
        alias.classList.add('is-visible');
        alias.removeAttribute('aria-hidden');
      }, delay);
    });
  };

  const animateValueChange = (result) => {
    if (!result) return 0;

    const targetBlock = blocks.find((block) => block?.dataset.memoryName === result.target.name);
    const valueElement = targetBlock?.querySelector('[data-memory-field="value"]');
    if (!valueElement) return 0;

    valueElement.classList.remove('memory-value-changing');
    void valueElement.offsetWidth;
    valueElement.classList.add('memory-value-changing');

    const changeDelay = reducedMotion ? 0 : 400;
    const finishDelay = reducedMotion ? 0 : 1150;

    schedule(() => {
      valueElement.textContent = String(result.value);
    }, changeDelay);
    schedule(() => {
      valueElement.classList.remove('memory-value-changing');
    }, finishDelay);

    return finishDelay;
  };

  const syncBlock = (block, symbol) => {
    if (!block || !symbol) return;
    const valueElement = block.querySelector('[data-memory-field="value"]');
    if (valueElement) valueElement.textContent = String(symbol.value);
  };

  const hideBlock = (block) => {
    if (!block) return;
    block.classList.remove('is-drawn');
    block.setAttribute('aria-hidden', 'true');
    block.querySelectorAll('.memory-step').forEach((step) => step.classList.remove('is-visible'));
    block.querySelectorAll('.memory-alias').forEach((alias) => {
      alias.classList.remove('is-visible');
      alias.setAttribute('aria-hidden', 'true');
    });
  };

  const applyScopeEffect = (effect, visibleBlocks) => {
    if (!effect || !scopeBoundary) return 0;

    if (effect.type === 'enter') {
      stack.dataset.scopeState = 'active';
      scopeBoundary.classList.add('is-visible');
      scopeBoundary.removeAttribute('aria-hidden');
      return 0;
    }

    if (effect.type === 'exit') {
      (effect.removeSteps ?? []).forEach((step) => hideBlock(blocks[step]));

      const collapseDelay = reducedMotion ? 0 : 460;
      const boundaryCloseDelay = reducedMotion ? 0 : 180;
      schedule(() => {
        stack.dataset.scopeState = 'exited';
        if (visibleBlocks !== undefined) stack.dataset.visibleBlocks = String(visibleBlocks);
        layoutDynamicBlocks();
      }, collapseDelay);
      schedule(() => {
        scopeBoundary.classList.remove('is-visible');
        scopeBoundary.setAttribute('aria-hidden', 'true');
      }, collapseDelay + boundaryCloseDelay);

      return collapseDelay + boundaryCloseDelay;
    }

    return 0;
  };

  const reset = () => {
    timers.splice(0).forEach(window.clearTimeout);
    currentStep = 0;
    stack.classList.remove('memory-sequence-stage--pointer');
    delete stack.dataset.visibleBlocks;
    delete stack.dataset.scopeState;
    scopeBoundary?.classList.remove('is-visible');
    scopeBoundary?.setAttribute('aria-hidden', 'true');
    blocks.forEach((block) => {
      if (!block) return;
      hideBlock(block);
      const instruction = instructions[blocks.indexOf(block)];
      const valueElement = block.querySelector('[data-memory-field="value"]');
      if (instruction?.symbol && valueElement) valueElement.textContent = String(instruction.symbol.value);
      block.style.left = '';
      block.style.width = '';
    });
    layoutDynamicBlocks();
    [...new Set(lines as HTMLElement[])].forEach((line) => {
      line.classList.remove('is-active');
      line.classList.remove('is-complete');
    });
    lines[0].classList.add('is-active');
    playButton.setAttribute('aria-label', instructions[0].buttonLabel);
    playButton.disabled = false;
    playButton.style.transition = '';
    playButton.style.transform = '';
    positionPlayButton(lines[0], false);
    status.textContent = status.dataset.idle;
  };

  playButton.addEventListener('click', () => {
    const instruction = instructions[currentStep];
    const block = blocks[currentStep];
    const isLastStep = currentStep === instructions.length - 1;

    playButton.disabled = true;
    status.textContent = instruction.runningStatus;

    const scopeEffectDelay = applyScopeEffect(
      instruction.scopeEffect,
      instruction.visibleBlocks
    );

    if (currentStep > 0 && block) {
      stack.classList.add('memory-sequence-stage--pointer');
    }

    const operationResult = instruction.execute?.();
    syncBlock(block, operationResult?.target);

    if (instruction.visibleBlocks !== undefined && instruction.scopeEffect?.type !== 'exit') {
      stack.dataset.visibleBlocks = String(instruction.visibleBlocks);
    } else if (block) {
      stack.dataset.visibleBlocks = String(
        blocks.slice(0, currentStep + 1).filter(Boolean).length
      );
    }

    const separationDelay = currentStep > 0 && block && !reducedMotion ? 420 : 0;
    const lastReveal = block
      ? revealBlock(block, {
        spawnDelay: separationDelay,
        fieldsDelay: separationDelay + stepStart
      })
      : animateValueChange(operationResult);

    revealAliases(instruction.symbol, separationDelay + stepStart + 2 * stepDelay);
    const finishDelay = Math.max(lastReveal, scopeEffectDelay) + (reducedMotion ? 0 : 180);

    schedule(() => {
      status.textContent = instruction.readyStatus;
      lines[currentStep].classList.remove('is-active');
      lines[currentStep].classList.add('is-complete');

      if (!isLastStep) {
        currentStep += 1;
        lines[currentStep].classList.add('is-active');
        playButton.setAttribute('aria-label', instructions[currentStep].buttonLabel);
        playButton.disabled = false;
        positionPlayButton(lines[currentStep]);
      }
    }, finishDelay);
  });

  status.dataset.idle = status.textContent;
  positionPlayButton(lines[0], false);
  return reset;
}

export function createTraceSequence({
  id,
  instructions,
  sourceLines = null,
  description,
  idleStatus,
  collapsedFunctionNames = []
}) {
  const example = document.createElement('section');
  example.className = 'example trace-example';
  example.setAttribute('aria-labelledby', `${id}-title`);

  const tracePane = document.createElement('section');
  tracePane.className = 'trace-pane';
  tracePane.setAttribute('aria-label', 'Código interpretado');

  const memoryPane = document.createElement('section');
  memoryPane.className = 'memory-pane';
  memoryPane.setAttribute('aria-label', 'Vista de memoria');

  const codeSequence = document.createElement('div');
  codeSequence.className = 'code-sequence';
  const traceControls = document.createElement('nav');
  traceControls.className = 'trace-controls';
  traceControls.setAttribute('aria-label', 'Controles de ejecución');

  const createTraceControl = (idSuffix, label, iconName) => {
    const button = document.createElement('button');
    button.id = `${id}-${idSuffix}`;
    button.className = 'trace-control';
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    setIcon(button, iconName);
    traceControls.append(button);
    return button;
  };

  const focusExitButton = createTraceControl(
    'focus-exit',
    'Salir de pantalla completa',
    'x'
  );
  focusExitButton.classList.add('trace-control--exit');
  const stepBackButton = createTraceControl('step-back', 'Retroceder un paso', 'arrow-left');
  const stepForwardButton = createTraceControl('step-forward', 'Avanzar un paso', 'play');
  const autoPlayButton = createTraceControl('auto-play', 'Ejecutar automáticamente', 'chevrons-right');

  const lines = [];
  const stepLines = [];
  const linesBySourceKey = new Map();
  const functionToggleNames = [];
  const instructionBySourceKey = new Map();
  const dynamicLineFallbacks = new Map();

  instructions.forEach((instruction) => {
    if (!instructionBySourceKey.has(instruction.sourceKey)) {
      instructionBySourceKey.set(instruction.sourceKey, instruction);
    }
  });

  const appendLine = (descriptor, fallbackInstruction = null) => {
    const sourceKey = descriptor.sourceKey ?? `step:${lines.length}`;
    if (linesBySourceKey.has(sourceKey)) return linesBySourceKey.get(sourceKey);

    const line = document.createElement('div');
    const lineIndex = lines.length;
    const instruction = fallbackInstruction ?? instructionBySourceKey.get(sourceKey);
    linesBySourceKey.set(sourceKey, line);
    lines.push(line);
    const isImplicitLine = Boolean(descriptor.implicit || instruction?.implicit);
    line.className = `code-line code-line--sequence${isImplicitLine ? ' code-line--implicit' : ''}`;
    line.dataset.sourceKey = sourceKey;
    line.dataset.step = String(lineIndex);
    line.dataset.indent = String(descriptor.indent ?? instruction?.indent ?? 0);
    if (instruction?.kind) line.dataset.stepKind = instruction.kind;
    if (instruction?.kind === 'return') line.classList.add('code-line--return');
    if (descriptor.functionGroup) line.dataset.functionGroup = descriptor.functionGroup;
    const isFunctionCollapsed = descriptor.functionGroup
      && collapsedFunctionNames.includes(descriptor.functionGroup);
    if (isFunctionCollapsed) {
      line.classList.add('is-collapsed');
      line.setAttribute('aria-hidden', 'true');
    }
    if (descriptor.functionHeader) {
      line.dataset.functionHeader = descriptor.functionHeader;
      line.dataset.functionCollapsible = String(descriptor.collapsible);
    }
    line.setAttribute('aria-label', instruction?.buttonLabel ?? sourceKey);
    line.dataset.staticAriaLabel = line.getAttribute('aria-label');

    const codeElement = createCodeLine(descriptor.code ?? instruction?.code ?? []);
    codeElement.id = lineIndex === 0 ? `${id}-title` : `${id}-line-${lineIndex + 1}`;
    line.append(codeElement);
    if (isImplicitLine) dynamicLineFallbacks.set(line, codeElement.cloneNode(true));
    if (descriptor.functionHeader && descriptor.collapsible) {
      const functionNameToken = codeElement.querySelector('.cpp-identifier');
      if (functionNameToken) {
        functionNameToken.classList.add('function-toggle-name');
        functionNameToken.setAttribute('role', 'button');
        functionNameToken.setAttribute('tabindex', '0');
        const isCollapsed = collapsedFunctionNames.includes(descriptor.functionHeader);
        functionNameToken.setAttribute('aria-expanded', String(!isCollapsed));
        functionNameToken.setAttribute(
          'aria-label',
          `${isCollapsed ? 'Expandir' : 'Colapsar'} ${descriptor.functionHeader}()`
        );
        if (isCollapsed) line.classList.add('is-function-collapsed');
        functionToggleNames.push(functionNameToken);
      }
    }
    codeSequence.append(line);
    return line;
  };

  if (sourceLines?.length) {
    sourceLines.forEach((descriptor) => appendLine(descriptor));
  }

  instructions.forEach((instruction, index) => {
    const line = appendLine({
      sourceKey: instruction.sourceKey ?? `step:${index}`,
      code: instruction.code,
      indent: instruction.indent
    }, instruction);
    stepLines[index] = line;
  });

  const dynamicCodeKey = (instruction) => instruction
    ? instruction.code.map(({ text, className = '' }) => `${className}:${text}`).join('\u001f')
    : '';

  const updateDynamicLine = (line, instruction = null) => {
    const fallback = dynamicLineFallbacks.get(line);
    if (!fallback) return;
    const codeElement = line.querySelector('.code');
    if (!codeElement) return;
    const nextKey = dynamicCodeKey(instruction);
    if (line.dataset.dynamicCodeKey === nextKey) return;

    const replacement = instruction ? createCodeLine(instruction.code) : fallback.cloneNode(true);
    replacement.id = codeElement.id;
    line.replaceChild(replacement, codeElement);
    line.dataset.dynamicCodeKey = nextKey;
    line.setAttribute('aria-label', instruction?.buttonLabel ?? line.dataset.staticAriaLabel);
  };

  const syncDynamicParameters = (lastExecutedStep) => {
    const latestByLine = new Map();
    instructions.forEach((instruction, index) => {
      if (index > lastExecutedStep || !instruction.implicit) return;
      const line = stepLines[index];
      if (line) latestByLine.set(line, instruction);
    });
    dynamicLineFallbacks.forEach((fallback, line) => {
      updateDynamicLine(line, latestByLine.get(line) ?? null);
    });
  };

  syncDynamicParameters(-1);

  stepLines[0]?.classList.add('is-active');

  const playButton = document.createElement('button');
  playButton.id = `${id}-play`;
  playButton.className = 'play-button';
  playButton.type = 'button';
  playButton.setAttribute('aria-label', instructions[0]?.buttonLabel ?? 'Ejecutar código');
  setIcon(playButton, 'play');
  codeSequence.append(playButton);

  const memory = document.createElement('div');
  memory.id = `${id}-memory`;
  memory.className = 'trace-memory';
  memory.setAttribute('aria-label', 'Representación de stack y heap');

  const pointerArrows = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  pointerArrows.classList.add('memory-pointer-arrows');
  pointerArrows.setAttribute('aria-hidden', 'true');
  pointerArrows.setAttribute('focusable', 'false');
  memory.append(pointerArrows);

  const allItems = new Map();
  instructions.forEach((instruction) => {
    snapshotItems(instruction.memory).forEach((item) => {
      const previous = allItems.get(item.id);
      if (!previous) {
        allItems.set(item.id, item);
        return;
      }
      allItems.set(item.id, {
        ...item,
        aliases: [...new Set([...(previous.aliases ?? []), ...(item.aliases ?? [])])]
      });
    });
  });

  const stages = new Map();
  ['STACK', 'HEAP'].forEach((area) => {
    const areaSection = createMemoryArea(area);
  const stage = document.createElement('div');
  stage.className = 'stack-memory memory-sequence-stage memory-sequence-stage--separated memory-sequence-stage--dynamic memory-sequence-stage--trace';

    ['top', 'bottom'].forEach((position) => {
      const line = document.createElement('div');
      line.className = `memory-line memory-line--${position}`;
      line.setAttribute('aria-hidden', 'true');
      stage.append(line);
    });

    const scopeRails = document.createElement('div');
    scopeRails.className = 'memory-scope-rails';
    scopeRails.setAttribute('aria-hidden', 'true');
    stage.append(scopeRails);

    const blocks = new Map();
    [...allItems.values()]
      .filter((item) => item.area === area)
      .forEach((item) => {
        const block = renderMemoryBlock(stage, item);
        block.classList.add('draw-on-play', 'memory-block--trace');
        if (item.fields?.length) block.classList.add('memory-block--fields');
        block.setAttribute('aria-hidden', 'true');
        blocks.set(item.id, block);
      });

    areaSection.append(stage);
    memory.append(areaSection);
    stages.set(area, { areaSection, stage, blocks, scopeRails });
  });

  const descriptionElement = document.createElement('p');
  descriptionElement.className = 'description';
  descriptionElement.textContent = description;

  const status = document.createElement('p');
  status.className = 'status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = idleStatus;
  status.hidden = !idleStatus;

  tracePane.append(traceControls, codeSequence);
  memoryPane.append(memory);
  if (description) memoryPane.append(descriptionElement);
  memoryPane.append(status);
  const splitter = document.createElement('div');
  splitter.className = 'trace-splitter';
  splitter.id = `${id}-splitter`;
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', 'vertical');
  splitter.setAttribute('aria-label', 'Redimensionar código y memoria');
  splitter.setAttribute('aria-valuemin', '20');
  splitter.setAttribute('aria-valuemax', '80');
  splitter.setAttribute('aria-valuenow', '50');
  splitter.setAttribute('tabindex', '0');

  example.append(tracePane, splitter, memoryPane);
  return {
    example,
    tracePane,
    memoryPane,
    splitter,
    codeSequence,
    lines,
    stepLines,
    playButton,
    focusExitButton,
    stepBackButton,
    stepForwardButton,
    autoPlayButton,
    functionToggleNames,
    syncDynamicParameters,
    status,
    instructions,
    stages,
    memory,
    pointerArrows
  };
}

export function bindTraceSequence({
  lines,
  stepLines = lines,
  playButton,
  stepBackButton,
  stepForwardButton,
  autoPlayButton,
  functionToggleNames = [],
  syncDynamicParameters = () => {},
  status,
  instructions,
  stages,
  memory,
  pointerArrows,
  splitter
}) {
  const timers = [];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stepDelay = reducedMotion ? 0 : 760;
  let currentStep = 0;
  let lastExecutedStep = -1;
  let previousSnapshot = new Map();
  let activeScopes = [];
  let holdActive = false;
  let holdPointerId: number | 'mouse' | null = null;
  let suppressNextClick = false;
  let isRunning = false;
  let autoRunActive = false;
  let holdTimer = null;
  const holdThreshold = reducedMotion ? 0 : 320;
  let lastMemoryItems = new Map();
  let lastChangedBlocks = new Map();
  let refreshAccessibility = () => {};
  let splitRatio = 50;

  const updateSplitRatio = (nextRatio) => {
    splitRatio = Math.max(20, Math.min(80, nextRatio));
    const example = memory.closest('.trace-example');
    example?.style.setProperty('--trace-split-ratio', `${splitRatio}%`);
    splitter?.setAttribute('aria-valuenow', String(Math.round(splitRatio)));
  };

  if (splitter) {
    let isDragging = false;
    const example = memory.closest('.trace-example');

    const updateFromPointer = (clientX) => {
      const rect = example?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      updateSplitRatio(((clientX - rect.left) / rect.width) * 100);
    };

    splitter.addEventListener('pointerdown', (event) => {
      isDragging = true;
      splitter.setPointerCapture?.(event.pointerId);
      example?.classList.add('is-resizing');
      updateFromPointer(event.clientX);
      event.preventDefault();
    });

    splitter.addEventListener('pointermove', (event) => {
      if (isDragging) updateFromPointer(event.clientX);
    });

    const stopDragging = (event) => {
      if (!isDragging) return;
      isDragging = false;
      splitter.releasePointerCapture?.(event.pointerId);
      example?.classList.remove('is-resizing');
    };

    splitter.addEventListener('pointerup', stopDragging);
    splitter.addEventListener('pointercancel', stopDragging);
    splitter.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') {
        updateSplitRatio(splitRatio - 5);
        event.preventDefault();
      } else if (event.key === 'ArrowRight') {
        updateSplitRatio(splitRatio + 5);
        event.preventDefault();
      } else if (event.key === 'Home') {
        updateSplitRatio(20);
        event.preventDefault();
      } else if (event.key === 'End') {
        updateSplitRatio(80);
        event.preventDefault();
      }
    });
  }

  const syncTraceControls = () => {
    if (stepBackButton) stepBackButton.disabled = isRunning || currentStep === 0;
    if (stepForwardButton) stepForwardButton.disabled = isRunning || currentStep >= instructions.length;
    if (autoPlayButton) {
      autoPlayButton.disabled = currentStep >= instructions.length;
      autoPlayButton.classList.toggle('is-active', autoRunActive);
      const label = autoRunActive ? 'Detener ejecución automática' : 'Ejecutar automáticamente';
      autoPlayButton.setAttribute('aria-label', label);
      autoPlayButton.title = label;
    }
  };

  const schedule = (callback, delay) => {
    const timer = window.setTimeout(callback, delay);
    timers.push(timer);
  };

  const resolveVisibleLine = (line) => {
    if (!line?.classList.contains('is-collapsed')) return line;
    const functionName = line.dataset.functionGroup;
    return lines.find((candidate) => candidate.dataset.functionHeader === functionName) ?? line;
  };

  const collapsedFunctionSpan = (instruction, startIndex) => {
    if (instruction?.kind !== 'scope-open' || instruction.scopeKind !== 'function') return null;
    const functionName = stepLines[startIndex]?.dataset.functionGroup;
    if (!functionName) return null;
    const toggle = functionToggleNames.find((candidate) => (
      candidate.closest('.code-line')?.dataset.functionHeader === functionName
      && candidate.getAttribute('aria-expanded') === 'false'
    ));
    if (!toggle) return null;

    const closeIndex = instructions.findIndex((candidate, index) => (
      index > startIndex
      && ((candidate.kind === 'return' && candidate.functionReturn)
        || (candidate.kind === 'scope-close' && candidate.scopeKind === 'function'))
      && (candidate.scopeId === instruction.scopeId || candidate.scopeLabel === `${functionName}()`)
    ));
    if (closeIndex < 0) return null;

    return { functionName, closeIndex };
  };

  const syncScopeRails = (stageData, scopes) => {
    if (!stageData.scopeRails) return;

    const activeScopes = scopes.filter((scope) => scope.active);
    const activeIds = new Set(activeScopes.map((scope) => scope.id));

    stageData.scopeRails.querySelectorAll('.memory-scope-rail').forEach((rail) => {
      if (activeIds.has(rail.dataset.scopeId) || rail.classList.contains('is-closing')) return;
      rail.classList.add('is-closing');
      schedule(() => rail.remove(), reducedMotion ? 0 : 360);
    });

    activeScopes.forEach((scope, index) => {
      let rail = stageData.scopeRails.querySelector(`[data-scope-id="${CSS.escape(scope.id)}"]`);
      if (!rail) {
        rail = document.createElement('span');
        rail.className = 'memory-scope-rail';
        rail.dataset.scopeId = scope.id;
        stageData.scopeRails.append(rail);
        window.requestAnimationFrame(() => rail.classList.add('is-visible'));
      }
      const ownedBlocks = (scope.visibleIds ?? [])
        .map((id) => stageData.blocks.get(id))
        .filter((block) => block?.classList.contains('is-drawn'));
      const visibleBlocks = [...stageData.blocks.values()]
        .filter((block) => block.classList.contains('is-drawn'));
      const referenceBlocks = ownedBlocks.length > 0 ? ownedBlocks : visibleBlocks;
      // The blocks can be moving while a new snapshot is applied. Use their
      // layout targets instead of an in-between getBoundingClientRect value,
      // so the rail and the blocks animate toward the same destination.
      const stageRect = stageData.stage.getBoundingClientRect();
      const stageWidth = stageRect.width || stageData.stage.clientWidth || 680;
      const blockEdges = (block) => {
        const targetCenter = Number.parseFloat(block.style.left);
        const targetWidth = Number.parseFloat(block.style.width);
        if (Number.isFinite(targetCenter) && Number.isFinite(targetWidth)) {
          return {
            left: targetCenter - targetWidth / 2,
            right: targetCenter + targetWidth / 2
          };
        }
        const rect = block.getBoundingClientRect();
        return {
          left: rect.left - stageRect.left,
          right: rect.right - stageRect.left
        };
      };
      const firstBlockLeft = referenceBlocks.length > 0
        ? Math.min(...referenceBlocks.map((block) => blockEdges(block).left))
        : null;
      const isContiguous = stageData.stage.classList.contains('memory-sequence-stage--trace');
      const boundaryOffset = isContiguous ? 20 : 18;
      const depth = Number(scope.scopeDepth ?? index);
      const depthOffset = depth * (isContiguous ? 4 : 12);
      const externalBlocks = visibleBlocks.filter((block) => !ownedBlocks.includes(block));
      const previousBlockRight = externalBlocks.length > 0
        ? Math.max(...externalBlocks.map((block) => blockEdges(block).right))
        : null;
      const boundary = scope.kind === 'function'
        ? ownedBlocks.length > 0
          ? depth > 0 && previousBlockRight !== null
            ? previousBlockRight + boundaryOffset
            : firstBlockLeft - boundaryOffset
          : depth > 0 && visibleBlocks.length > 0
            ? Math.max(...visibleBlocks.map((block) => blockEdges(block).right)) + boundaryOffset
            : (firstBlockLeft === null ? stageWidth / 2 + depthOffset : firstBlockLeft - boundaryOffset)
        : referenceBlocks.length > 0
          ? (ownedBlocks.length > 0
          ? firstBlockLeft - boundaryOffset + depthOffset
          : Math.max(...referenceBlocks.map((block) => blockEdges(block).right)) + boundaryOffset + depthOffset)
        : 18 + depthOffset;
      rail.style.left = `${Math.max(8, Math.min(stageWidth - 8, boundary))}px`;
      rail.style.setProperty('--scope-depth', String(scope.scopeDepth ?? index));
      rail.dataset.scopeLabel = scope.label;
      rail.setAttribute('aria-label', `Ámbito activo: ${scope.label}`);
    });
  };

  const layoutStage = ({ stage, blocks, scopeRails }, extraId = null) => {
    const visible = [...blocks.entries()]
      .filter(([id, block]) => block.classList.contains('is-drawn') || id === extraId)
      .map(([, block]) => block);
    const isTraceStage = stage.classList.contains('memory-sequence-stage--trace');
    const isContiguous = isTraceStage;
    const gap = isContiguous ? 20 : 16;
    const frameGap = isContiguous ? 40 : gap;
    const scopeGutter = isContiguous ? 0 : (scopeRails ? 26 : 0);
    const sideInset = isContiguous ? 20 : 0;
    const availableWidth = Math.max(
      0,
      (stage.clientWidth || 680) - scopeGutter - sideInset * 2
    );
    const count = Math.max(visible.length, 1);
    const gaps = visible.slice(0, -1).map((block, index) => (
      isContiguous
      && block.dataset.memoryFrameId
      && visible[index + 1].dataset.memoryFrameId
      && block.dataset.memoryFrameId !== visible[index + 1].dataset.memoryFrameId
        ? frameGap
        : gap
    ));
    const width = Math.min(180, Math.max(48, (
      availableWidth - gaps.reduce((total, value) => total + value, 0)
    ) / count));
    const rowWidth = visible.length * width + gaps.reduce((total, value) => total + value, 0);
    const start = sideInset + scopeGutter + (availableWidth - rowWidth) / 2;

    let offset = 0;
    visible.forEach((block, index) => {
      block.style.width = `${width}px`;
      block.style.left = `${start + offset + width / 2}px`;
      offset += width + (gaps[index] ?? 0);
    });
  };

  const refreshScopeRails = (stageData, scopes) => {
    layoutStage(stageData);
    syncScopeRails(stageData, scopes);
    // A newly drawn block can still be in its entry transition during the
    // first layout pass. Re-read the geometry on the next frame and once the
    // block transition has settled.
    window.requestAnimationFrame(() => syncScopeRails(stageData, scopes));
    schedule(() => syncScopeRails(stageData, scopes), reducedMotion ? 0 : 440);
  };

  const relayout = () => {
    stages.forEach((stageData) => {
      layoutStage(stageData);
      if (stageData.areaSection.dataset.memoryArea === 'STACK') {
        refreshScopeRails(stageData, activeScopes);
      }
    });
    window.requestAnimationFrame(refreshAccessibility);
  };

  window.addEventListener('resize', relayout);
  if (typeof ResizeObserver !== 'undefined') {
    const stageObserver = new ResizeObserver(relayout);
    stages.forEach(({ stage }) => stageObserver.observe(stage));
  }

  const updateBlock = (block, item) => {
    block.dataset.memoryName = item.name;
    if (item.size !== undefined) block.dataset.memorySize = String(item.size);
    if (item.frameId !== undefined) block.dataset.memoryFrameId = item.frameId;
    block.setAttribute('aria-label', `${item.area}: ${item.name}`);
    const address = block.querySelector('[data-memory-field="address"]');
    const value = block.querySelector('.memory-block__value');
    const name = block.querySelector('.memory-block__name');
    if (address) address.textContent = item.address;
    if (value) value.textContent = item.value;
    if (name) name.textContent = item.name;

    const aliases = item.aliases ?? [];
    block.querySelectorAll('.memory-alias').forEach((aliasElement, index) => {
      const alias = aliases[index];
      aliasElement.textContent = alias ?? '';
      aliasElement.classList.toggle('is-visible', Boolean(alias));
      aliasElement.setAttribute('aria-hidden', String(!alias));
    });

    const frame = block.querySelector('.memory-block__frame');
    if (frame) frame.textContent = item.frameLabel ?? '';

    block.classList.toggle('memory-block--freed', Boolean(item.freed));
    block.querySelectorAll('.memory-block__field').forEach((fieldElement) => {
      const field = item.fields?.find((candidate) => candidate.name === fieldElement.dataset.memoryFieldName);
      if (!field) return;
      fieldElement.querySelector('.memory-field__name').textContent = field.name;
      fieldElement.querySelector('.memory-field__value').textContent = field.value;
      fieldElement.querySelector('.memory-field__address').textContent = field.address;
      fieldElement.querySelectorAll('.memory-alias').forEach((aliasElement, index) => {
        const alias = field.aliases?.[index];
        aliasElement.textContent = alias ?? '';
        aliasElement.classList.toggle('is-visible', Boolean(alias));
        aliasElement.setAttribute('aria-hidden', String(!alias));
      });
    });
  };

  const changedValues = (before, after) => {
    const changed = [];
    after.forEach((item) => {
      const previous = before.get(item.id);
      if (!previous) {
        changed.push({ itemId: item.id, fieldName: null, kind: 'created' });
        return;
      }
      if (previous.value !== item.value) {
        changed.push({ itemId: item.id, fieldName: null, kind: 'modified' });
      }
      item.fields?.forEach((field) => {
        const oldField = previous?.fields?.find((candidate) => candidate.name === field.name);
        if (oldField && oldField.value !== field.value) {
          changed.push({ itemId: item.id, fieldName: field.name, kind: 'modified' });
        }
      });
    });
    return changed;
  };

  const isPointerType = (type) => typeof type === 'string' && type.includes('*');

  const memoryElementById = () => {
    const elements = new Map();
    stages.forEach(({ blocks }) => {
      blocks.forEach((block, id) => {
        elements.set(id, block);
        block.querySelectorAll('[data-memory-field-id]').forEach((field) => {
          if (field.dataset.memoryFieldId) elements.set(field.dataset.memoryFieldId, field);
        });
      });
    });
    return elements;
  };

  const elementPoint = (element, rootRect, edge = 'center') => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: (edge === 'right' ? rect.right : edge === 'left' ? rect.left : rect.left + rect.width / 2) - rootRect.left,
      y: rect.top + rect.height / 2 - rootRect.top
    };
  };

  const refreshPointerArrows = () => {
    if (!pointerArrows) return;
    pointerArrows.replaceChildren();
    if (!accessibilityPreferences.pointerArrows || lastMemoryItems.size === 0) return;

    const rootRect = memory.getBoundingClientRect();
    const width = Math.max(1, rootRect.width);
    const height = Math.max(1, memory.scrollHeight || rootRect.height);
    pointerArrows.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const svgNamespace = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(svgNamespace, 'defs');
    const marker = document.createElementNS(svgNamespace, 'marker');
    marker.id = 'memory-pointer-arrowhead';
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '8');
    marker.setAttribute('refX', '7');
    marker.setAttribute('refY', '4');
    marker.setAttribute('orient', 'auto');
    marker.setAttribute('markerUnits', 'strokeWidth');
    const markerPath = document.createElementNS(svgNamespace, 'path');
    markerPath.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
    markerPath.classList.add('memory-pointer-arrowhead');
    marker.append(markerPath);
    defs.append(marker);
    pointerArrows.append(defs);

    const elements = memoryElementById();
    const sources = [];
    lastMemoryItems.forEach((item) => {
      if (isPointerType(item.type) && item.pointerTargetId) {
        sources.push({ sourceId: item.id, targetId: item.pointerTargetId });
      }
      item.fields?.forEach((field) => {
        if (isPointerType(field.type) && field.pointerTargetId) {
          sources.push({ sourceId: field.id, targetId: field.pointerTargetId });
        }
      });
    });

    sources.forEach(({ sourceId, targetId }) => {
      const sourceElement = elements.get(sourceId);
      const targetElement = elements.get(targetId);
      if (!sourceElement || !targetElement) return;
      if (!sourceElement.closest('.is-drawn') || !targetElement.closest('.is-drawn')) return;

      const sourceValue = sourceElement.classList.contains('memory-block__field')
        ? sourceElement.querySelector('.memory-field__value')
        : sourceElement.querySelector('.memory-block__value');
      const sourcePoint = elementPoint(sourceValue ?? sourceElement, rootRect, 'right');
      const targetPoint = elementPoint(targetElement, rootRect, 'center');
      if (!sourcePoint || !targetPoint) return;

      const direction = targetPoint.x >= sourcePoint.x ? 1 : -1;
      const bend = Math.max(28, Math.abs(targetPoint.x - sourcePoint.x) * 0.34);
      const path = document.createElementNS(svgNamespace, 'path');
      path.classList.add('memory-pointer-arrow');
      path.setAttribute(
        'd',
        `M ${sourcePoint.x} ${sourcePoint.y} C ${sourcePoint.x + direction * bend} ${sourcePoint.y}, ${targetPoint.x - direction * bend} ${targetPoint.y}, ${targetPoint.x} ${targetPoint.y}`
      );
      path.setAttribute('marker-end', 'url(#memory-pointer-arrowhead)');
      pointerArrows.append(path);
    });
  };

  const refreshChangeHighlights = () => {
    stages.forEach(({ blocks }) => {
      blocks.forEach((block) => {
        block.classList.remove('memory-block--created', 'memory-block--modified');
      });
    });
    if (!accessibilityPreferences.highlightChanges) return;
    lastChangedBlocks.forEach((kind, itemId) => {
      const block = [...stages.values()]
        .flatMap((stageData) => [...stageData.blocks.entries()])
        .find(([id]) => id === itemId)?.[1];
      block?.classList.add(kind === 'created' ? 'memory-block--created' : 'memory-block--modified');
    });
  };

  refreshAccessibility = () => {
    refreshChangeHighlights();
    refreshPointerArrows();
  };
  activeAccessibilityRefresh = refreshAccessibility;

  const applySnapshot = (snapshot) => {
    const next = new Map(snapshotItems(snapshot).map((item) => [item.id, item]));
    const changed = changedValues(previousSnapshot, next);
    const changedBlocks = new Map();
    changed.forEach(({ itemId, kind }) => {
      if (kind === 'created' || changedBlocks.get(itemId) !== 'created') {
        changedBlocks.set(itemId, kind);
      }
    });
    lastChangedBlocks = changedBlocks;
    lastMemoryItems = next;
    const scopes = snapshotScopes(snapshot);
    activeScopes = scopes;

    stages.forEach((stageData) => {
      stageData.blocks.forEach((block, id) => {
        const item = next.get(id);
        if (!item) {
          if (block.classList.contains('is-drawn')) {
            block.classList.add('memory-block--exiting');
          }
          block.classList.remove('is-drawn');
          block.setAttribute('aria-hidden', 'true');
          return;
        }
        block.classList.remove('memory-block--exiting');
        if (!block.classList.contains('is-drawn')) {
          layoutStage(stageData, id);
          block.classList.add('is-drawn');
          block.querySelectorAll('.memory-step').forEach((step) => step.classList.add('is-visible'));
          block.removeAttribute('aria-hidden');
        }
        updateBlock(block, item);
      });
      layoutStage(stageData);
      if (stageData.areaSection.dataset.memoryArea === 'STACK') {
        refreshScopeRails(stageData, scopes);
      }
    });

    changed.forEach(({ itemId, fieldName }) => {
      const block = [...stages.values()]
        .flatMap((stageData) => [...stageData.blocks.entries()])
        .find(([id]) => id === itemId)?.[1];
      const target = fieldName
        ? block?.querySelector(`[data-memory-field-name="${fieldName}"] .memory-field__value`)
        : block?.querySelector('.memory-block__value');
      if (!target) return;
      target.classList.remove('memory-value-changing');
      void target.offsetWidth;
      target.classList.add('memory-value-changing');
      schedule(() => target.classList.remove('memory-value-changing'), reducedMotion ? 0 : 1150);
    });

    refreshAccessibility();
    schedule(refreshAccessibility, reducedMotion ? 0 : 440);
    previousSnapshot = next;
  };

  const positionPlayButton = (targetLine, animate = true) => {
    const targetTop = targetLine.offsetTop + (targetLine.offsetHeight - playButton.offsetHeight) / 2;
    const currentTop = playButton.offsetTop;
    const deltaY = currentTop - targetTop;
    playButton.style.transition = 'none';
    playButton.style.top = `${targetTop}px`;
    playButton.style.transform = animate ? `translateY(${deltaY}px)` : '';
    window.requestAnimationFrame(() => {
      playButton.style.transition = !animate || reducedMotion
        ? 'none'
        : 'transform 360ms cubic-bezier(0.22, 0.8, 0.25, 1)';
      playButton.style.transform = animate ? 'translateY(0)' : '';
    });
  };

  const scrollActiveLineIntoView = (targetLine) => {
    const visibleLine = resolveVisibleLine(targetLine);
    if (!visibleLine) return;

    const tracePane = playButton.closest('.trace-pane');
    const paneRect = tracePane?.getBoundingClientRect();
    const lineRect = visibleLine.getBoundingClientRect();
    const lineOutsidePane = paneRect
      && (lineRect.top < paneRect.top || lineRect.bottom > paneRect.bottom);
    const paneCanScroll = tracePane
      && tracePane.scrollHeight > tracePane.clientHeight + 1;

    if (paneCanScroll) {
      if (!lineOutsidePane) return;
      const desiredTop = tracePane.scrollTop
        + (lineRect.top - paneRect.top)
        - Math.max(20, (tracePane.clientHeight - lineRect.height) / 2);
      const maxTop = Math.max(0, tracePane.scrollHeight - tracePane.clientHeight);
      tracePane.scrollTo({
        top: Math.max(0, Math.min(maxTop, desiredTop)),
        behavior: reducedMotion ? 'auto' : 'smooth'
      });
      return;
    }

    const lineOutsideViewport = lineRect.top < 0 || lineRect.bottom > window.innerHeight;
    if (!lineOutsideViewport) return;

    visibleLine.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest'
    });
  };

  const reset = () => {
    timers.splice(0).forEach(window.clearTimeout);
    holdActive = false;
    holdPointerId = null;
    suppressNextClick = false;
    isRunning = false;
    autoRunActive = false;
    if (holdTimer !== null) window.clearTimeout(holdTimer);
    holdTimer = null;
    playButton.classList.remove('is-holding');
    playButton.classList.remove('is-auto-running');
    playButton.classList.remove('is-running');
    currentStep = 0;
    lastExecutedStep = -1;
    previousSnapshot = new Map();
    lastMemoryItems = new Map();
    lastChangedBlocks = new Map();
    activeScopes = [];
    stages.forEach(({ stage, blocks, scopeRails }) => {
      delete stage.dataset.visibleBlocks;
      scopeRails?.replaceChildren();
      blocks.forEach((block) => {
        block.classList.remove('is-drawn', 'memory-block--freed', 'memory-block--exiting');
        block.setAttribute('aria-hidden', 'true');
        block.querySelectorAll('.memory-step').forEach((step) => step.classList.remove('is-visible'));
        block.style.left = '';
        block.style.top = '';
        block.style.width = '';
        block.querySelectorAll('.memory-value-changing').forEach((element) => element.classList.remove('memory-value-changing'));
      });
      stage.style.height = '';
    });
    lines.forEach((line) => line.classList.remove(
      'is-active',
      'is-complete',
      'code-line--returning',
      'code-line--scope-closing'
    ));
    stepLines[0]?.classList.add('is-active');
    syncDynamicParameters(lastExecutedStep);
    playButton.disabled = false;
    playButton.setAttribute('aria-label', instructions[0]?.buttonLabel ?? 'Ejecutar código');
    playButton.style.transition = '';
    playButton.style.transform = '';
    positionPlayButton(stepLines[0], false);
    status.textContent = status.dataset.idle;
    refreshAccessibility();
    syncTraceControls();
  };

  const advanceStep = () => {
    if (isRunning || currentStep >= instructions.length) return;

    const instruction = instructions[currentStep];
    const collapsedSpan = collapsedFunctionSpan(instruction, currentStep);
    const executionEndStep = collapsedSpan?.closeIndex ?? currentStep;
    const nextStep = executionEndStep + 1;
    const isLastStep = nextStep >= instructions.length;
    isRunning = true;
    playButton.disabled = !(holdActive || autoRunActive);
    playButton.classList.add('is-running');
    syncTraceControls();
    lines.forEach((line) => line.classList.remove('code-line--returning', 'code-line--scope-closing'));
    if (instruction.kind === 'return') stepLines[currentStep]?.classList.add('code-line--returning');
    if (instruction.kind === 'scope-close') stepLines[currentStep]?.classList.add('code-line--scope-closing');
    status.textContent = collapsedSpan
      ? `Ejecutando ${collapsedSpan.functionName}().`
      : instruction.runningStatus;
    applySnapshot(instructions[executionEndStep].memory ?? []);
    lastExecutedStep = executionEndStep;
    syncDynamicParameters(lastExecutedStep);

    schedule(() => {
      isRunning = false;
      status.textContent = instructions[executionEndStep].readyStatus;
      for (let index = currentStep; index <= executionEndStep; index += 1) {
        const completedLine = stepLines[index];
        completedLine?.classList.remove('is-active');
        completedLine?.classList.add('is-complete');
      }
      stepLines[currentStep]?.classList.remove('code-line--returning', 'code-line--scope-closing');
      if (!isLastStep) {
        currentStep = nextStep;
        const nextLine = stepLines[currentStep];
        nextLine?.classList.remove('is-complete');
        lines.forEach((line) => line.classList.remove('is-active'));
        resolveVisibleLine(nextLine)?.classList.add('is-active');
        playButton.setAttribute('aria-label', instructions[currentStep].buttonLabel);
        playButton.disabled = false;
        playButton.classList.remove('is-running');
        positionPlayButton(resolveVisibleLine(nextLine));
        syncTraceControls();
        // Keep the next executable line visible after every step. This is
        // especially important when the trace pane has its own scroll area;
        // only scrolling on function returns left long traces stranded above
        // the currently active instruction.
        window.requestAnimationFrame(() => scrollActiveLineIntoView(nextLine));
        if (holdActive || autoRunActive) schedule(advanceStep, reducedMotion ? 0 : 120);
      } else {
        holdActive = false;
        autoRunActive = false;
        playButton.disabled = false;
        playButton.classList.remove('is-running');
        playButton.classList.remove('is-auto-running');
        syncTraceControls();
      }
    }, stepDelay);
  };

  const rewindStep = () => {
    if (isRunning || currentStep === 0) return;

    timers.splice(0).forEach(window.clearTimeout);
    holdActive = false;
    autoRunActive = false;
    if (holdTimer !== null) window.clearTimeout(holdTimer);
    holdTimer = null;
    playButton.classList.remove('is-holding', 'is-auto-running', 'is-running');

    currentStep -= 1;
    lastExecutedStep = currentStep - 1;
    applySnapshot(currentStep > 0 ? instructions[currentStep - 1].memory ?? [] : []);
    syncDynamicParameters(lastExecutedStep);
    lines.forEach((line) => line.classList.remove(
      'is-active',
      'is-complete',
      'code-line--returning',
      'code-line--scope-closing'
    ));
    for (let index = 0; index < currentStep; index += 1) {
      stepLines[index]?.classList.add('is-complete');
    }

    const targetLine = stepLines[currentStep];
    resolveVisibleLine(targetLine)?.classList.add('is-active');
    playButton.setAttribute('aria-label', instructions[currentStep]?.buttonLabel ?? 'Ejecutar código');
    playButton.disabled = false;
    if (targetLine) {
      const visibleTarget = resolveVisibleLine(targetLine);
      positionPlayButton(visibleTarget);
      window.requestAnimationFrame(() => scrollActiveLineIntoView(visibleTarget));
    }
    status.textContent = currentStep > 0
      ? instructions[currentStep - 1].readyStatus
      : status.dataset.idle;
    syncTraceControls();
  };

  const stopHold = (event?: { pointerId?: number }) => {
    if (holdPointerId !== null && event?.pointerId !== undefined && event.pointerId !== holdPointerId) return;
    holdActive = false;
    holdPointerId = null;
    if (holdTimer !== null) window.clearTimeout(holdTimer);
    holdTimer = null;
    playButton.classList.remove('is-holding');
    if (!autoRunActive) playButton.classList.remove('is-auto-running');
    syncTraceControls();
  };

  const startHold = (pointerId: number | 'mouse') => {
    if (playButton.disabled || isRunning) return;
    suppressNextClick = true;
    holdActive = true;
    holdPointerId = pointerId;
    autoRunActive = false;
    playButton.classList.add('is-holding');
    syncTraceControls();
    advanceStep();
    holdTimer = window.setTimeout(() => {
      holdTimer = null;
      if (!holdActive) return;
      autoRunActive = true;
      playButton.classList.add('is-auto-running');
      syncTraceControls();
      if (!isRunning) advanceStep();
    }, holdThreshold);
  };

  playButton.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    startHold('mouse');
  });

  window.addEventListener('mouseup', () => {
    if (holdPointerId === 'mouse') stopHold();
  });

  playButton.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    startHold(event.pointerId);
    playButton.setPointerCapture?.(event.pointerId);
  });

  window.addEventListener('pointerup', stopHold);
  window.addEventListener('pointercancel', stopHold);

  playButton.addEventListener('click', () => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    advanceStep();
  });

  stepBackButton?.addEventListener('click', rewindStep);
  stepForwardButton?.addEventListener('click', advanceStep);
  autoPlayButton?.addEventListener('click', () => {
    if (autoRunActive) {
      autoRunActive = false;
      autoPlayButton.classList.remove('is-active');
      playButton.classList.remove('is-auto-running');
      syncTraceControls();
      return;
    }
    if (currentStep >= instructions.length) return;
    autoRunActive = true;
    autoPlayButton.classList.add('is-active');
    playButton.classList.add('is-auto-running');
    syncTraceControls();
    if (!isRunning) advanceStep();
  });

  const toggleFunction = (functionName, toggleToken) => {
    const collapsed = toggleToken.getAttribute('aria-expanded') === 'true';
    const headerLine = lines.find((line) => line.dataset.functionHeader === functionName);
    lines
      .filter((line) => line.dataset.functionGroup === functionName)
      .forEach((line) => {
        line.classList.toggle('is-collapsed', collapsed);
        line.setAttribute('aria-hidden', String(collapsed));
      });
    headerLine?.classList.toggle('is-function-collapsed', collapsed);
    toggleToken.setAttribute('aria-expanded', String(!collapsed));
    toggleToken.setAttribute(
      'aria-label',
      `${collapsed ? 'Expandir' : 'Colapsar'} ${functionName}()`
    );
    syncDynamicParameters(lastExecutedStep);

    lines.forEach((line) => line.classList.remove('is-active'));
    const currentLine = stepLines[currentStep];
    resolveVisibleLine(currentLine)?.classList.add('is-active');
    if (currentLine) positionPlayButton(resolveVisibleLine(currentLine));
  };

  functionToggleNames.forEach((toggleToken) => {
    const headerLine = toggleToken.closest('.code-line');
    const functionName = headerLine?.dataset.functionHeader;
    if (!functionName) return;
    toggleToken.addEventListener('click', () => toggleFunction(functionName, toggleToken));
    toggleToken.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleFunction(functionName, toggleToken);
    });
  });

  status.dataset.idle = status.textContent;
  positionPlayButton(stepLines[0], false);
  syncTraceControls();
  reset.relayout = relayout;
  return reset;
}
