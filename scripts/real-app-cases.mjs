// Fixed, public, emulator-only tasks. Selectors are recorded from installed app UI,
// not supplied to production navigation or to the model as an action script.
import { fail, validateRealAppOptions } from './real-app-support.mjs';

const assertion = (id, selector) => ({ id, selector });
const text = (value) => ({ text: value });
const antennaDialog = [
  assertion('dialog_title', { resourceId: 'de.danoeh.antennapod:id/alertTitle', text: 'Smart mark as played' }),
  assertion('selected_interval', { text: '30 seconds', checked: true }),
  assertion('cancel_button', { resourceId: 'android:id/button2', text: 'Cancel' }),
];
const markorEditor = { resourceId: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor', editable: true };
const markorSearch = { resourceId: 'net.gsantner.markor:id/searchEditText', editable: true };
const markorSearchClosed = [
  { id: 'search_closed', selector: { resourceId: 'net.gsantner.markor:id/searchEditText' }, minCount: 0, maxCount: 0 },
  assertion('note_preserved', { ...markorEditor, text: 'TapPilot 场景验证' }),
  assertion('editing_mode', { contentDescription: 'View Mode' }),
];

const modelOnlyCases = [{
  id: 'calculator-product', appName: 'Fossify Calculator', packageName: 'org.fossify.math',
  launchComponent: 'org.fossify.math/.activities.SplashActivity.Green',
  modelTask: '在当前计算器里输入 12 乘 13，读取计算器显示的结果后结束。必须实际操作计算器，不要只用心算回答，不打开其他应用。',
  visibleNavigationTargets: [{ resourceId: 'org.fossify.math:id/btn_multiply', clickable: true }],
  oracle: { stage: 'assertions', assertions: [
    assertion('product_displayed', { resourceId: 'org.fossify.math:id/result', text: '156' }),
    assertion('calculator_keypad', { resourceId: 'org.fossify.math:id/btn_equals', text: '=' }),
  ] },
}];

export const realAppCases = [{
  id: 'clock-stopwatch', appName: 'Fossify Clock', packageName: 'org.fossify.clock',
  launchComponent: 'org.fossify.clock/.activities.SplashActivity.Green',
  modelTask: '在 Clock 中打开 Stopwatch 秒表页面，读取当前计时值后结束，保持秒表页面打开。不启动计时、不创建闹钟或定时器。',
  initialAbsentGoal: true,
  initialAssertions: [
    assertion('clock_initial_tab', { resourceId: 'org.fossify.clock:id/tab_item_label', text: 'Clock', selected: true }),
    assertion('stopwatch_initial_unselected', { resourceId: 'org.fossify.clock:id/tab_item_label', text: 'Stopwatch', selected: false }),
  ],
  visibleNavigationTargets: [{ resourceId: 'org.fossify.clock:id/tab_item_label', text: 'Stopwatch', selected: false }],
  oracle: { stage: 'assertions', assertions: [
    assertion('stopwatch_tab', { resourceId: 'org.fossify.clock:id/tab_item_label', text: 'Stopwatch', selected: true }),
    assertion('idle_stopwatch', { resourceId: 'org.fossify.clock:id/stopwatch_time', text: '0.0' }),
    assertion('stopwatch_control', { resourceId: 'org.fossify.clock:id/stopwatch_play_pause' }),
  ] },
  steps: [{ id: 'open_stopwatch', action: 'tap_element',
    selector: { resourceId: 'org.fossify.clock:id/tab_item_label', text: 'Stopwatch' },
    assertions: [
      assertion('stopwatch_tab', { resourceId: 'org.fossify.clock:id/tab_item_label', text: 'Stopwatch', selected: true }),
      assertion('idle_stopwatch', { resourceId: 'org.fossify.clock:id/stopwatch_time', text: '0.0' }),
    ],
  }],
}, {
  id: 'antennapod-playback', visibleNavigationTargets: [{ contentDescription: 'More' }, { text: 'Settings' }, { resourceId: 'android:id/title', text: 'Playback' }, { text: 'Smart mark as played' }], appName: 'AntennaPod', packageName: 'de.danoeh.antennapod',
  launchComponent: 'de.danoeh.antennapod/.activity.SplashActivity',
  modelTask: '在 AntennaPod 中打开设置里的 Playback，找到 Smart mark as played 并打开选项对话框，查看当前选择和可选时间后结束。保持对话框打开，不改变任何设置，不播放或下载播客。',
  oracle: { stage: 'assertions', assertions: antennaDialog },
  steps: [
    { id: 'open_more', action: 'tap_element', selector: { contentDescription: 'More' },
      assertions: [assertion('settings_menu', text('Settings'))] },
    { id: 'open_settings', action: 'tap_element', selector: text('Settings'),
      assertions: [assertion('playback_category', { resourceId: 'android:id/title', text: 'Playback' })] },
    { id: 'open_playback', action: 'tap_element', selector: { resourceId: 'android:id/title', text: 'Playback' },
      waitFor: { resourceId: 'de.danoeh.antennapod:id/recycler_view', scrollable: true },
      assertions: [assertion('playback_list', { resourceId: 'de.danoeh.antennapod:id/recycler_view', scrollable: true }),
        assertion('skip_interval', text('Fast-forward skip time'))] },
    { id: 'scroll_playback', action: 'scroll', selector: { resourceId: 'de.danoeh.antennapod:id/recycler_view' }, direction: 'forward',
      requireNewEvidence: true, assertions: [assertion('new_preference', text('Smart mark as played'))] },
    { id: 'open_interval_dialog', action: 'tap_element', selector: text('Smart mark as played'), assertions: antennaDialog },
  ],
}, {
  id: 'wikipedia-theme', visibleNavigationTargets: [{ contentDescription: 'More' }, { text: 'Settings' }, { text: 'App theme' }], appName: 'Wikipedia', packageName: 'org.wikipedia',
  launchComponent: 'org.wikipedia/.DefaultIcon',
  modelTask: '在 Wikipedia 中打开 Settings 的 App theme 面板，查看当前字号和阅读选项，保持面板打开后结束。只读取，不改变主题、字号或任何开关，不登录、不捐款。在线百科内容当前可能不可用，这项任务只需本地设置页面。',
  oracle: { stage: 'assertions', assertions: [
    assertion('text_size', { resourceId: 'org.wikipedia:id/text_size_percent', text: '100% (Default)' }),
    assertion('reading_focus', { resourceId: 'org.wikipedia:id/theme_chooser_reading_focus_mode_switch', checked: false }),
    assertion('system_theme', { resourceId: 'org.wikipedia:id/theme_chooser_match_system_theme_switch', checked: true }),
  ] },
  steps: [
    { id: 'open_more', action: 'tap_element', selector: { contentDescription: 'More' },
      assertions: [assertion('settings_menu', text('Settings'))] },
    { id: 'open_settings', action: 'tap_element', selector: text('Settings'),
      assertions: [assertion('app_theme', text('App theme'))] },
    { id: 'open_theme_panel', action: 'tap_element', selector: text('App theme'),
      assertions: [assertion('text_size', { resourceId: 'org.wikipedia:id/text_size_percent', text: '100% (Default)' }),
        assertion('reading_focus', { resourceId: 'org.wikipedia:id/theme_chooser_reading_focus_mode_switch', checked: false }),
        assertion('system_theme', { resourceId: 'org.wikipedia:id/theme_chooser_match_system_theme_switch', checked: true })] },
  ],
}, {
  id: 'markor-quicknote', visibleNavigationTargets: [{ contentDescription: 'QuickNote' }, { ...markorEditor }], appName: 'Markor', packageName: 'net.gsantner.markor',
  launchComponent: 'net.gsantner.markor/.activity.MainActivity',
  modelTask: '这是专用测试模拟器中新安装的 Markor。打开 QuickNote，把测试便签全文设为“TapPilot 真实模型中文测试”，核对输入值并保持编辑页面后结束。只操作这份测试便签，不分享、不打开其他文件。',
  modelOracle: { stage: 'assertions', assertions: [
    assertion('input_value', { resourceId: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor', editable: true, text: 'TapPilot 真实模型中文测试' }),
    assertion('editing_mode', { contentDescription: 'View Mode' }),
  ] },
  oracle: { stage: 'assertions', assertions: [
    assertion('input_value', { resourceId: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor', editable: true, text: 'TapPilot 通用执行器测试' }),
    assertion('editing_mode', { contentDescription: 'View Mode' }),
  ] },
  steps: [
    { id: 'open_quicknote', action: 'tap_element', selector: { contentDescription: 'QuickNote' },
      waitFor: { resourceId: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor', editable: true },
      assertions: [assertion('editor', { resourceId: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor', editable: true })] },
    { id: 'establish_initial_value', action: 'input_text', selector: { resourceId: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor', editable: true },
      text: 'TapPilot 测试准备',
      assertions: [assertion('initial_value', { resourceId: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor', editable: true, text: 'TapPilot 测试准备' })] },
    { id: 'input_chinese', action: 'input_text', selector: { resourceId: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor', editable: true },
      requireNewEvidence: true,
      text: 'TapPilot 通用执行器测试',
      assertions: [assertion('input_value', { resourceId: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor', editable: true, text: 'TapPilot 通用执行器测试' })] },
    { id: 'view_note', action: 'tap_element', selector: { contentDescription: 'View Mode' },
      assertions: [assertion('viewing_mode', { contentDescription: 'Edit Mode' }), assertion('visible_note', text('TapPilot 通用执行器测试'))] },
    { id: 'edit_note', action: 'tap_element', selector: { contentDescription: 'Edit Mode' },
      assertions: [assertion('input_value', { resourceId: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor', editable: true, text: 'TapPilot 通用执行器测试' }),
        assertion('editing_mode', { contentDescription: 'View Mode' })] },
  ],
}, {
  id: 'markor-local-search', visibleNavigationTargets: [{ contentDescription: 'QuickNote' }, { contentDescription: 'Search' }, { ...markorSearch }], appName: 'Markor', packageName: 'net.gsantner.markor',
  launchComponent: 'net.gsantner.markor/.activity.MainActivity',
  modelTask: '这是专用测试模拟器中的 Markor。打开 QuickNote，把测试便签全文设为“TapPilot 场景验证”。使用便签内搜索查找“TapPilot”，核对恰好一个匹配，保持局部搜索栏和该结果打开后结束。只操作测试便签，不分享、不打开其他文件。',
  modelOracle: { stage: 'assertions', assertions: [
    assertion('note_value', { ...markorEditor, text: 'TapPilot 场景验证' }),
    assertion('query_value', { ...markorSearch, text: 'TapPilot' }),
    assertion('one_match', { resourceId: 'net.gsantner.markor:id/resultTextView', text: '1/1' }),
  ] },
  oracle: { stage: 'assertions', assertions: markorSearchClosed },
  steps: [
    { id: 'open_quicknote', action: 'tap_element', selector: { contentDescription: 'QuickNote' },
      waitFor: markorEditor, assertions: [assertion('editor', markorEditor)] },
    { id: 'establish_note', action: 'input_text', selector: markorEditor, text: 'TapPilot 场景验证',
      assertions: [assertion('note_value', { ...markorEditor, text: 'TapPilot 场景验证' })] },
    { id: 'open_local_search', action: 'tap_element', selector: { contentDescription: 'Search' },
      assertions: [assertion('local_search', markorSearch), assertion('close_search', { contentDescription: 'Close' })] },
    { id: 'search_absent_word', action: 'input_text', selector: markorSearch, text: '不存在的合成词',
      waitFor: { resourceId: 'net.gsantner.markor:id/resultTextView', text: 'No results' },
      assertions: [assertion('query_value', { ...markorSearch, text: '不存在的合成词' }),
        assertion('no_matches', { resourceId: 'net.gsantner.markor:id/resultTextView', text: 'No results' })] },
    { id: 'search_present_word', action: 'input_text', selector: markorSearch, text: 'TapPilot', requireNewEvidence: true,
      waitFor: { resourceId: 'net.gsantner.markor:id/resultTextView', text: '1/1' },
      assertions: [assertion('query_value', { ...markorSearch, text: 'TapPilot' }),
        assertion('one_match', { resourceId: 'net.gsantner.markor:id/resultTextView', text: '1/1' })] },
    { id: 'close_local_search', action: 'tap_element', selector: { resourceId: 'net.gsantner.markor:id/closeImageButton', contentDescription: 'Close' },
      requireNewEvidence: true, assertions: markorSearchClosed },
  ],
}];

export function resolveRealAppCase(caseId = 'pdd-search', { query = '机械键盘' } = {}) {
  if (caseId === 'pdd-search') {
    validateRealAppOptions({ serial: 'emulator-5580', query });
    return { id: caseId, packageName: 'com.xunmeng.pinduoduo', appName: '拼多多',
      visibleNavigationTargets: [{ text: '搜索' }],
      launchComponent: 'com.xunmeng.pinduoduo/.ui.activity.MainFrameActivity',
      modelTask: `在当前已经打开的拼多多里搜索“${query}”，看到该词的商品搜索结果列表后结束。只搜索并观察，不进入商品详情、不登录、不下单、不购买、不发送消息。`,
      oracle: { stage: 'search_results', query },
    };
  }
  const spec = [...realAppCases, ...modelOnlyCases].find(value => value.id === caseId);
  if (!spec) fail('UNKNOWN_REAL_APP_CASE');
  return structuredClone(spec);
}
