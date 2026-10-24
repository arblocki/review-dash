export type Risk = 'high' | 'medium' | 'low';

export const RISK_RANK: Record<Risk, number> = { high: 2, medium: 1, low: 0 };

export function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}
