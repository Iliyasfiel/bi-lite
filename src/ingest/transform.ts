import { metricOf, type MetricDefinition } from '../metrics/definitions.ts';

export interface ValueTransform {
  metrics?: string[];
  fromUnit: string;
  toUnit: string;
  sign?: 'preserve' | 'negate';
  rounding?: 'reject' | 'half-up';
}

const UNITS: Record<string, { group: string; power: number }> = {
  元: { group: 'money', power: 0 }, 千元: { group: 'money', power: 3 },
  万元: { group: 'money', power: 4 }, 亿元: { group: 'money', power: 8 },
  比率: { group: 'ratio', power: 0 }, '%': { group: 'ratio', power: -2 },
};

function unitPower(rule: ValueTransform): number {
  if (rule.fromUnit === rule.toUnit) return 0;
  const from = Object.hasOwn(UNITS, rule.fromUnit) ? UNITS[rule.fromUnit] : undefined;
  const to = Object.hasOwn(UNITS, rule.toUnit) ? UNITS[rule.toUnit] : undefined;
  if (!from || !to || from.group !== to.group) throw new Error('源单位与目标单位不能转换');
  return from.power - to.power;
}

/** 纯结构校验，保存、试运行和落库复用。 */
export function lintTransforms(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length) return ['transforms 必须是非空规则列表'];
  const errors: string[] = [], selected = new Set<string>();
  let defaults = 0;
  value.forEach((r, i) => {
    const at = `规则 ${i + 1}`;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => !['metrics', 'fromUnit', 'toUnit', 'sign', 'rounding'].includes(k))) {
      errors.push(`${at} 包含未知字段或不是对象`); return;
    }
    if (typeof r.fromUnit !== 'string' || !r.fromUnit.trim() || typeof r.toUnit !== 'string' || !r.toUnit.trim()) errors.push(`${at} 必须同时指定 fromUnit 和 toUnit`);
    else { try { unitPower(r); } catch { errors.push(`${at} 的源单位与目标单位不能转换`); } }
    if (r.sign !== undefined && !['preserve', 'negate'].includes(r.sign)) errors.push(`${at} sign 只能是 preserve / negate`);
    if (r.rounding !== undefined && !['reject', 'half-up'].includes(r.rounding)) errors.push(`${at} rounding 只能是 reject / half-up`);
    if (r.metrics === undefined) defaults++;
    else if (!Array.isArray(r.metrics) || !r.metrics.length || r.metrics.some((m: unknown) => typeof m !== 'string' || !/^[a-z][a-z0-9_]*$/.test(m))) errors.push(`${at} metrics 必须列出稳定指标编号`);
    else for (const id of r.metrics) {
      if (selected.has(id)) errors.push(`指标 ${id} 在转换规则中重复指定`);
      selected.add(id);
    }
  });
  if (defaults > 1) errors.push('一个区块只能有一条默认转换规则');
  return errors;
}

export function transformFor(rules: ValueTransform[], metric: string, definitions: MetricDefinition[]): ValueTransform | undefined {
  const def = metricOf(metric, definitions);
  return rules.find((r) => r.metrics?.includes(def?.id ?? '')) ?? rules.find((r) => r.metrics === undefined);
}

function decimal(value: number): { coefficient: bigint; scale: number } {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const digits = mantissa.split('.');
  return { coefficient: BigInt(digits.join('')), scale: (digits[1]?.length ?? 0) - Number(exponent) };
}

function atScale(value: number, scale: number): bigint | null {
  const d = decimal(value), shift = scale - d.scale;
  if (shift >= 0) return d.coefficient * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return d.coefficient % divisor === 0n ? d.coefficient / divisor : null;
}

/** 不回显源金额；先十进制定点计算，再验证结果能无损通过现有 number 接口。 */
export function transformValue(value: number, rule: ValueTransform, targetUnit: string | undefined, columnType: string): number {
  if (targetUnit !== rule.toUnit) throw new Error('目标单位与指标/度量声明不一致');
  const type = /^decimal\((\d+),\s*(\d+)\)$/i.exec(columnType);
  if (!type) throw new Error('单位转换要求目标度量声明为 DECIMAL');
  if (!Number.isFinite(value)) throw new Error('源值不是有限数字');
  const precision = Number(type[1]), scale = Number(type[2]);
  const d = decimal(value), shift = scale - d.scale + unitPower(rule);
  let coefficient = d.coefficient;
  if (shift >= 0) coefficient *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift), remainder = coefficient % divisor;
    if (remainder !== 0n && rule.rounding !== 'half-up') throw new Error('转换后小数超出目标精度；需明确 rounding: half-up 才能舍入');
    const negative = coefficient < 0n;
    coefficient /= divisor;
    if ((remainder < 0n ? -remainder : remainder) * 2n >= divisor) coefficient += negative ? -1n : 1n;
  }
  if (rule.sign === 'negate') coefficient = -coefficient;
  const magnitude = coefficient < 0n ? -coefficient : coefficient;
  if (magnitude >= 10n ** BigInt(precision)) throw new Error('转换结果超出目标 DECIMAL 范围');
  const result = Number(coefficient) / 10 ** scale;
  if (!Number.isFinite(result) || atScale(result, scale) !== coefficient) throw new Error('转换结果无法无损通过当前数值接口');
  return result === 0 ? 0 : result;
}
