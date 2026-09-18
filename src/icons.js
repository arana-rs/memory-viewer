import {
  Accessibility,
  ArrowLeft,
  ChevronsRight,
  Moon,
  Play,
  RotateCcw,
  Sun,
  TriangleAlert,
  X,
  createElement
} from 'lucide';

const iconNodes = {
  accessibility: Accessibility,
  'arrow-left': ArrowLeft,
  'chevrons-right': ChevronsRight,
  moon: Moon,
  play: Play,
  'rotate-ccw': RotateCcw,
  sun: Sun,
  'triangle-alert': TriangleAlert,
  x: X
};

export function setIcon(target, name) {
  if (!target) return null;

  const iconNode = iconNodes[name];
  if (!iconNode) throw new Error(`Icono Lucide desconocido: ${name}`);

  const icon = createElement(iconNode, {
    class: `lucide lucide-${name}`,
    'aria-hidden': 'true',
    focusable: 'false'
  });
  target.replaceChildren(icon);
  return icon;
}
