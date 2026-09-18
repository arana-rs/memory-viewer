# Memoria en C++/C

Visualizador interactivo educativo para explorar stack, heap, punteros, estructuras y llamadas de funciones mediante una ejecución paso a paso de código C.

## Setup

Requisitos: Node.js 20.19+ o 22.12+ y pnpm 11.3.0. Node.js 21 no está soportado por Vite 8.

```bash
pnpm install
pnpm dev
```

Para ejecutar la suite de pruebas:

```bash
pnpm test
```

Para generar la versión de producción:

```bash
pnpm build
pnpm preview
```

## Qué hace

- Permite escribir código C y resaltarlo sintácticamente.
- Interpreta un subconjunto educativo de C.
- Muestra los cambios de variables, punteros, stack y heap.
- Permite avanzar, retroceder y ejecutar la traza automáticamente.
- Incluye controles visuales de accesibilidad y una vista de pantalla completa.

La compatibilidad con C++ todavía no está disponible. La visualización representa un modelo didáctico; no pretende sustituir a un compilador, un depurador ni una representación ABI exacta de una plataforma.

El intérprete rechaza código de más de 50.000 caracteres, limita la traza a 1.000 pasos y limita la profundidad de llamadas a 64 marcos. Estos límites protegen la interfaz frente a entradas accidentales o ejecuciones que no terminan; no representan límites del lenguaje C.

## Inspiración y atribuciones

El proyecto está inspirado en conceptos vistos en las clases de teoría del docente [A. Paz](https://github.com/alfredopaz). Es un proyecto independiente, no oficial y no afiliado a él, a Stanford, a Nick Parlante, a GitHub ni a ninguna otra organización mencionada.

Los ejemplos iniciales de listas enlazadas se basan en ideas y ejemplos de [Linked List Basics](https://fizalihsan.github.io/technology/LinkedListBasics.pdf), de Nick Parlante. El aviso del documento dice:

> Linked List Basics — By Nick Parlante.
>
> Copyright © 1998–2001, Nick Parlante.
>
> This document is free to be used, reproduced, or sold so long as this notice is clearly reproduced at its beginning.

En base a ese aviso, no se requiere autorización adicional para reutilizar el material si se conserva claramente el aviso al principio de la reproducción. El fragmento inicial de código en `index.html` conserva una atribución equivalente. El PDF no se redistribuye en este repositorio y el material derivado no está cubierto por la licencia MIT; las aportaciones originales de este proyecto sí se distribuyen bajo la licencia MIT incluida en [`LICENSE`](./LICENSE).

## Dependencias

El proyecto usa Vite, `vite-plugin-singlefile` y Lucide. Sus licencias pertenecen a sus respectivos autores y se documentan en [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

## Licencia

El código original de este repositorio se distribuye bajo la [licencia MIT](./LICENSE), salvo el material de terceros identificado en este README y en [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
