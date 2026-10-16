# Third-party notices

## Geist Sans

- Source package: [`geist@1.7.2`](https://www.npmjs.com/package/geist/v/1.7.2), published by the Geist project.
- Upstream font path: `dist/fonts/geist-sans/Geist-Variable.woff2`.
- Local font: [`src/assets/Geist-Variable.woff2`](src/assets/Geist-Variable.woff2), copied without modification.
- Copyright: Copyright (c) 2023 Vercel, in collaboration with basement.studio.
- License: SIL Open Font License, Version 1.1. The complete copyright and license text is retained in [`src/assets/Geist-LICENSE.txt`](src/assets/Geist-LICENSE.txt).

The font and its license are bundled locally with the application. The renderer does not request a remotely hosted font. The `geist` npm package is not retained as a runtime dependency; only the original font asset and license are distributed.

## beUI

TapPilot vendors the original free, MIT-licensed beUI component source. This is a source integration, not a visual imitation. No beUI Pro components are included.

- Project: [beUI](https://beui.dev/)
- Repository: [starc007/ui-components](https://github.com/starc007/ui-components)
- Upstream revision: [`c392b2e712c3d4944bfa4b24c54c8699bbf5f4c7`](https://github.com/starc007/ui-components/tree/c392b2e712c3d4944bfa4b24c54c8699bbf5f4c7)
- Copyright: Copyright (c) 2026 Saurabh Chauhan
- License: MIT; full unmodified text is retained in [`src/beui/LICENSE`](src/beui/LICENSE) and reproduced below.
- Local root: `desktop/src/beui/`; upstream relative paths are preserved. `@/` imports resolve to this root.
- File-by-file upstream SHA-256 values and derived-file provenance are recorded in [`src/beui/UPSTREAM.json`](src/beui/UPSTREAM.json).

### Included upstream source

- `components/agents/agent-activity/activity-row.tsx`
- `components/agents/agent-activity/index.tsx`
- `components/agents/agent-activity/types.ts`
- `components/agents/agent-disclosure.tsx`
- `components/agents/loading-states/thinking-shimmer.tsx`
- `components/agents/prompt-input.tsx`
- `components/motion/button/base.tsx`
- `components/motion/button/index.tsx`
- `components/motion/button/magnetic.tsx`
- `components/motion/button/metallic.tsx`
- `components/motion/button/stateful.tsx`
- `components/motion/card.tsx`
- `components/motion/input.tsx`
- `components/motion/magnetic.tsx`
- `components/motion/popover-morph.tsx`
- `components/motion/popover-position.ts`
- `components/motion/select.tsx`
- `components/motion/tabs.tsx`
- `components/motion/text-shimmer.tsx`
- `components/motion/tooltip-surface.tsx`
- `components/motion/tooltip.tsx`
- `components/motion/tooltip/grace.ts`
- `components/motion/tooltip/positioner.tsx`
- `components/motion/tooltip/use-position.ts`
- `lib/ease.ts`
- `lib/hooks/use-dismiss.ts`
- `lib/hooks/use-hover-capable.ts`
- `lib/hooks/use-hover-gesture.ts`
- `lib/hooks/use-tap-gesture.ts`
- `lib/text-shimmer.ts`
- `lib/theme-css.ts`
- `lib/touch.ts`
- `lib/utils.ts`

The Button entry point re-exports its base, magnetic, metallic and stateful variants; their recursive local dependencies are retained unchanged so the original entry point remains valid. Unused exports can be removed from the application bundle by the bundler. No documentation site, previews, Next.js code or paid components are included.

### Local changes

1. `components/agents/prompt-input.tsx` adds optional `submitAriaLabel`, `stopAriaLabel`, `submitId`, `stopId`, `submitTestId` and `stopTestId` props. These support Chinese accessibility labels and stable integration selectors on the original submit/stop button. Defaults keep upstream labels. No classes, geometry, colors, motion or submission behavior are changed.
2. `theme.css` is an exact extraction of the `THEME_CSS` template literal from the retained, unmodified `lib/theme-css.ts`. It includes the upstream theme tokens, Tailwind mappings, animations and shared utilities.
3. `UPSTREAM.json` and this notice are local provenance records.

### External dependencies

The vendored source imports only the following packages. The version ranges below are those declared by this upstream revision; the application's installed versions are recorded in `desktop/package-lock.json`.

| Package | Upstream range | Purpose |
| --- | --- | --- |
| `react` | `^19.0.0` | Components and hooks |
| `react-dom` | `^19.0.0` | Portals |
| `motion` | `^12` | Motion components and springs (`motion/react`) |
| `lucide-react` | `^1.16.0` | Original component icons |
| `@floating-ui/dom` | `^1.8.0` | Overlay placement |
| `clsx` | `^2.1.1` | Conditional class names |
| `tailwind-merge` | `^3.6.0` | Class merging |

Tailwind CSS 4 is required to compile the original utility classes and `theme.css`. The renderer host supplies the React DOM root and application bindings; no Next.js runtime is required.

### MIT License

```text
MIT License

Copyright (c) 2026 Saurabh Chauhan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
