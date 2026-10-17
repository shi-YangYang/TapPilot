import assert from 'node:assert/strict';
import test from 'node:test';
import { improvementStatusText } from '../src/improvement-copy.ts';

const idle = { enabled: true, phase: 'idle', activeSkills: 0, queued: 0, dailyJobs: 0, dailyModelCalls: 0 };
const failed = code => ({ ...idle, phase: 'rejected', lastFailure: { stage: 'generation', code } });

test('automatic improvement shows saved causes after restart and distinguishes model failures', () => {
  assert.equal(improvementStatusText({ ...failed('MODEL_TIMEOUT'), phase: 'idle' }), '上次改进：模型请求超时');
  assert.equal(improvementStatusText(failed('MODEL_CONNECTION_FAILED')), '无法连接模型服务');
  assert.equal(improvementStatusText({ ...failed('MODEL_HTTP_ERROR'), lastFailure: { stage: 'generation', code: 'MODEL_HTTP_ERROR', httpStatus: 429 } }), '模型额度或请求频率受限');
  assert.equal(improvementStatusText(failed('SKILLS_ANDROID_REQUIRED')), '专用测试环境未准备');
  assert.equal(improvementStatusText(failed('SKILLS_ANDROID_NO_IMPROVEMENT')), '未证明有效，保留现有能力');
});

test('current execution, adoption and disabled state take precedence over a previous error', () => {
  assert.equal(improvementStatusText({ ...failed('MODEL_TIMEOUT'), phase: 'evaluating' }), '正在测试新技能');
  assert.equal(improvementStatusText({ ...failed('MODEL_TIMEOUT'), phase: 'adopted' }), '新技能已采用');
  assert.equal(improvementStatusText({ ...failed('MODEL_TIMEOUT'), enabled: false }), '已关闭');
  assert.equal(improvementStatusText({ ...idle, phase: 'paused', lastReason: 'model_unavailable' }), '等待配置模型');
});

test('unrecognized failure values never become user-facing error text', () => {
  const secret = 'private-api-key-and-chat';
  assert.equal(improvementStatusText({ ...failed(secret), lastFailure: { stage: 'generation', code: secret, message: secret } }), '本次改进未完成');
});
