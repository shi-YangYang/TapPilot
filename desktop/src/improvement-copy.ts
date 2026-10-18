import type { ImprovementStatus } from './client-types';

const phases: Record<ImprovementStatus['phase'], string> = {
  idle: '等待新的失败记录', queued: '等待空闲时改进', generating: '正在总结改进方案',
  evaluating: '正在测试新技能', adopted: '新技能已采用', rejected: '本次方案未通过，保留现有能力',
  paused: '已暂停', budget_exhausted: '本次改进已达测试上限', error: '自动改进暂不可用',
};

function failureText(failure: NonNullable<ImprovementStatus['lastFailure']>): string {
  const code = failure.code;
  if (code === 'MODEL_TIMEOUT') return '模型请求超时';
  if (code === 'MODEL_CONNECTION_FAILED') return '无法连接模型服务';
  if (code === 'MODEL_HTTP_ERROR') return failure.httpStatus === 429 ? '模型额度或请求频率受限' : '模型服务拒绝了请求';
  if (['INVALID_MODEL_CONFIG', 'INVALID_MODEL_URL', 'SKILL_INVALID_MODEL', 'SKILL_MODEL_SCOPE_MISMATCH'].includes(code)) return '请检查模型配置';
  if (['MODEL_INVALID_RESPONSE', 'MODEL_INVALID_TOOL_CALL', 'MODEL_EMPTY_RESPONSE'].includes(code)) return '模型回复无法读取';
  if (['MODEL_OUTPUT_LIMIT', 'MODEL_RESPONSE_LIMIT', 'CONTEXT_LIMIT'].includes(code)) return '模型请求或回复超出限制';
  if (['SKILLS_ANDROID_REQUIRED', 'SKILLS_ANDROID_UNAVAILABLE', 'SKILLS_ANDROID_ENVIRONMENT'].includes(code)) return '专用测试环境未准备';
  if (code === 'SKILLS_ANDROID_BUSY') return '专用测试环境正在使用';
  if (['SKILLS_ANDROID_UNSUPPORTED', 'SKILLS_ANDROID_UNREPRODUCIBLE', 'SKILLS_UNREPRODUCIBLE'].includes(code)) return '当前失败场景尚未覆盖';
  if (['SKILLS_NO_IMPROVEMENT', 'SKILLS_NOT_APPLIED', 'SKILLS_ANDROID_NO_IMPROVEMENT', 'SKILLS_ANDROID_NOT_APPLIED'].includes(code)) return '未证明有效，保留现有能力';
  if (['SKILLS_REGRESSION', 'SKILLS_ANDROID_REGRESSION'].includes(code)) return '测试发现退步，未采用';
  if (['SKILLS_BUDGET_EXHAUSTED', 'SKILLS_EVALUATION_BUDGET', 'SKILLS_ANDROID_BUDGET'].includes(code)) return '本次改进已达测试上限';
  if (code === 'SKILLS_JOB_TIMEOUT') return '本次改进超时';
  if (code === 'SKILL_INVALID_PROPOSAL') return '改进方案格式无效';
  if (code === 'SKILL_UNCHANGED_PROPOSAL') return '未产生新的改进方案';
  if (['SKILLS_CANCELLED', 'SKILLS_JOB_CANCELLED', 'SKILL_GENERATION_CANCELLED'].includes(code)) return '上次改进已取消';
  if (code === 'SKILLS_INTERRUPTED') return '上次改进已中断';
  return failure.stage === 'adoption' ? '改进方案未采用' : '本次改进未完成';
}

/** The UI renders fixed copy, never an error body, endpoint or provider message. */
export function improvementStatusText(status: ImprovementStatus): string {
  if (!status.enabled) return '已关闭';
  if (['queued', 'generating', 'evaluating', 'adopted'].includes(status.phase)) return phases[status.phase];
  if (status.phase === 'paused') return status.lastReason === 'model_unavailable' ? '等待配置模型' : '已暂停';
  if (status.lastFailure) {
    const text = failureText(status.lastFailure);
    return status.phase === 'idle' && !text.startsWith('上次') ? `上次改进：${text}` : text;
  }
  return phases[status.phase];
}
