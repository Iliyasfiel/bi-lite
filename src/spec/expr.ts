/**
 * 派生表达式的求值器（docs/需求与架构.md §5.2.1）
 *
 * spec 里可以写 `value.expr: "(本年累计 - 去年同期累计) / 去年同期累计"`，
 * 引用**同一数据区里其他口径列**的值，在聚合完成之后逐行计算。
 *
 * ★ 为什么必须自己写解析器，而不是 `new Function` / `eval`：
 *   expr 是 spec 文本，而 spec 会被 **agent（LLM）** 写。用 eval 就等于
 *   把"agent 只能产出 spec、不能执行代码"这条安全边界（铁律 1/2）作废 ——
 *   一段 `require('fs').rmSync(...)` 就能借求值器执行任意代码。
 *   所以这里是一个**白名单语法**的递归下降解析器：
 *   只认数字、已声明的口径名、四则运算、括号、百分号，别的字符直接报错。
 *
 * ⚠️ 这个模块曾经不存在，而 compile.ts 又认得 `value.expr` 字段 ——
 *    结果是**声明了 expr 却被静默忽略**，同比被算成两个累计额本身
 *    （实测：`[65198, 60870]`，而期望是 `(65198-60870)/60870 ≈ 0.0711`）。
 *    静默算错比不支持更糟，所以现在要么正确算，要么明确报错。
 */

export class ExprError extends Error {}

/** 求值上下文：口径名 → 数值（null 表示该格没有数据） */
export type ExprScope = Record<string, number | null>;

// ---------------- 词法 ----------------

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' | '%' | '(' | ')' };

/**
 * 标识符允许中文字符 —— 口径名就是「本年累计」「去年同期累计」这样的中文，
 * 所以不能只按 [A-Za-z_] 切分。
 */
const IDENT_START = /[A-Za-z_\u4e00-\u9fa5]/;
const IDENT_PART = /[A-Za-z0-9_\u4e00-\u9fa5]/;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }

    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new ExprError(`表达式里的数字无法解析: ${text}`);
      out.push({ kind: 'num', value });
      i = j;
      continue;
    }

    if (IDENT_START.test(c)) {
      let j = i;
      while (j < src.length && IDENT_PART.test(src[j])) j++;
      out.push({ kind: 'ident', name: src.slice(i, j) });
      i = j;
      continue;
    }

    if ('+-*/%()'.includes(c)) {
      out.push({ kind: 'op', op: c as '+' });
      i++;
      continue;
    }

    // ★ 白名单之外一律拒绝（包括 ; ` $ = 等能拼出代码注入的字符）
    throw new ExprError(
      `表达式里出现了不支持的字符「${c}」。` +
        `expr 只支持 数字、口径名、+ - * / % 与圆括号。`,
    );
  }
  return out;
}

// ---------------- 语法（递归下降）----------------
//
//   expr   := term (('+' | '-') term)*
//   term   := unary (('*' | '/' | '%') unary)*
//   unary  := ('-' | '+')? primary
//   primary:= number | ident | '(' expr ')'

interface Node { eval(scope: ExprScope): number | null }

// ⚠️ Node 原生 TS 是 strip-only 模式，不支持构造函数参数属性
//    （`constructor(private v: number)`）—— 必须显式声明字段。
class Num implements Node {
  v: number;
  constructor(v: number) { this.v = v; }
  eval() { return this.v; }
}

class Ref implements Node {
  name: string;
  constructor(name: string) { this.name = name; }
  eval(scope: ExprScope) {
    if (!(this.name in scope)) {
      throw new ExprError(
        `表达式引用了未知的口径「${this.name}」。` +
          `expr 只能引用同一 block 的 cols.order 里声明过的口径。`,
      );
    }
    const v = scope[this.name];
    return v === null || v === undefined || !Number.isFinite(v) ? null : v;
  }
}

class Bin implements Node {
  op: string;
  l: Node;
  r: Node;
  constructor(op: string, l: Node, r: Node) { this.op = op; this.l = l; this.r = r; }
  eval(scope: ExprScope): number | null {
    const a = this.l.eval(scope);
    const b = this.r.eval(scope);
    // 任一操作数缺失 → 结果缺失（而不是当成 0，否则「没有数据」会变成「等于 0」）
    if (a === null || b === null) return null;
    switch (this.op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/':
        // 除以 0 → null。返回 Infinity 会让 Excel 写出 #NUM!，不如留空
        return b === 0 ? null : a / b;
      case '%': return b === 0 ? null : a % b;
      default: throw new ExprError(`不支持的运算符: ${this.op}`);
    }
  }
}

class Neg implements Node {
  x: Node;
  constructor(x: Node) { this.x = x; }
  eval(scope: ExprScope) {
    const v = this.x.eval(scope);
    return v === null ? null : -v;
  }
}

export function parseExpr(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (op: string) => {
    const t = peek();
    if (t && t.kind === 'op' && t.op === op) { p++; return true; }
    return false;
  };

  function expr(): Node {
    let left = term();
    for (;;) {
      if (eat('+')) left = new Bin('+', left, term());
      else if (eat('-')) left = new Bin('-', left, term());
      else return left;
    }
  }

  function term(): Node {
    let left = unary();
    for (;;) {
      if (eat('*')) left = new Bin('*', left, unary());
      else if (eat('/')) left = new Bin('/', left, unary());
      else if (eat('%')) left = new Bin('%', left, unary());
      else return left;
    }
  }

  function unary(): Node {
    if (eat('-')) return new Neg(unary());
    if (eat('+')) return unary();
    return primary();
  }

  function primary(): Node {
    const t = peek();
    if (!t) throw new ExprError('表达式意外结束');
    if (t.kind === 'num') { p++; return new Num(t.value); }
    if (t.kind === 'ident') { p++; return new Ref(t.name); }
    if (t.kind === 'op' && t.op === '(') {
      p++;
      const inner = expr();
      if (!eat(')')) throw new ExprError('表达式缺少右括号');
      return inner;
    }
    throw new ExprError(`表达式里有无法解析的部分（第 ${p + 1} 个记号）`);
  }

  const root = expr();
  if (p !== toks.length) throw new ExprError('表达式在结尾之前有无法解析的内容（请检查运算符是否齐全）');
  return root;
}

/**
 * 求值。`scope` 里缺的名字会抛 ExprError（不静默当 0）——
 * 静默按 0 参与运算会得到一个"看起来正常"的错误数字。
 */
export function evalExpr(src: string, scope: ExprScope): number | null {
  return parseExpr(src).eval(scope);
}

/** 抽取表达式引用的口径名（供 lint 校验「引用的口径是否真的在 cols.order 里」） */
export function exprRefs(src: string): string[] {
  return [...new Set(tokenize(src).filter((t): t is { kind: 'ident'; name: string } => t.kind === 'ident').map((t) => t.name))];
}
