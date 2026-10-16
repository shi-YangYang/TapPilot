# Vendored beUI integration

Original upstream source from `starc007/ui-components` at `c392b2e712c3d4944bfa4b24c54c8699bbf5f4c7`. See `../../THIRD_PARTY_NOTICES.md`, `LICENSE` and `UPSTREAM.json` for provenance and the limited local changes.

## Host setup

- Resolve the `@/` alias to this directory in the renderer bundler and TypeScript configuration.
- Compile the JSX with React 19 and Tailwind CSS 4. Include this directory in Tailwind's source scan.
- Import Tailwind before `theme.css`. The latter is the exact official beUI theme layer extracted from `lib/theme-css.ts`; keep its semantic token mappings and utilities.
- Do not apply legacy global button/input/textarea styles that override the source components' geometry. Application layout belongs outside the vendored components.

## Component entry points

| Entry point (relative to `@/`) | Public exports used by TapPilot |
| --- | --- |
| `components/agents/prompt-input` | `PromptInput`, `PromptInputProps`, `PromptModel`, `PromptAction` |
| `components/agents/agent-activity` | `AgentActivity` and the exported activity item/status/props types |
| `components/motion/button` | `Button`, `ButtonLink`, `MagneticButton`, `MetallicButton`, `StatefulButton` and their props types |
| `components/motion/input` | `Input`, `InputProps`, `InputClassNames` |
| `components/motion/tabs` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` |
| `components/motion/card` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter`, `CARD_TARGET_CLASS` and their props types |
| `components/motion/select` | `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` and their props types |
| `components/motion/tooltip` | `TooltipProvider`, `Tooltip`, `TooltipTrigger`, `TooltipContent` and their props types |

## Binding notes

- `PromptInput` accepts controlled `value`/`onValueChange`, `onSubmit(value, model)`, `loading`/`onStop`, and `models`/`model`/`onModelChange`. `leadingAction` is its original slot for an additional control. Enter submits, Shift+Enter creates a newline, and composing input is not submitted. `id` and ordinary textarea attributes go to the textarea. The six optional local submit/stop label and selector props go to the existing action button. While loading, that same button becomes stop; there is no separate inactive submit button.
- `Input` uses `onChange(value: string)`, not a DOM change event. It already supplies its label, validation states, disabled state and input ID.
- `Tabs` is controlled by `value`/`onValueChange`; compose a `TabsList` containing `TabsTrigger value` controls and matching `TabsContent value` panels. Inactive panels remain mounted and hidden.
- `Select` is controlled by `value`/`onValueChange`; compose `SelectTrigger` containing `SelectValue`, then `SelectContent` with `SelectItem value` children. Plain-string item children provide the automatic selected label. The trigger has an internal generated ID, so place external test selectors on a host wrapper if needed. Controlled `open`/`onOpenChange` can coordinate stacked selects.
- `AgentActivity` takes chronological `items`, a visual phase of `working` or `complete`, and `duration` in seconds. Use explicit Chinese `activeLabel` and `summary` values. An item of `{ id, type: "step", label, status: "pending" | "active" | "complete", meta }` fits phone task steps. `complete` means the activity display has stopped; the host's summary must still distinguish task success, failure and cancellation. `collapseOnComplete` defaults to true; `maxHeight` defaults to 208 pixels. Keep real run results in the host UI.
- `Tooltip` has a shorthand: `<Tooltip content="说明"><Button>…</Button></Tooltip>`. Use `TooltipProvider` to share timing settings.

The vendored code deliberately keeps the original styling and motion. Do not rewrite these components into look-alikes during integration.
