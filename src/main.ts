// The bootstrap module coordinates the DOM and is migrated separately from
// the strictly typed model and utility modules.
// @ts-nocheck

import './styles.css';
import {
  bindMemoryHighlights,
  bindTraceSequence,
  createTraceSequence,
  setAccessibilityPreferences
} from './memory-render';
import { buildMemoryProgram, CParserError, CExecutionError } from './c-interpreter';
import { INTERPRETER_LIMITS } from './interpreter-limits';
import { registerResetter, resetAllStates } from './reset-state';
import { setIcon } from './icons';
import {
  analyzeSource,
  getCompletions,
  getDefinition,
  getHoverInfo,
  getRenameEdits
} from './language-service';

const resetButton = document.getElementById('reset-page');
const resetIcon = resetButton?.querySelector('.reset-icon');
const themeButton = document.getElementById('theme-toggle');
const themeIcon = themeButton?.querySelector('.theme-icon');
const shareButton = document.getElementById('share-code');
const shareIcon = shareButton?.querySelector('.share-icon');
const disclaimer = document.getElementById('site-disclaimer');
const disclaimerDismiss = document.getElementById('site-disclaimer-dismiss');
const accessibilityMenu = document.querySelector<HTMLElement>('.accessibility-menu');
const accessibilityToggle = document.getElementById('accessibility-toggle') as HTMLButtonElement | null;
const accessibilityIcon = accessibilityToggle?.querySelector('.accessibility-icon');
const accessibilityPanel = document.getElementById('accessibility-panel');
const changeHighlightCheckbox = document.getElementById('accessibility-change-highlight') as HTMLInputElement | null;
const pointerArrowsCheckbox = document.getElementById('accessibility-pointer-arrows') as HTMLInputElement | null;
const symbolHoverCheckbox = document.getElementById('accessibility-symbol-hover') as HTMLInputElement | null;
const examplesRoot = document.getElementById('memory-examples');
const sourceInput = document.getElementById('source-input') as HTMLTextAreaElement | null;
const sourceEditor = document.querySelector('.source-editor') as HTMLElement | null;
const sourceHighlight = document.getElementById('source-highlight');
const sourceHighlightCode = sourceHighlight?.querySelector('code');
const sourceCompletions = document.getElementById('source-completions');
const sourceHover = document.getElementById('source-hover');
const sourceRename = document.getElementById('source-rename') as HTMLFormElement | null;
const sourceRenameInput = document.getElementById('source-rename-input') as HTMLInputElement | null;
const sourceRenameCancel = document.getElementById('source-rename-cancel');
const sourceLineNumbersList = document.getElementById('source-line-numbers-list');
const sourceDiagnostics = document.getElementById('source-diagnostics');
const sourceDiagnosticsCount = document.getElementById('source-diagnostics-count');
const sourceDiagnosticsList = document.getElementById('source-diagnostics-list');
const sourceSymbols = document.getElementById('source-symbols');
const sourceSymbolsCount = document.getElementById('source-symbols-count');
const sourceSymbolsBody = document.getElementById('source-symbols-body');
const interpretButton = document.getElementById('interpret-code');
const formatButton = document.getElementById('format-code');
const shareStatus = document.getElementById('share-status');
const draftStatus = document.getElementById('draft-status');
const sourcePosition = document.getElementById('source-position');
const parserStatus = document.getElementById('parser-status');
const buildCommit = document.getElementById('build-commit');
const editorPanel = document.querySelector('.editor-panel');
const mainElement = document.querySelector('main');

if (buildCommit) {
  const commitSha = __APP_COMMIT__ === 'local' ? 'local' : __APP_COMMIT__.slice(0, 7);
  buildCommit.textContent = commitSha;
  buildCommit.title = `Commit de compilación: ${__APP_COMMIT__}`;
}

sourceInput?.setAttribute('maxlength', String(INTERPRETER_LIMITS.maxSourceLength));

let resetCurrentProgram = () => {};
let stopExecutionFocusTracking = () => {};
const executionViewTransitionName = 'execution-surface';

// Keep one deterministic transition path. The native View Transition API was
// producing compositor snapshots of the editor in this browser, which made
// the action label appear as an oversized ghost during the morph.
const canUseExecutionViewTransition = () => false;

const runExecutionViewTransition = (update) => {
  if (!canUseExecutionViewTransition()) {
    update();
    return null;
  }

  const transition = document.startViewTransition(update);
  transition.finished.catch(() => {});
  return transition;
};

function setTraceVisibility(isVisible) {
  if (!examplesRoot) return;
  examplesRoot.hidden = !isVisible;
  examplesRoot.setAttribute('aria-hidden', String(!isVisible));
}

const cppTypes = new Set(['bool', 'char', 'double', 'float', 'int', 'long', 'short', 'void']);
const cppKeywords = new Set([
  'break', 'case', 'continue', 'default', 'delete', 'else', 'for', 'free', 'if',
  'malloc', 'NULL', 'return', 'sizeof', 'struct', 'switch', 'while'
]);
const sourceTokenPattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|[A-Za-z_]\w*|==|!=|<=|>=|->|\+\+|--|&&|\|\||[{}()[\];,.\*&=+\-/%<>:?!]/g;

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function sourceTokenClass(token) {
  if (token.startsWith('//') || token.startsWith('/*')) return 'cpp-comment';
  if (token.startsWith('"') || token.startsWith("'")) return 'cpp-string';
  if (/^\d/.test(token)) return 'cpp-number';
  if (cppTypes.has(token)) return 'cpp-type';
  if (cppKeywords.has(token)) return 'cpp-keyword';
  if (/^[A-Za-z_]\w*$/.test(token)) return 'cpp-identifier';
  if (/^[{}()[\];,.]$/.test(token)) return 'cpp-punctuation';
  return 'cpp-operator';
}

function highlightSource(source) {
  let output = '';
  let cursor = 0;
  source.replace(sourceTokenPattern, (token, offset) => {
    output += escapeHtml(source.slice(cursor, offset));
    output += `<span class="${sourceTokenClass(token)}">${escapeHtml(token)}</span>`;
    cursor = offset + token.length;
    return token;
  });
  output += escapeHtml(source.slice(cursor));
  return output || ' ';
}

function syncSourceHighlight() {
  if (!sourceHighlightCode || !sourceInput) return;
  sourceHighlightCode.innerHTML = highlightSource(sourceInput.value);
  sourceHighlightCode.style.transform = `translate(${-sourceInput.scrollLeft}px, ${-sourceInput.scrollTop}px)`;
  if (sourceLineNumbersList) {
    sourceLineNumbersList.style.transform = `translateY(${-sourceInput.scrollTop}px)`;
  }
}

const sourceDraftStorageKey = 'memory-viewer-source-draft';
const editorIndent = '  ';
let editorDiagnostics = [];
const emptySymbolTable = { symbols: [], scopes: [], references: [] };
let editorSymbolTable = emptySymbolTable;
let lastValidSymbolTable = emptySymbolTable;
let editorLanguageAnalysis = null;
let completionLanguageAnalysis = null;
let completionItems = [];
let selectedCompletionIndex = 0;
let draftSaveTimer = null;
let sourceHoverTimer = null;
let latestMemorySnapshot = null;
let memorySnapshots = [];
let renameTarget = null;

function sourcePositionAtOffset(source, offset) {
  const safeOffset = Math.max(0, Math.min(offset, source.length));
  const before = source.slice(0, safeOffset);
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
    offset: safeOffset
  };
}

function sourceOffsetAtPosition(source, line = 1, column = 1) {
  const lines = source.split('\n');
  const lineIndex = Math.max(0, Math.min(lines.length - 1, line - 1));
  const lineStart = lines.slice(0, lineIndex).reduce((offset, text) => offset + text.length + 1, 0);
  return Math.min(source.length, lineStart + Math.max(0, column - 1));
}

function createEditorDiagnostic({
  severity = 'warning',
  code = 'editor',
  message,
  source,
  startOffset = 0,
  endOffset = startOffset + 1
}) {
  const start = sourcePositionAtOffset(source, startOffset);
  const end = sourcePositionAtOffset(source, endOffset);
  return {
    severity,
    code,
    message,
    startOffset,
    endOffset,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column
  };
}

function diagnosticLocationFromError(error, source) {
  const line = Number(error?.line)
    || Number(error?.message?.match(/Línea\s+(\d+)/i)?.[1])
    || Number(error?.message?.match(/línea\s+(\d+)/i)?.[1])
    || 1;
  const column = Number(error?.column)
    || Number(error?.message?.match(/columna\s+(\d+)/i)?.[1])
    || 1;
  const startOffset = sourceOffsetAtPosition(source, line, column);
  return { startOffset, endOffset: Math.min(source.length, startOffset + 1) };
}

function memoryDiagnosticLine(instruction) {
  const lineFromDiagnostic = Number(instruction?.diagnostic?.line);
  if (lineFromDiagnostic) return lineFromDiagnostic;
  return Number(instruction?.sourceKey?.match(/:(\d+):/)?.[1]) || 1;
}

function analyzeEditorSource(source) {
  const languageAnalysis = analyzeSource(source);
  editorLanguageAnalysis = languageAnalysis;
  if (!languageAnalysis.parseError) {
    completionLanguageAnalysis = languageAnalysis;
    editorSymbolTable = languageAnalysis.symbolTable;
    lastValidSymbolTable = languageAnalysis.symbolTable;
  } else if (source.trim()) {
    // Keep the last complete symbol table while the user is midway through an
    // edit such as `head->`. This prevents the symbols panel from flickering
    // whenever the transient text is not parseable yet.
    editorSymbolTable = lastValidSymbolTable;
  } else {
    editorSymbolTable = emptySymbolTable;
    lastValidSymbolTable = emptySymbolTable;
    latestMemorySnapshot = null;
    memorySnapshots = [];
  }
  const diagnostics = languageAnalysis.diagnostics.map((item) => createEditorDiagnostic({
    severity: item.severity,
    code: item.code,
    message: item.message,
    source,
    startOffset: item.range.startOffset,
    endOffset: item.range.endOffset
  }));
  if (source.length > INTERPRETER_LIMITS.maxSourceLength) {
    diagnostics.push(createEditorDiagnostic({
      severity: 'error',
      code: 'source-length',
      message: `El código supera el límite de ${INTERPRETER_LIMITS.maxSourceLength} caracteres.`,
      source,
      startOffset: INTERPRETER_LIMITS.maxSourceLength,
      endOffset: source.length
    }));
  }

  if (languageAnalysis.parseError) {
    const error = languageAnalysis.parseError;
    const { startOffset, endOffset } = diagnosticLocationFromError(error, source);
    diagnostics.push(createEditorDiagnostic({
      severity: 'error',
      code: error?.name === 'CParserError' ? 'parser-error' : 'analysis-error',
      message: error instanceof Error ? error.message : 'No se pudo analizar el código.',
      source,
      startOffset,
      endOffset
    }));
  } else try {
    const program = buildMemoryProgram(source, INTERPRETER_LIMITS);
    memorySnapshots = program.instructions
      .map((instruction) => instruction.memory)
      .filter(Boolean);
    latestMemorySnapshot = memorySnapshots.at(-1) ?? null;
    program.instructions
      .filter((instruction) => instruction.kind === 'memory-error' && instruction.diagnostic)
      .forEach((instruction) => {
        const line = memoryDiagnosticLine(instruction);
        const startOffset = sourceOffsetAtPosition(source, line, 1);
        const type = String(instruction.diagnostic.type ?? 'memory-error').toUpperCase();
        diagnostics.push(createEditorDiagnostic({
          severity: 'warning',
          code: instruction.diagnostic.type ?? 'memory-error',
          message: `${type}: ${instruction.diagnostic.message}`,
          source,
          startOffset,
          endOffset: Math.min(source.length, startOffset + (source.split('\n')[line - 1]?.length ?? 1))
        }));
      });
  } catch (error) {
    const { startOffset, endOffset } = diagnosticLocationFromError(error, source);
    diagnostics.push(createEditorDiagnostic({
      severity: 'error',
      code: error?.name === 'CParserError' ? 'parser-error' : 'interpretation-error',
      message: error instanceof Error ? error.message : 'No se pudo analizar el código.',
      source,
      startOffset,
      endOffset
    }));
  }

  return diagnostics.sort((left, right) => left.startOffset - right.startOffset);
}

function renderLineNumbers(diagnostics = editorDiagnostics) {
  if (!sourceInput || !sourceLineNumbersList) return;
  const lineCount = Math.max(1, sourceInput.value.split('\n').length);
  const diagnosticsByLine = new Map();
  diagnostics.forEach((diagnostic) => {
    const current = diagnosticsByLine.get(diagnostic.line);
    if (!current || diagnostic.severity === 'error' || current.severity === 'info') {
      diagnosticsByLine.set(diagnostic.line, diagnostic);
    }
  });

  sourceLineNumbersList.replaceChildren();
  for (let line = 1; line <= lineCount; line += 1) {
    const lineElement = document.createElement('span');
    lineElement.className = 'source-line-number';
    lineElement.textContent = String(line);
    const diagnostic = diagnosticsByLine.get(line);
    if (diagnostic) {
      lineElement.classList.add(`source-line-number--${diagnostic.severity}`);
      lineElement.title = diagnostic.message;
      const marker = document.createElement('span');
      marker.className = 'source-line-marker';
      marker.setAttribute('aria-hidden', 'true');
      lineElement.prepend(marker);
    }
    sourceLineNumbersList.append(lineElement);
  }
  sourceLineNumbersList.style.transform = `translateY(${-sourceInput.scrollTop}px)`;
}

function updateSourcePosition() {
  if (!sourceInput || !sourcePosition) return;
  const position = sourcePositionAtOffset(sourceInput.value, sourceInput.selectionStart ?? 0);
  sourcePosition.textContent = `Línea ${position.line}, columna ${position.column}`;
}

function focusDiagnostic(diagnostic) {
  if (!sourceInput) return;
  sourceInput.focus();
  sourceInput.setSelectionRange(diagnostic.startOffset, diagnostic.endOffset);
  const lineHeight = Number.parseFloat(window.getComputedStyle(sourceInput).lineHeight) || 25;
  sourceInput.scrollTop = Math.max(0, (diagnostic.line - 1) * lineHeight - sourceInput.clientHeight / 3);
  syncSourceHighlight();
  updateSourcePosition();
}

function focusSourceRange(range) {
  if (!sourceInput || !range) return;
  sourceInput.focus();
  sourceInput.setSelectionRange(range.startOffset, range.endOffset);
  const lineHeight = Number.parseFloat(window.getComputedStyle(sourceInput).lineHeight) || 25;
  sourceInput.scrollTop = Math.max(
    0,
    (range.start.line - 1) * lineHeight - sourceInput.clientHeight / 3
  );
  syncSourceHighlight();
  updateSourcePosition();
}

const symbolKindLabels = {
  variable: 'variable',
  function: 'función',
  struct: 'struct',
  field: 'campo',
  parameter: 'parámetro'
};

function renderSourceSymbols(symbolTable = editorSymbolTable) {
  if (!sourceSymbols || !sourceSymbolsBody) return;
  const symbols = symbolTable.symbols ?? [];
  sourceSymbols.hidden = symbols.length === 0;
  sourceSymbolsBody.replaceChildren();
  if (sourceSymbolsCount) {
    const scopeCount = symbolTable.scopes?.length ?? 0;
    sourceSymbolsCount.textContent = symbols.length
      ? `${symbols.length} símbolos · ${scopeCount} ámbitos`
      : '';
  }

  symbols.forEach((symbol) => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const nameButton = document.createElement('button');
    nameButton.type = 'button';
    nameButton.className = 'source-symbol__button';
    nameButton.textContent = symbol.name;
    nameButton.title = `Ir a ${symbol.name}`;
    nameButton.addEventListener('click', () => focusSourceRange(symbol.selectionRange));
    nameCell.append(nameButton);

    const kindCell = document.createElement('td');
    kindCell.textContent = symbolKindLabels[symbol.kind] ?? symbol.kind;
    const typeCell = document.createElement('td');
    typeCell.textContent = symbol.type;
    const scopeCell = document.createElement('td');
    scopeCell.textContent = symbol.scopeLabel;
    const locationCell = document.createElement('td');
    locationCell.className = 'source-symbol__location';
    locationCell.textContent = `L${symbol.selectionRange.start.line}:C${symbol.selectionRange.start.column}`;
    row.append(nameCell, kindCell, typeCell, scopeCell, locationCell);
    sourceSymbolsBody.append(row);
  });
}

function hideSourceCompletions() {
  if (!sourceCompletions) return;
  sourceCompletions.hidden = true;
  completionItems = [];
  selectedCompletionIndex = 0;
  sourceInput?.removeAttribute('aria-activedescendant');
}

function hideSourceHover() {
  if (!sourceHover) return;
  sourceHover.hidden = true;
  sourceHover.replaceChildren();
}

function sourceOffsetFromPointer(event) {
  if (!sourceInput) return 0;
  const rect = sourceInput.getBoundingClientRect();
  const styles = window.getComputedStyle(sourceInput);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 25;
  const fontSize = Number.parseFloat(styles.fontSize) || 15;
  const characterWidth = fontSize * 0.6;
  const paddingLeft = Number.parseFloat(styles.paddingLeft) || 68;
  const paddingTop = Number.parseFloat(styles.paddingTop) || 18;
  const lines = sourceInput.value.split('\n');
  const lineIndex = Math.max(0, Math.min(
    lines.length - 1,
    Math.floor((event.clientY - rect.top - paddingTop + sourceInput.scrollTop) / lineHeight)
  ));
  const rawColumn = Math.max(0, Math.round(
    (event.clientX - rect.left - paddingLeft + sourceInput.scrollLeft) / characterWidth
  ));
  const column = Math.min(lines[lineIndex]?.length ?? 0, rawColumn);
  return sourceOffsetAtPosition(sourceInput.value, lineIndex + 1, column + 1);
}

function memoryValueForSymbol(symbol, hoverInfo = null) {
  if (!latestMemorySnapshot || !symbol) return null;
  if (symbol.kind !== 'field') {
    const visibleMemoryBlocks = examplesRoot?.querySelectorAll(
      `.memory-block[data-memory-name="${CSS.escape(symbol.name)}"]`
    ) ?? [];
    const visibleBlock = [...visibleMemoryBlocks].find((block) => (
      block.getAttribute('aria-hidden') !== 'true'
    ));
    if (visibleBlock) {
      const visibleValue = visibleBlock
        .querySelector('[data-memory-field="value"]')
        ?.textContent
        ?.trim();
      const visibleAddress = visibleBlock
        .querySelector('[data-memory-field="address"]')
        ?.textContent
        ?.trim();
      if (symbol.type.includes('*') && visibleValue && visibleValue !== '?') return visibleValue;
      if (visibleAddress) return visibleAddress;
    }
    const stackItem = latestMemorySnapshot.stack?.find((item) => item.name === symbol.name);
    if (stackItem) {
      if (symbol.type.includes('*') && stackItem.value && stackItem.value !== '?') {
        return stackItem.value;
      }
      return stackItem.address ?? null;
    }
    return null;
  }
  if (symbol.kind !== 'field' || hoverInfo?.reference?.context !== 'member') return null;
  const receiverName = hoverInfo.reference.receiverName;
  if (!receiverName) return null;

  const visibleBlocks = [...(examplesRoot?.querySelectorAll('.memory-block') ?? [])]
    .filter((block) => block.getAttribute('aria-hidden') !== 'true');
  const receiverBlock = visibleBlocks.find((block) => block.dataset.memoryName === receiverName);
  const receiverValue = receiverBlock
    ?.querySelector('[data-memory-field="value"]')
    ?.textContent
    ?.trim();
  const objectBlock = receiverValue
    ? visibleBlocks.find((block) => (
      block.dataset.memoryArea === 'HEAP'
      && block.querySelector('[data-memory-field="address"]')?.textContent?.trim() === receiverValue
    ))
    : null;
  const visibleField = objectBlock?.querySelector(
    `.memory-block__field[data-memory-field-name="${CSS.escape(symbol.name)}"]`
  );
  const visibleFieldAddress = visibleField
    ?.querySelector('[data-memory-field="address"]')
    ?.textContent
    ?.trim();
  if (visibleFieldAddress) return visibleFieldAddress;

  const receiverStackItem = latestMemorySnapshot.stack?.find((item) => item.name === receiverName);
  const targetId = receiverStackItem?.pointerTargetId;
  const heapItem = latestMemorySnapshot.heap?.find((item) => item.id === targetId);
  const latestFieldAddress = heapItem?.fields?.find((item) => item.name === symbol.name)?.address;
  if (latestFieldAddress) return latestFieldAddress;

  for (const snapshot of [...memorySnapshots].reverse()) {
    const receiver = snapshot.stack?.find((item) => item.name === receiverName);
    const object = snapshot.heap?.find((item) => item.id === receiver?.pointerTargetId);
    const field = object?.fields?.find((item) => item.name === symbol.name);
    if (field?.address) return field.address;
  }
  return null;
}

function positionSourceHover(event) {
  if (!sourceHover || !sourceEditor) return;
  const rect = sourceEditor.getBoundingClientRect();
  const popupWidth = Math.min(280, Math.max(190, sourceEditor.clientWidth - 16));
  const popupHeight = Math.min(96, sourceEditor.clientHeight - 16);
  const rawLeft = event.clientX - rect.left + 12;
  const rawTop = event.clientY - rect.top + 16;
  const left = Math.max(8, Math.min(rawLeft, sourceEditor.clientWidth - popupWidth - 8));
  const top = Math.max(8, Math.min(rawTop, sourceEditor.clientHeight - popupHeight - 8));
  sourceHover.style.left = `${left}px`;
  sourceHover.style.top = `${top}px`;
  sourceHover.style.maxWidth = `${popupWidth}px`;
}

function renderSourceHover(info, event) {
  if (!sourceHover) return;
  sourceHover.replaceChildren();
  const name = document.createElement('strong');
  name.className = 'source-hover__name';
  name.textContent = `${info.symbol.name}: ${info.symbol.type}`;
  const scope = document.createElement('span');
  scope.textContent = `scope: ${info.symbol.scopeLabel}`;
  sourceHover.append(name, scope);
  const address = memoryValueForSymbol(info.symbol, info);
  if (address) {
    const addressLine = document.createElement('span');
    addressLine.textContent = `address: ${address}`;
    sourceHover.append(addressLine);
  }
  sourceHover.hidden = false;
  positionSourceHover(event);
}

function updateSourceHover(event) {
  if (!sourceInput || !activeAccessibilityPreferences.symbolHover) {
    hideSourceHover();
    return;
  }
  if (sourceHoverTimer !== null) window.clearTimeout(sourceHoverTimer);
  const offset = sourceOffsetFromPointer(event);
  sourceHoverTimer = window.setTimeout(() => {
    const analysis = completionLanguageAnalysis ?? editorLanguageAnalysis;
    const info = getHoverInfo(sourceInput.value, offset, analysis)
      ?? getHoverInfo(sourceInput.value, Math.max(0, offset - 1), analysis);
    if (info) renderSourceHover(info, event);
    else hideSourceHover();
    sourceHoverTimer = null;
  }, 220);
}

function positionSourceCompletions() {
  if (!sourceInput || !sourceEditor || !sourceCompletions || sourceCompletions.hidden) return;
  const lineHeight = Number.parseFloat(window.getComputedStyle(sourceInput).lineHeight) || 25;
  const fontSize = Number.parseFloat(window.getComputedStyle(sourceInput).fontSize) || 15;
  const characterWidth = fontSize * 0.6;
  const position = sourcePositionAtOffset(sourceInput.value, sourceInput.selectionStart ?? 0);
  const rawLeft = 68 + (position.column - 1) * characterWidth - sourceInput.scrollLeft;
  const rawTop = 18 + (position.line - 1) * lineHeight - sourceInput.scrollTop + lineHeight;
  const popupWidth = Math.min(320, sourceEditor.clientWidth - 16);
  const popupHeight = Math.min(220, sourceEditor.clientHeight - 16);
  const left = Math.max(8, Math.min(rawLeft, sourceEditor.clientWidth - popupWidth - 8));
  const top = Math.max(8, Math.min(rawTop, sourceEditor.clientHeight - popupHeight - 8));
  sourceCompletions.style.left = `${left}px`;
  sourceCompletions.style.top = `${top}px`;
  sourceCompletions.style.maxWidth = `${popupWidth}px`;
  sourceCompletions.style.maxHeight = `${popupHeight}px`;
}

function renderSourceCompletions(items) {
  if (!sourceInput || !sourceCompletions) return;
  completionItems = items;
  selectedCompletionIndex = 0;
  sourceCompletions.replaceChildren();
  if (items.length === 0) {
    hideSourceCompletions();
    return;
  }

  items.forEach((item, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.id = `source-completion-${index}`;
    option.className = 'source-completion';
    option.setAttribute('role', 'option');
    option.dataset.index = String(index);
    const label = document.createElement('span');
    label.className = 'source-completion__label';
    label.textContent = item.label;
    const detail = document.createElement('span');
    detail.className = 'source-completion__detail';
    detail.textContent = item.detail;
    option.append(label, detail);
    option.addEventListener('mousedown', (event) => event.preventDefault());
    option.addEventListener('click', () => acceptSourceCompletion(index));
    sourceCompletions.append(option);
  });

  sourceCompletions.hidden = false;
  updateSelectedCompletion();
  positionSourceCompletions();
}

function updateSelectedCompletion() {
  if (!sourceCompletions || completionItems.length === 0) return;
  sourceCompletions.querySelectorAll('.source-completion').forEach((element, index) => {
    const selected = index === selectedCompletionIndex;
    element.classList.toggle('is-selected', selected);
    element.setAttribute('aria-selected', String(selected));
  });
  sourceInput?.setAttribute('aria-activedescendant', `source-completion-${selectedCompletionIndex}`);
}

function openSourceCompletions() {
  if (!sourceInput) return;
  const offset = sourceInput.selectionStart ?? 0;
  renderSourceCompletions(getCompletions(
    sourceInput.value,
    offset,
    completionLanguageAnalysis ?? editorLanguageAnalysis
  ));
}

function maybeOpenSourceCompletions() {
  if (!sourceInput) return;
  const offset = sourceInput.selectionStart ?? 0;
  const before = sourceInput.value.slice(0, offset);
  const isIdentifierContext = /[A-Za-z_]\w*$/.test(before) || /(?:->|\.)$/.test(before);
  if (isIdentifierContext) openSourceCompletions();
  else hideSourceCompletions();
}

function acceptSourceCompletion(index = selectedCompletionIndex) {
  if (!sourceInput || !completionItems[index]) return;
  const item = completionItems[index];
  const value = sourceInput.value;
  const caret = item.replaceStart + item.label.length;
  replaceEditorValue(
    `${value.slice(0, item.replaceStart)}${item.label}${value.slice(item.replaceEnd)}`,
    caret,
    caret
  );
  hideSourceCompletions();
}

function renderEditorDiagnostics() {
  if (!sourceInput || !sourceDiagnostics || !sourceDiagnosticsList) return;
  editorDiagnostics = analyzeEditorSource(sourceInput.value);
  renderLineNumbers(editorDiagnostics);
  renderSourceSymbols();
  sourceDiagnosticsList.replaceChildren();
  sourceDiagnostics.hidden = editorDiagnostics.length === 0;
  if (sourceDiagnosticsCount) {
    sourceDiagnosticsCount.textContent = editorDiagnostics.length
      ? `${editorDiagnostics.length} ${editorDiagnostics.length === 1 ? 'hallazgo' : 'hallazgos'}`
      : '';
  }

  editorDiagnostics.forEach((diagnostic) => {
    const item = document.createElement('li');
    item.className = `source-diagnostic source-diagnostic--${diagnostic.severity}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source-diagnostic__button';
    button.title = 'Ir a la ubicación del diagnóstico';
    const location = document.createElement('span');
    location.className = 'source-diagnostic__location';
    location.textContent = `L${diagnostic.line}:C${diagnostic.column}`;
    const message = document.createElement('span');
    message.className = 'source-diagnostic__message';
    message.textContent = diagnostic.message;
    button.append(location, message);
    button.addEventListener('click', () => focusDiagnostic(diagnostic));
    item.append(button);
    sourceDiagnosticsList.append(item);
  });
}

function saveDraftSoon() {
  if (!sourceInput) return;
  if (draftSaveTimer !== null) window.clearTimeout(draftSaveTimer);
  draftSaveTimer = window.setTimeout(() => {
    try {
      window.localStorage?.setItem(sourceDraftStorageKey, sourceInput.value);
      if (draftStatus) draftStatus.textContent = 'Borrador guardado localmente.';
    } catch {
      if (draftStatus) draftStatus.textContent = 'Borrador local no disponible.';
    }
    draftSaveTimer = null;
  }, 280);
}

function handleSourceInput() {
  hideSourceHover();
  syncSourceHighlight();
  updateSourcePosition();
  renderEditorDiagnostics();
  saveDraftSoon();
  maybeOpenSourceCompletions();
}

sourceInput?.addEventListener('input', handleSourceInput);
sourceInput?.addEventListener('scroll', () => {
  hideSourceHover();
  syncSourceHighlight();
  positionSourceCompletions();
}, { passive: true });
sourceInput?.addEventListener('click', updateSourcePosition);
sourceInput?.addEventListener('keyup', updateSourcePosition);
sourceInput?.addEventListener('mousemove', updateSourceHover);
sourceInput?.addEventListener('mouseleave', () => {
  if (sourceHoverTimer !== null) window.clearTimeout(sourceHoverTimer);
  hideSourceHover();
});
sourceInput?.addEventListener('click', (event) => {
  if (!sourceInput || (!event.ctrlKey && !event.metaKey)) return;
  const offset = sourceOffsetFromPointer(event);
  const analysis = completionLanguageAnalysis ?? editorLanguageAnalysis;
  const definition = getDefinition(sourceInput.value, offset, analysis)
    ?? getDefinition(sourceInput.value, Math.max(0, offset - 1), analysis);
  if (!definition) return;
  event.preventDefault();
  hideSourceHover();
  hideSourceCompletions();
  focusSourceRange(definition);
});
sourceInput?.addEventListener('blur', () => {
  window.setTimeout(hideSourceCompletions, 120);
});

document.addEventListener('click', (event) => {
  if (!sourceCompletions?.contains(event.target as Node)
    && event.target !== sourceInput) {
    hideSourceCompletions();
  }
});

const sharedCodePrefix = 'code=';

function encodeSharedCode(source) {
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeSharedCode(payload) {
  const normalized = payload
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function loadSharedCodeFromUrl() {
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash.startsWith(sharedCodePrefix)) return null;

  try {
    return decodeSharedCode(hash.slice(sharedCodePrefix.length));
  } catch {
    if (shareStatus) shareStatus.textContent = 'El enlace compartido no contiene código válido.';
    return null;
  }
}

function loadLocalDraft() {
  try {
    return window.localStorage?.getItem(sourceDraftStorageKey) ?? null;
  } catch {
    return null;
  }
}

const sharedCode = loadSharedCodeFromUrl();
if (sharedCode !== null && sourceInput) {
  sourceInput.value = sharedCode;
  if (shareStatus) shareStatus.textContent = 'Código cargado desde un enlace compartido.';
} else {
  const localDraft = loadLocalDraft();
  if (localDraft && sourceInput) {
    sourceInput.value = localDraft;
    if (draftStatus) draftStatus.textContent = 'Borrador local cargado.';
  }
}
syncSourceHighlight();
updateSourcePosition();
renderEditorDiagnostics();

const themeStorageKey = 'memory-viewer-theme';

function applyTheme(theme, { persist = false } = {}) {
  const normalizedTheme = theme === 'light' ? 'light' : 'dark';
  const isLight = normalizedTheme === 'light';
  document.documentElement.dataset.theme = normalizedTheme;
  themeButton?.setAttribute('aria-pressed', String(isLight));
  themeButton?.setAttribute('aria-label', isLight ? 'Cambiar al tema oscuro' : 'Cambiar al tema claro');
  themeButton?.setAttribute('title', isLight ? 'Cambiar al tema oscuro' : 'Cambiar al tema claro');
  setIcon(themeIcon, isLight ? 'moon' : 'sun');
  if (persist) {
    try {
      window.localStorage?.setItem(themeStorageKey, normalizedTheme);
    } catch {
      // The theme still applies when storage is unavailable.
    }
  }
}

let savedTheme = 'dark';
try {
  savedTheme = window.localStorage?.getItem(themeStorageKey) ?? 'dark';
} catch {
  savedTheme = 'dark';
}
applyTheme(savedTheme);
setIcon(accessibilityIcon, 'accessibility');
setIcon(resetIcon, 'rotate-ccw');
setIcon(shareIcon, 'share');

function createSharedUrl() {
  const url = new URL(window.location.href);
  url.hash = `${sharedCodePrefix}${encodeSharedCode(sourceInput?.value ?? '')}`;
  return url;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }

  const temporaryInput = document.createElement('textarea');
  temporaryInput.value = value;
  temporaryInput.setAttribute('readonly', '');
  temporaryInput.style.position = 'fixed';
  temporaryInput.style.opacity = '0';
  document.body.append(temporaryInput);
  temporaryInput.select();
  const copied = document.execCommand('copy');
  temporaryInput.remove();
  return copied;
}

shareButton?.addEventListener('click', async () => {
  const source = sourceInput?.value.trim() ?? '';
  if (!source) {
    if (shareStatus) shareStatus.textContent = 'Escribe código antes de compartirlo.';
    return;
  }

  const url = createSharedUrl();
  window.history.replaceState(null, '', url);

  try {
    if (navigator.share) {
      await navigator.share({
        title: 'Solución de memoria en C/C++',
        text: 'Mira este código interpretado paso a paso.',
        url: url.toString()
      });
      if (shareStatus) shareStatus.textContent = 'Enlace compartido.';
      return;
    }

    const copied = await copyText(url.toString());
    if (shareStatus) {
      shareStatus.textContent = copied
        ? 'Enlace copiado al portapapeles.'
        : 'No se pudo copiar el enlace.';
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    if (shareStatus) shareStatus.textContent = 'No se pudo compartir el enlace.';
  }
});

const disclaimerStorageKey = 'memory-viewer-disclaimer-dismissed';
try {
  if (window.localStorage?.getItem(disclaimerStorageKey) === 'true') {
    disclaimer?.setAttribute('hidden', '');
  }
} catch {
  // The notice remains visible when storage is unavailable.
}

disclaimerDismiss?.addEventListener('click', () => {
  disclaimer?.setAttribute('hidden', '');
  try {
    window.localStorage?.setItem(disclaimerStorageKey, 'true');
  } catch {
    // Closing the notice still works for the current session.
  }
});

themeButton?.addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(nextTheme, { persist: true });
  themeButton.classList.remove('is-switching');
  void themeButton.offsetWidth;
  themeButton.classList.add('is-switching');
});

const accessibilityStorageKey = 'memory-viewer-accessibility';
let activeAccessibilityPreferences = {
  highlightChanges: true,
  pointerArrows: false,
  pointerArrowsExplicit: false,
  symbolHover: false
};

function readAccessibilityPreferences() {
  try {
    const raw = window.localStorage?.getItem(accessibilityStorageKey);
    const saved = JSON.parse(raw ?? '{}');
    return {
      highlightChanges: typeof saved.highlightChanges === 'boolean' ? saved.highlightChanges : true,
      pointerArrows: Boolean(saved.pointerArrows),
      pointerArrowsExplicit: Boolean(raw && Object.prototype.hasOwnProperty.call(saved, 'pointerArrows')),
      symbolHover: Boolean(saved.symbolHover)
    };
  } catch {
    return {
      highlightChanges: true,
      pointerArrows: false,
      pointerArrowsExplicit: false,
      symbolHover: false
    };
  }
}

function applyAccessibilityPreferences({
  highlightChanges,
  pointerArrows,
  pointerArrowsExplicit = false,
  symbolHover = false
}, { persist = false } = {}) {
  const preferences = {
    highlightChanges: Boolean(highlightChanges),
    pointerArrows: Boolean(pointerArrows),
    symbolHover: Boolean(symbolHover)
  };
  activeAccessibilityPreferences = {
    ...preferences,
    pointerArrowsExplicit
  };
  if (changeHighlightCheckbox) changeHighlightCheckbox.checked = preferences.highlightChanges;
  if (pointerArrowsCheckbox) pointerArrowsCheckbox.checked = preferences.pointerArrows;
  if (symbolHoverCheckbox) symbolHoverCheckbox.checked = preferences.symbolHover;
  setAccessibilityPreferences({ ...preferences, pointerArrowsExplicit });
  if (persist) {
    try {
      window.localStorage?.setItem(accessibilityStorageKey, JSON.stringify(preferences));
    } catch {
      // Preferences still apply for the current session.
    }
  }
}

function closeAccessibilityMenu() {
  if (!accessibilityPanel || !accessibilityToggle) return;
  accessibilityPanel.hidden = true;
  accessibilityToggle.setAttribute('aria-expanded', 'false');
}

accessibilityToggle?.addEventListener('click', () => {
  if (!accessibilityPanel) return;
  const isOpen = !accessibilityPanel.hidden;
  accessibilityPanel.hidden = isOpen;
  accessibilityToggle.setAttribute('aria-expanded', String(!isOpen));
});

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Node) || !accessibilityMenu?.contains(event.target)) closeAccessibilityMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeAccessibilityMenu();
});

const savedAccessibilityPreferences = readAccessibilityPreferences();
applyAccessibilityPreferences(savedAccessibilityPreferences);
changeHighlightCheckbox?.addEventListener('change', () => applyAccessibilityPreferences({
  highlightChanges: changeHighlightCheckbox.checked,
  pointerArrows: pointerArrowsCheckbox?.checked,
  symbolHover: symbolHoverCheckbox?.checked,
  pointerArrowsExplicit: true
}, { persist: true }));
pointerArrowsCheckbox?.addEventListener('change', () => applyAccessibilityPreferences({
  highlightChanges: changeHighlightCheckbox?.checked,
  pointerArrows: pointerArrowsCheckbox.checked,
  symbolHover: symbolHoverCheckbox?.checked,
  pointerArrowsExplicit: true
}, { persist: true }));
symbolHoverCheckbox?.addEventListener('change', () => applyAccessibilityPreferences({
  highlightChanges: changeHighlightCheckbox?.checked,
  pointerArrows: pointerArrowsCheckbox?.checked,
  symbolHover: symbolHoverCheckbox.checked,
  pointerArrowsExplicit: true
}, { persist: true }));

function describeProgram(instructions) {
  const count = instructions.length;
  return `${count} ${count === 1 ? 'paso interpretado' : 'pasos interpretados'}.`;
}

function renderProgram({ focusExecution = false, transitionOrigin = null } = {}) {
  const source = sourceInput.value;

  try {
    const program = buildMemoryProgram(source, INTERPRETER_LIMITS);
    memorySnapshots = program.instructions
      .map((instruction) => instruction.memory)
      .filter(Boolean);
    latestMemorySnapshot = memorySnapshots.at(-1) ?? null;
    const collapsedFunctionNames = [...program.functions.keys()]
      .filter((functionName) => functionName !== 'main');
    const lesson = createTraceSequence({
      id: 'parsed-program',
      instructions: program.instructions,
      sourceLines: program.sourceLines,
      description: '',
      idleStatus: '',
      collapsedFunctionNames
    });
    if (pointerArrowsCheckbox) {
      const usesSmallExampleDefault = lesson.example.dataset.pointerArrowsDefault === 'true';
      pointerArrowsCheckbox.checked = activeAccessibilityPreferences.pointerArrows
        || (!activeAccessibilityPreferences.pointerArrowsExplicit && usesSmallExampleDefault);
    }

    stopExecutionFocusTracking();
    stopExecutionFocusTracking = () => {};

    examplesRoot.replaceChildren(lesson.example);
    setTraceVisibility(true);
    const resetLesson = bindTraceSequence(lesson);
    bindMemoryHighlights(examplesRoot);
    resetCurrentProgram = () => {
      resetLesson();
    };
    parserStatus.textContent = describeProgram(program.instructions);
    let focusExitTimer = null;
    const focusTransitionDuration = 240;
    const canUseFallbackFocusTransition = () => (
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
    const clearFallbackTransitionStyles = () => {
      [
        'position',
        'left',
        'top',
        'width',
        'height',
        'minHeight',
        'zIndex',
        'margin',
        'transform',
        'transformOrigin',
        'transition',
        'visibility',
        'opacity',
        'viewTransitionName'
      ].forEach((property) => {
        lesson.example.style[property] = '';
      });
    };

    const startFallbackFocusEntry = () => {
      if (!canUseFallbackFocusTransition()) return false;

      const viewportWidth = Math.max(window.innerWidth, 1);
      const viewportHeight = Math.max(window.innerHeight, 1);
      document.body.classList.add('is-focus-transitioning');
      lesson.example.classList.add('is-focus-fallback-transition');
      Object.assign(lesson.example.style, {
        position: 'fixed',
        left: '0px',
        top: '0px',
        width: `${viewportWidth}px`,
        height: `${viewportHeight}px`,
        minHeight: `${viewportHeight}px`,
        zIndex: '40',
        margin: '0',
        visibility: 'visible',
        opacity: '0',
        transform: 'translateY(12px) scale(0.985)',
        transformOrigin: 'center center',
        transition: `opacity ${focusTransitionDuration}ms ease, transform ${focusTransitionDuration}ms var(--ease-out)`
      });

      window.requestAnimationFrame(() => {
        // The fallback focus transition changes the example from its normal
        // document geometry to a fixed viewport-sized surface. Recalculate
        // the execution marker after that geometry has been applied so it
        // remains attached to the actual first executable line.
        resetLesson.relayout?.();
        document.body.classList.add('is-execution-entering');
        lesson.example.style.opacity = '1';
        lesson.example.style.transform = 'translateY(0) scale(1)';
      });

      focusExitTimer = window.setTimeout(() => {
        lesson.example.classList.remove('is-focus-fallback-transition');
        lesson.example.style.transition = '';
        document.body.classList.add('is-execution-active');
        document.body.classList.remove('is-execution-entering', 'is-focus-transitioning');
        focusExitTimer = null;
      }, focusTransitionDuration + 30);
      return true;
    };
    const startFallbackFocusExit = () => {
      if (!canUseFallbackFocusTransition()) return false;

      if (focusExitTimer !== null) window.clearTimeout(focusExitTimer);
      focusExitTimer = null;
      document.body.classList.remove('is-execution-active');
      document.body.classList.add('is-focus-transitioning', 'is-execution-leaving');
      lesson.example.classList.add('is-focus-fallback-transition');
      Object.assign(lesson.example.style, {
        position: 'fixed',
        left: '0px',
        top: '0px',
        width: `${Math.max(window.innerWidth, 1)}px`,
        height: `${Math.max(window.innerHeight, 1)}px`,
        minHeight: `${Math.max(window.innerHeight, 1)}px`,
        zIndex: '40',
        margin: '0',
        visibility: 'visible',
        opacity: '1',
        transform: 'translateY(0) scale(1)',
        transformOrigin: 'center center',
        transition: `opacity ${focusTransitionDuration}ms ease, transform ${focusTransitionDuration}ms var(--ease-out)`
      });

      window.requestAnimationFrame(() => {
        lesson.example.style.opacity = '0';
        lesson.example.style.transform = 'translateY(10px) scale(0.985)';
      });

      focusExitTimer = window.setTimeout(() => {
        setTraceVisibility(false);
        lesson.example.classList.remove('is-focus-fallback-transition', 'is-execution-focused');
        clearFallbackTransitionStyles();
        mainElement?.classList.remove('is-execution-focused');
        document.body.classList.remove('is-execution-active', 'is-execution-leaving', 'is-focus-transitioning');
        focusExitTimer = null;
      }, focusTransitionDuration + 30);
      return true;
    };

    const setExecutionFocus = (isFocused) => {
      if (isFocused) {
        if (focusExitTimer !== null) window.clearTimeout(focusExitTimer);
        focusExitTimer = null;
        lesson.example.classList.remove('is-focus-returning');
        if (!canUseExecutionViewTransition() && !transitionOrigin) {
          lesson.example.classList.add('is-focus-entering');
        }
        lesson.example.style.height = '';
        lesson.example.classList.add('is-execution-focused');
        mainElement?.classList.add('is-execution-focused');
        resetLesson.relayout?.();
        if (!canUseExecutionViewTransition()) {
          window.requestAnimationFrame(() => lesson.example.classList.remove('is-focus-entering'));
        }
        return;
      }

      if (!lesson.example.classList.contains('is-execution-focused')) return;

      if (!canUseExecutionViewTransition() && startFallbackFocusExit()) return;

      const completeFocusExit = ({ viewTransition = false } = {}) => {
        const currentHeight = lesson.example.getBoundingClientRect().height;
        lesson.example.style.height = `${currentHeight}px`;
        lesson.example.classList.remove('is-execution-focused');
        mainElement?.classList.remove('is-execution-focused');
        resetLesson.relayout?.();

        const normalHeight = Math.max(lesson.example.scrollHeight, currentHeight);
        if (!viewTransition) lesson.example.classList.add('is-focus-returning');
        window.requestAnimationFrame(() => {
          lesson.example.style.height = `${normalHeight}px`;
        });

        focusExitTimer = window.setTimeout(() => {
          lesson.example.classList.remove('is-focus-returning', 'is-focus-entering');
          lesson.example.style.height = '';
          lesson.example.style.viewTransitionName = '';
          focusExitTimer = null;
          setTraceVisibility(false);
          if (!viewTransition) {
            editorPanel?.scrollIntoView({
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
              block: 'start'
            });
          }
        }, 620);
      };

      if (canUseExecutionViewTransition()) {
        runExecutionViewTransition(() => {
          lesson.example.style.viewTransitionName = 'none';
          interpretButton.style.viewTransitionName = executionViewTransitionName;
          editorPanel?.scrollIntoView({ behavior: 'auto', block: 'start' });
          completeFocusExit({ viewTransition: true });
        });
      } else {
        completeFocusExit();
      }
    };

    setExecutionFocus(focusExecution);
    if (!focusExecution) setTraceVisibility(false);

    lesson.focusExitButton.addEventListener('click', () => {
      setExecutionFocus(false);
    });

    if (focusExecution) {
      if (startFallbackFocusEntry()) {
        lesson.playButton.focus({ preventScroll: true });
        return;
      }
      const target = lesson.example;
      if (canUseExecutionViewTransition()) {
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
        lesson.playButton.focus({ preventScroll: true });
      } else {
        window.requestAnimationFrame(() => {
          target.scrollIntoView({
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            block: 'start'
          });
          lesson.playButton.focus({ preventScroll: true });
        });
      }
    }
  } catch (error) {
    examplesRoot.replaceChildren();
    setTraceVisibility(false);
    resetCurrentProgram = () => {};
    parserStatus.textContent = error instanceof CParserError || error instanceof CExecutionError || error instanceof Error
      ? error.message
      : 'No se pudo interpretar el código.';
  }
}

const startInterpretation = () => {
  renderProgram({
    focusExecution: true,
    transitionOrigin: interpretButton.getBoundingClientRect()
  });
};

function updateBraceDepth(line, initialDepth = 0, initialBlockComment = false) {
  let depth = initialDepth;
  let inBlockComment = initialBlockComment;
  let quote = null;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (inBlockComment) {
      if (character === '*' && nextCharacter === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '/') break;
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') depth = Math.max(0, depth - 1);
  }

  return { depth, inBlockComment };
}

function formatSourceLLVM(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let depth = 0;
  let inBlockComment = false;

  const formatted = lines.map((line) => {
    const normalized = line.replace(/\t/g, editorIndent).trim();
    if (!normalized) return '';

    const startsWithClosingBrace = normalized.startsWith('}');
    const lineDepth = Math.max(0, depth - (startsWithClosingBrace ? 1 : 0));
    const result = `${editorIndent.repeat(lineDepth)}${normalized}`;
    const nextState = updateBraceDepth(normalized, depth, inBlockComment);
    depth = nextState.depth;
    inBlockComment = nextState.inBlockComment;
    return result;
  });

  return formatted.join('\n').replace(/\n{3,}/g, '\n\n');
}

function replaceEditorValue(value, selectionStart = 0, selectionEnd = selectionStart) {
  if (!sourceInput) return;
  sourceInput.value = value;
  sourceInput.setSelectionRange(
    Math.min(selectionStart, value.length),
    Math.min(selectionEnd, value.length)
  );
  sourceInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function findRenameTarget() {
  if (!sourceInput) return null;
  const analysis = completionLanguageAnalysis ?? editorLanguageAnalysis;
  const selectionStart = sourceInput.selectionStart ?? 0;
  const selectionEnd = sourceInput.selectionEnd ?? selectionStart;
  const candidateOffsets = [
    selectionStart,
    Math.max(0, selectionEnd - 1),
    selectionEnd
  ];
  const offset = candidateOffsets.find((candidate) => getHoverInfo(
    sourceInput.value,
    candidate,
    analysis
  )) ?? selectionStart;
  const hover = getHoverInfo(sourceInput.value, offset, analysis)
    ?? getHoverInfo(sourceInput.value, Math.max(0, offset - 1), analysis);
  if (!hover) {
    if (draftStatus) draftStatus.textContent = 'F2: coloca el cursor sobre un símbolo.';
    return null;
  }
  return { analysis, offset, hover };
}

function closeSourceRename({ restoreFocus = true } = {}) {
  renameTarget = null;
  if (sourceRename) sourceRename.hidden = true;
  if (restoreFocus) sourceInput?.focus();
}

function openSourceRename() {
  const target = findRenameTarget();
  if (!target || !sourceRename || !sourceRenameInput) return;
  renameTarget = target;
  sourceRenameInput.value = target.hover.symbol.name;
  sourceRename.hidden = false;
  sourceRenameInput.focus();
  sourceRenameInput.select();
}

function applySourceRename() {
  if (!sourceInput || !renameTarget || !sourceRenameInput) return;
  const newName = sourceRenameInput.value.trim();
  const { analysis, offset } = renameTarget;

  if (!newName || newName === renameTarget.hover.symbol.name) {
    closeSourceRename();
    return;
  }
  if (!/^[A-Za-z_]\w*$/.test(newName)) {
    if (draftStatus) draftStatus.textContent = 'Nombre inválido para un símbolo C/C++.';
    return;
  }

  const edits = getRenameEdits(sourceInput.value, offset, newName, analysis);
  if (edits.length === 0) {
    closeSourceRename();
    return;
  }
  const previousValue = sourceInput.value;
  let nextValue = previousValue;
  edits.slice().reverse().forEach(({ range, newText }) => {
    nextValue = `${nextValue.slice(0, range.startOffset)}${newText}${nextValue.slice(range.endOffset)}`;
  });
  const firstEdit = edits[0].range;
  const renamedOffset = firstEdit.startOffset;
  closeSourceRename({ restoreFocus: false });
  replaceEditorValue(nextValue, renamedOffset, renamedOffset + newName.length);
  sourceInput.focus();
  if (draftStatus) {
    draftStatus.textContent = `${edits.length} ${edits.length === 1 ? 'ocurrencia renombrada' : 'ocurrencias renombradas'}.`;
  }
}

function toggleLineComments() {
  if (!sourceInput) return;
  const value = sourceInput.value;
  const selectionStart = sourceInput.selectionStart ?? 0;
  const selectionEnd = sourceInput.selectionEnd ?? selectionStart;
  const blockStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
  const blockEndIndex = value.indexOf('\n', selectionEnd);
  const blockEnd = blockEndIndex === -1 ? value.length : blockEndIndex;
  const selected = value.slice(blockStart, blockEnd);
  const lines = selected.split('\n');
  const nonEmptyLines = lines.filter((line) => line.trim());
  const shouldUncomment = nonEmptyLines.length > 0
    && nonEmptyLines.every((line) => /^\s*\/\//.test(line));
  const replacement = lines.map((line) => {
    if (!line.trim()) return line;
    if (shouldUncomment) return line.replace(/^(\s*)\/\/ ?/, '$1');
    const indentation = line.match(/^\s*/)?.[0] ?? '';
    return `${indentation}// ${line.slice(indentation.length)}`;
  }).join('\n');
  const delta = replacement.length - selected.length;
  replaceEditorValue(
    `${value.slice(0, blockStart)}${replacement}${value.slice(blockEnd)}`,
    selectionStart,
    Math.max(selectionStart, selectionEnd + delta)
  );
}

function handleEditorKeydown(event) {
  if (!sourceInput) return;
  const commandModifier = event.ctrlKey || event.metaKey;

  if (event.key === 'F2' || event.code === 'F2') {
    event.preventDefault();
    openSourceRename();
    return;
  }

  if (!sourceCompletions?.hidden && completionItems.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedCompletionIndex = (selectedCompletionIndex + 1) % completionItems.length;
      updateSelectedCompletion();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedCompletionIndex = (selectedCompletionIndex - 1 + completionItems.length) % completionItems.length;
      updateSelectedCompletion();
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      acceptSourceCompletion();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideSourceCompletions();
      return;
    }
  }

  if (commandModifier && (event.key === ' ' || event.code === 'Space')) {
    event.preventDefault();
    openSourceCompletions();
    return;
  }

  if (commandModifier && event.key === 'Enter') {
    event.preventDefault();
    startInterpretation();
    return;
  }
  if (commandModifier && event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    shareButton?.click();
    return;
  }
  if (commandModifier && event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    formatButton?.click();
    return;
  }
  if (commandModifier && event.key === '/') {
    event.preventDefault();
    toggleLineComments();
    return;
  }
  if (commandModifier) return;

  const selectionStart = sourceInput.selectionStart ?? 0;
  const selectionEnd = sourceInput.selectionEnd ?? selectionStart;
  const value = sourceInput.value;
  const nextCharacter = value[selectionEnd];
  const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };

  if ((event.key === 'Backspace' || event.key === 'Delete') && selectionStart === selectionEnd) {
    const previousCharacter = value[selectionStart - 1];
    const closingCharacter = value[selectionStart];
    const isEmptyPair = previousCharacter && pairs[previousCharacter] === closingCharacter;
    if (isEmptyPair) {
      event.preventDefault();
      const pairStart = selectionStart - 1;
      replaceEditorValue(
        `${value.slice(0, pairStart)}${value.slice(selectionStart + 1)}`,
        pairStart,
        pairStart
      );
      return;
    }
  }

  if (event.key === 'Tab') {
    event.preventDefault();
    if (selectionStart !== selectionEnd) {
      const blockStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
      const blockEndIndex = value.indexOf('\n', selectionEnd);
      const blockEnd = blockEndIndex === -1 ? value.length : blockEndIndex;
      const selected = value.slice(blockStart, blockEnd);
      const replacement = selected.split('\n').map((line) => {
        if (event.shiftKey) return line.replace(/^ {1,2}/, '');
        return `${editorIndent}${line}`;
      }).join('\n');
      const delta = replacement.length - selected.length;
      replaceEditorValue(
        `${value.slice(0, blockStart)}${replacement}${value.slice(blockEnd)}`,
        selectionStart + (event.shiftKey ? Math.min(0, delta) : editorIndent.length),
        Math.max(selectionStart, selectionEnd + delta)
      );
      return;
    }
    const replacement = event.shiftKey
      ? value.slice(0, selectionStart).replace(/ {1,2}$/, '')
      : `${value.slice(0, selectionStart)}${editorIndent}`;
    if (event.shiftKey) {
      replaceEditorValue(
        `${replacement}${value.slice(selectionEnd)}`,
        replacement.length,
        replacement.length
      );
    } else {
      replaceEditorValue(
        `${value.slice(0, selectionStart)}${editorIndent}${value.slice(selectionEnd)}`,
        selectionStart + editorIndent.length,
        selectionStart + editorIndent.length
      );
    }
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    const before = value.slice(0, selectionStart);
    const after = value.slice(selectionEnd);
    const currentLine = before.slice(before.lastIndexOf('\n') + 1);
    const indentation = currentLine.match(/^\s*/)?.[0] ?? '';
    const trimmedBefore = before.trimEnd();
    const closesBlock = after.trimStart().startsWith('}');
    const increasesIndent = trimmedBefore.endsWith('{') && !closesBlock;
    const nextIndentation = `${indentation}${increasesIndent ? editorIndent : ''}`;

    if (trimmedBefore.endsWith('{') && closesBlock) {
      const insertion = `\n${indentation}${editorIndent}\n${indentation}`;
      const caret = selectionStart + 1 + indentation.length + editorIndent.length;
      replaceEditorValue(`${before}${insertion}${after}`, caret, caret);
    } else {
      const insertion = `\n${nextIndentation}`;
      const caret = selectionStart + insertion.length;
      replaceEditorValue(`${before}${insertion}${after}`, caret, caret);
    }
    return;
  }

  if (Object.prototype.hasOwnProperty.call(pairs, event.key)) {
    event.preventDefault();
    const closing = pairs[event.key];
    if (selectionStart === selectionEnd && nextCharacter === closing) {
      sourceInput.setSelectionRange(selectionStart + 1, selectionStart + 1);
      updateSourcePosition();
      return;
    }
    const selected = value.slice(selectionStart, selectionEnd);
    const insertion = `${event.key}${selected}${closing}`;
    replaceEditorValue(
      `${value.slice(0, selectionStart)}${insertion}${value.slice(selectionEnd)}`,
      selectionStart + 1,
      selectionStart + 1 + selected.length
    );
  }
}

formatButton?.addEventListener('click', () => {
  if (!sourceInput) return;
  const selectionStart = sourceInput.selectionStart ?? 0;
  const selectionEnd = sourceInput.selectionEnd ?? selectionStart;
  const formatted = formatSourceLLVM(sourceInput.value);
  replaceEditorValue(formatted, selectionStart, selectionEnd);
  if (draftStatus) draftStatus.textContent = 'Código formateado con 2 espacios.';
});

interpretButton.addEventListener('click', startInterpretation);

sourceInput.addEventListener('keydown', handleEditorKeydown);
sourceRename?.addEventListener('submit', (event) => {
  event.preventDefault();
  applySourceRename();
});
sourceRenameCancel?.addEventListener('click', () => closeSourceRename());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && renameTarget) {
    event.preventDefault();
    closeSourceRename();
  }
});

resetButton.addEventListener('click', () => {
  resetAllStates();
});

registerResetter(() => {
  resetCurrentProgram();
});

renderProgram();
