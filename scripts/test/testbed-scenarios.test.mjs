import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { generateCase, chooseVariantAction, effectiveVariant, summarizeVariantDiversity } from '../testbed-scenarios.mjs';

const definitions = JSON.parse(await readFile(new URL('../../android/testbed/scenarios.json', import.meta.url), 'utf8')).scenarios;
const definition = scene => definitions.find(value => value.id === scene);
const generated = (scene, seed = 17, options) => generateCase(definition(scene), seed, options);
const tree = nodes => ({ packageName: 'dev.tappilot.testbed', snapshotId: 'fixture-snapshot', revision: 7, nodes });
const button = (nodeId, text, rid) => ({ nodeId, text, rid, clickable: true, visible: true, enabled: true });
const editable = (nodeId, rid, text = '', focused = true) => ({ nodeId, rid, text, editable: true, focused, visible: true, enabled: true });

test('all eight scenes have reproducible, bounded, effective variants across default seeds', () => {
  for (const original of definitions) {
    const cases = [17, 29, 43].map(seed => generateCase(original, seed));
    for (const scenario of cases) {
      assert.deepEqual(scenario, generateCase(original, scenario.seed));
      const v = scenario.variant;
      assert.equal(v.id, scenario.variantId);
      assert.equal(v.scene, original.id);
      assert.equal(v.seed, scenario.seed);
      assert.ok(v.itemCount >= 3 && v.itemCount <= 80);
      assert.ok(v.targetIndex >= 1 && v.targetIndex <= v.itemCount);
      assert.ok(v.delayMs >= 0 && v.delayMs <= 1200);
      assert.ok(v.refreshMs >= 80 && v.refreshMs <= 1200);
      assert.ok(v.refreshCount >= 0 && v.refreshCount <= 600);
      assert.ok(Object.values(v.labels).every(value => value.length > 0 && value.length <= 80 && !/[\r\n\0]/u.test(value)));
      assert.deepEqual(scenario.expected, original.expected);
      assert.deepEqual(scenario.initial, original.initial);
    }
    const effective = cases.map(({ variant: v }) => original.id === 'canvas'
      ? [v.targetIndex / v.itemCount, v.reverse, v.layout === 'compact']
      : original.id === 'ime' ? [v.labels.input, v.labels.recipient, v.layout, v.refreshMode, v.delayMs]
        : original.id === 'webview' ? [v.labels.input, v.labels.save, v.reverse, v.layout, v.delayMs]
          : [v.labels.target, v.layout, v.targetIndex, v.itemCount, v.delayMs]);
    assert.ok(new Set(effective.map(value => JSON.stringify(value))).size > 1, `${original.id} varied only metadata`);
  }
});

test('holdout is reproducible but uses independently salted fixture parameters', () => {
  for (const original of definitions) {
    const regression = generateCase(original, 17);
    const holdout = generateCase(original, 17, { split: 'holdout' });
    assert.deepEqual(holdout, generateCase(original, 17, { split: 'holdout' }));
    assert.match(holdout.variantId, /-holdout$/);
    assert.notDeepEqual(holdout.variant.labels, regression.variant.labels);
  }
  assert.throws(() => generated('navigation', -1), /INVALID_SEED/);
  assert.throws(() => generated('navigation', 2_147_483_648), /INVALID_SEED/);
  assert.throws(() => generated('navigation', 17, { split: 'unknown' }), /INVALID_SPLIT/);
  assert.throws(() => generateCase({ id: 'native_refresh' }, 17), /UNKNOWN_FIXTURE/);
});

test('tasks use generated labels and input without changing independent business keys', () => {
  const search = generated('search', 29);
  assert.ok(search.task.includes(search.variant.labels.input));
  assert.ok(search.task.includes(`查看${search.variant.labels.target}`));
  assert.equal(search.expected.lastTarget, 'search_result');
  const ime = generated('ime', 43);
  for (const key of ['recipient', 'input', 'save']) assert.ok(ime.task.includes(ime.variant.labels[key]));
  assert.equal(ime.expected.recipient, 'synthetic_a');
  const long = generated('long_list', 29);
  assert.ok(long.task.includes(long.variant.labels.target));
  assert.equal(long.expected.lastTarget, 'item_42');
  const displayedPosition = long.variant.reverse ? long.variant.itemCount - long.variant.targetIndex + 1 : long.variant.targetIndex;
  assert.ok(displayedPosition >= 20);
  assert.equal(generated('canvas').expectedOutcome, 'unavailable');
  assert.ok(definitions.filter(value => value.id !== 'canvas').every(value => generateCase(value, 17).expectedOutcome === 'complete'));
});

test('coverage describes actual scene dimensions and default corpus includes baseline and timed disturbances', () => {
  const canvas = generated('canvas', 29);
  assert.ok(canvas.coverage.includes('canvas_position'));
  assert.ok(canvas.coverage.every(tag => !/label|input|delay|reverse/u.test(tag)));
  const ime = generated('ime', 29);
  assert.ok(ime.coverage.includes('refreshing_form_text'));
  assert.ok(!ime.coverage.includes('reversed_order'));
  const baseline = generated('async_list', 17);
  const peer = generated('async_list', 29);
  const replacement = generated('async_list', 43);
  assert.equal(baseline.variant.refreshCount, 0);
  assert.equal(peer.variant.refreshMode, 'peer_text');
  assert.ok(peer.variant.refreshCount * peer.variant.refreshMs >= 240_000);
  assert.ok(ime.variant.refreshCount * ime.variant.refreshMs >= 240_000);
  assert.ok(peer.coverage.includes('async_peer_text'));
  assert.ok(replacement.coverage.includes('async_replace'));
  assert.ok(!peer.coverage.includes('layout_parent_label')); // All async rows use clickable parents regardless of this enum.
});

test('effective diversity excludes IDs, unused parameters and visually identical canvas variants', () => {
  const navigation = generated('navigation', 29);
  const duplicate = structuredClone(navigation);
  duplicate.variantId = 'another-id'; duplicate.variant.id = 'another-id'; duplicate.variant.seed = 100;
  duplicate.variant.labels.input = '未使用的合成输入'; duplicate.variant.labels.recipient = '未使用的合成会话';
  duplicate.variant.refreshCount = 600; duplicate.variant.refreshMs = 80;
  assert.deepEqual(effectiveVariant(navigation), effectiveVariant(duplicate));
  const canvas29 = generated('canvas', 29), canvas43 = generated('canvas', 43), canvas17 = generated('canvas', 17);
  assert.deepEqual(effectiveVariant(canvas29), effectiveVariant(canvas43));
  assert.notDeepEqual(effectiveVariant(canvas29), effectiveVariant(canvas17));
  const summary = summarizeVariantDiversity([navigation, duplicate, canvas17, canvas29, canvas43]);
  assert.equal(summary.totalCases, 5);
  assert.equal(summary.uniqueEffectiveCases, 3);
  assert.equal(summary.duplicateCases, 2);
  assert.deepEqual(summary.byScene.canvas, { cases: 3, uniqueEffectiveCases: 2, duplicateCases: 1 });
});

test('parent label policy selects the observed clickable parent and deduplicates its description', () => {
  const scenario = generated('async_list', 29);
  const value = chooseVariantAction(scenario, tree([
    { nodeId: 'list', scrollable: true },
    { ...button('row', undefined, 'id/async_target'), desc: scenario.variant.labels.target, parentId: 'list' },
    { nodeId: 'text', text: scenario.variant.labels.target, parentId: 'row', clickable: false },
    button('other', scenario.variant.labels.decoy, 'id/variant_distractor'),
  ]));
  assert.deepEqual(value, { action: 'tap_element', arguments: { snapshotId: 'fixture-snapshot', nodeId: 'row' } });
});

test('ambiguous labels and disabled ancestors never become guessed clicks', () => {
  const scenario = generated('navigation');
  assert.throws(() => chooseVariantAction(scenario, tree([
    button('one', scenario.variant.labels.target, 'id/navigation_target'),
    button('two', scenario.variant.labels.target, 'id/navigation_target'),
  ])), /FIXTURE_TARGET_AMBIGUOUS/);
  const result = chooseVariantAction(scenario, tree([
    { ...button('parent', undefined, 'id/navigation_target'), enabled: false },
    { nodeId: 'label', parentId: 'parent', text: scenario.variant.labels.target },
  ]));
  assert.equal(result.tool, 'wait_for_ui_change');
  assert.throws(() => chooseVariantAction(scenario, { ...tree([]), packageName: 'other.application' }), /FIXTURE_UI_MISSING/);
});

test('search policy inputs the generated query, submits, and opens only the exact result', () => {
  const scenario = generated('search', 29);
  let result = chooseVariantAction(scenario, tree([editable('field', 'id/search_input')]));
  assert.equal(result.action, 'input_text');
  assert.equal(result.arguments.text, scenario.variant.labels.input);
  result = chooseVariantAction(scenario, tree([
    editable('field', 'id/search_input', scenario.variant.labels.input),
    button('submit', scenario.variant.labels.search, 'id/search_go'),
  ]));
  assert.equal(result.arguments.nodeId, 'submit');
  result = chooseVariantAction(scenario, tree([
    button('decoy', `查看${scenario.variant.labels.decoy} · 1`, 'id/variant_distractor'),
    button('match', `查看${scenario.variant.labels.target}`, 'id/search_result'),
  ]));
  assert.equal(result.arguments.nodeId, 'match');
});

test('long list policy scrolls observed native list and finishes only on visible completion marker', () => {
  const scenario = generated('long_list', 43);
  assert.deepEqual(chooseVariantAction(scenario, tree([{ nodeId: 'list', rid: 'id/variant_list', scrollable: true }])), {
    action: 'scroll', arguments: { snapshotId: 'fixture-snapshot', nodeId: 'list', direction: 'forward' },
  });
  assert.equal(chooseVariantAction(scenario, tree([button('correct', scenario.variant.labels.target, 'id/long_target')])).arguments.nodeId, 'correct');
  assert.equal(chooseVariantAction(scenario, tree([{ nodeId: 'finished', text: '合成任务已完成' }])), null);
});

test('IME policy checks recipient and actual focus before input and saving', () => {
  const scenario = generated('ime', 29);
  const recipient = { nodeId: 'recipient', text: scenario.variant.labels.recipient };
  let result = chooseVariantAction(scenario, tree([recipient, editable('field', 'id/ime_input', '', false), button('focus', '打开键盘', 'id/ime_focus')]));
  assert.equal(result.arguments.nodeId, 'focus');
  result = chooseVariantAction(scenario, tree([recipient, editable('field', 'id/ime_input')]));
  assert.equal(result.action, 'input_text');
  result = chooseVariantAction(scenario, tree([recipient, editable('field', 'id/ime_input', scenario.variant.labels.input), button('save', scenario.variant.labels.save, 'id/ime_save')]));
  assert.equal(result.arguments.nodeId, 'save');
  assert.throws(() => chooseVariantAction(scenario, tree([{ nodeId: 'recipient', text: scenario.variant.labels.decoy }])), /FIXTURE_RECIPIENT_CHANGED/);
});

test('overlay prioritizes the modal and webview waits for the real editable node', () => {
  const overlay = generated('overlay', 29);
  const result = chooseVariantAction(overlay, tree([
    button('target', overlay.variant.labels.target, 'id/overlay_target'),
    button('dismiss', overlay.variant.labels.dismiss, 'android:id/button1'),
  ]));
  assert.equal(result.arguments.nodeId, 'dismiss');
  const web = generated('webview', 43);
  assert.equal(chooseVariantAction(web, tree([])).tool, 'wait_for_ui_change');
  assert.deepEqual(chooseVariantAction(web, tree([])).arguments.selector, { editable: true });
  assert.equal(chooseVariantAction(web, tree([editable('web', 'synthetic')])).arguments.text, web.variant.labels.input);
  assert.equal(chooseVariantAction(web, tree([
    editable('web', 'synthetic', web.variant.labels.input), button('save', web.variant.labels.save, 'save'),
  ])).arguments.nodeId, 'save');
});

test('fixture decisions do not read oracle expectations or derive canvas coordinates', () => {
  const scenario = generated('navigation', 29);
  Object.defineProperty(scenario, 'expected', { get() { throw new Error('ORACLE_LEAK'); } });
  Object.defineProperty(scenario, 'initial', { get() { throw new Error('ORACLE_LEAK'); } });
  assert.equal(chooseVariantAction(scenario, tree([button('open', scenario.variant.labels.open, 'id/navigation_open')])).arguments.nodeId, 'open');
  assert.equal(chooseVariantAction(generated('canvas', 43), tree([])), null);
});
