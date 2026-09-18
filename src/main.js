import './styles.css';
import {
  bindMemoryHighlights,
  bindTraceSequence,
  createTraceSequence,
  setAccessibilityPreferences
} from './memory-render.js';
import { buildMemoryProgram, CParserError, CExecutionError } from './c-interpreter.js';
import { INTERPRETER_LIMITS } from './interpreter-limits.js';
import { registerResetter, resetAllStates } from './reset-state.js';
import { setIcon } from './icons.js';

const resetButton = document.getElementById('reset-page');
const resetIcon = resetButton?.querySelector('.reset-icon');
const themeButton = document.getElementById('theme-toggle');
const themeIcon = themeButton?.querySelector('.theme-icon');
const warningIcon = document.querySelector('.warning-icon');
const accessibilityMenu = document.querySelector('.accessibility-menu');
const accessibilityToggle = document.getElementById('accessibility-toggle');
const accessibilityIcon = accessibilityToggle?.querySelector('.accessibility-icon');
const accessibilityPanel = document.getElementById('accessibility-panel');
const changeHighlightCheckbox = document.getElementById('accessibility-change-highlight');
const pointerArrowsCheckbox = document.getElementById('accessibility-pointer-arrows');
const examplesRoot = document.getElementById('memory-examples');
const sourceInput = document.getElementById('source-input');
const sourceHighlight = document.getElementById('source-highlight');
const sourceHighlightCode = sourceHighlight?.querySelector('code');
const interpretButton = document.getElementById('interpret-code');
const parserStatus = document.getElementById('parser-status');
const editorPanel = document.querySelector('.editor-panel');
const mainElement = document.querySelector('main');

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
}

sourceInput?.addEventListener('input', syncSourceHighlight);
sourceInput?.addEventListener('scroll', syncSourceHighlight, { passive: true });
syncSourceHighlight();

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
setIcon(warningIcon, 'triangle-alert');

themeButton?.addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(nextTheme, { persist: true });
  themeButton.classList.remove('is-switching');
  void themeButton.offsetWidth;
  themeButton.classList.add('is-switching');
});

const accessibilityStorageKey = 'memory-viewer-accessibility';

function readAccessibilityPreferences() {
  try {
    const saved = JSON.parse(window.localStorage?.getItem(accessibilityStorageKey) ?? '{}');
    return {
      highlightChanges: Boolean(saved.highlightChanges),
      pointerArrows: Boolean(saved.pointerArrows)
    };
  } catch {
    return { highlightChanges: false, pointerArrows: false };
  }
}

function applyAccessibilityPreferences({ highlightChanges, pointerArrows }, { persist = false } = {}) {
  const preferences = { highlightChanges: Boolean(highlightChanges), pointerArrows: Boolean(pointerArrows) };
  if (changeHighlightCheckbox) changeHighlightCheckbox.checked = preferences.highlightChanges;
  if (pointerArrowsCheckbox) pointerArrowsCheckbox.checked = preferences.pointerArrows;
  setAccessibilityPreferences(preferences);
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
  if (!accessibilityMenu?.contains(event.target)) closeAccessibilityMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeAccessibilityMenu();
});

const savedAccessibilityPreferences = readAccessibilityPreferences();
applyAccessibilityPreferences(savedAccessibilityPreferences);
changeHighlightCheckbox?.addEventListener('change', () => applyAccessibilityPreferences({
  highlightChanges: changeHighlightCheckbox.checked,
  pointerArrows: pointerArrowsCheckbox?.checked
}, { persist: true }));
pointerArrowsCheckbox?.addEventListener('change', () => applyAccessibilityPreferences({
  highlightChanges: changeHighlightCheckbox?.checked,
  pointerArrows: pointerArrowsCheckbox.checked
}, { persist: true }));

function describeProgram(instructions) {
  const count = instructions.length;
  return `${count} ${count === 1 ? 'paso interpretado' : 'pasos interpretados'}.`;
}

function renderProgram({ focusExecution = false, transitionOrigin = null } = {}) {
  const source = sourceInput.value;

  try {
    const program = buildMemoryProgram(source, INTERPRETER_LIMITS);
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
      if (startFallbackFocusEntry(transitionOrigin)) {
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

interpretButton.addEventListener('click', startInterpretation);

sourceInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    startInterpretation();
  }
});

resetButton.addEventListener('click', () => {
  resetAllStates();
});

registerResetter(() => {
  resetCurrentProgram();
});

renderProgram();
