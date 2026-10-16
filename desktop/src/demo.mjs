// Synthetic device and scripted events only. Never opens a phone or model endpoint.
export async function runDemo(signal, onEvent) {
  const began = performance.now();
  const pause = milliseconds => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'));
    const stop = () => { clearTimeout(timer); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, milliseconds);
    signal.addEventListener('abort', stop, { once: true });
  });
  let calls = 0;
  try {
    for (const [turn, toolName] of ['get_ui_tree', 'open_settings', 'act_and_observe'].entries()) {
      onEvent({ type: 'model_start', turn: turn + 1 }); await pause(360);
      onEvent({ type: 'model_end', turn: turn + 1, durationMs: 360 });
      onEvent({ type: 'tool_start', turn: turn + 1, toolName }); await pause(240); calls++;
      onEvent({ type: 'tool_end', turn: turn + 1, toolName, durationMs: 240 });
    }
    const metrics = { totalMs: Math.round(performance.now() - began), modelMs: 1080, toolMs: 720, modelRequests: 3, toolCalls: calls };
    const answer = '演示完成：模拟手机已进入电池页面。\n\n当前合成界面显示：电量 82%，预计可用 12 小时，省电模式已关闭。\n\n这是演示数据，没有调用模型，也没有操作你的手机。';
    return { status: 'completed', answer, metrics };
  } catch {
    return { status: 'cancelled', answer: '演示已取消。没有操作真实手机。', metrics: { totalMs: Math.round(performance.now() - began), modelMs: 0, toolMs: 0, modelRequests: 0, toolCalls: calls } };
  }
}
