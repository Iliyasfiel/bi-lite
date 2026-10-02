/**
 * 名字规范化 —— 「这两个写法是不是同一个东西」的**唯一**判据。
 *
 * ★ 为什么单独成模块，且落在接入层：
 *   接入路径（源 Excel → 星型表）里有两处要回答"同一个吗"——
 *   ① **判重**：同一个坐标 (公司,指标,期数,口径) 出现了两次吗？
 *   ② **主数据归并**：「华东(子)公司」与「华东（子）公司」是不是一家？
 *   旧实现（src/import/）把规范化只用在 ②，① 用的是**原始名** ——
 *   于是同一个"同一家公司"在同一批里被 stage 认成两个坐标、又被 commit 并成一个 id，
 *   后写的那一行静默覆盖前一行（跨 500 行 chunk 必定发生）。
 *   判据必须只有一份，而且必须同时服务判重与归并（铁律 17）。
 *
 * ★ 安全含义：这里只去**格式噪音**（全角/空格/括号/标点/大小写），
 *   **不改变语义**。任何会改变语义的加工（去壳、缩写、同义词、简繁转换）
 *   都不许进 `normalizeName` —— 它们只能进"候选建议"（见 `stemCompany`）。
 *
 * 归一化与主数据归并同住 ingest/（resolve.ts 转出这两个函数给旧调用点用），
 * 以免在旧路径退役前出现两个实现（漂移的两份判据一定会打架）。
 */

/** 全角 → 半角（ASCII 可见区 + 全角空格） */
function toHalfWidth(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x3000) out += ' ';
    else if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0);
    else out += ch;
  }
  return out;
}

/** 格式噪音：空白、各种括号引号、中英文标点、连字符 */
const NOISE = /[\s\u00a0()[\]{}<>《》、,，.。;；:：!！?？'"“”‘’`~·\-_—/\\|]+/g;

/**
 * 规范化：只去格式噪音，**不改变语义**。
 *
 * 安全含义：两个名字规范化后相同 → 它们本来就是同一个名字的两种写法 → 可自动归并。
 * 任何"会改变语义"的加工（去壳、缩写、同义词）都**不许**放进这里，只能进候选建议。
 */
export function normalizeName(s: string): string {
  return toHalfWidth(String(s ?? '')).replace(NOISE, '').toLowerCase();
}

/**
 * 公司名的「字号」：剥掉公司形式后缀（华东子公司 → 华东）。
 *
 * ⚠️ **只用于生成候选，绝不用于自动合并** —— 去壳会改变语义：
 * 「集团」与「有限公司」是两种公司形式，剥掉后可能把两家不同的公司撞在一起。
 */
const COMPANY_SHELLS = [
  '股份有限公司', '有限责任公司', '集团有限公司', '集团公司',
  '有限公司', '子公司', '分公司', '集团', '公司', '有限', '责任', '厂', '本部',
].map(normalizeName).sort((a, b) => b.length - a.length);

export function stemCompany(s: string): string {
  const t = normalizeName(s);
  // 整个名字就是一个公司形式后缀（「公司」「有限公司」「集团有限公司」）时没有字号可言，
  // 原样返回。硬剥会把「有限公司」剥成「有限」这种残留 —— 那不是字号，
  // 只是另一个形式后缀的碎片，拿它当候选键会让纯壳名之间互相乱撞。
  if (COMPANY_SHELLS.includes(t)) return t;
  // 只从尾部剥，且不剥空
  for (const shell of COMPANY_SHELLS) {
    if (t.length > shell.length && t.endsWith(shell)) {
      return t.slice(0, -shell.length);
    }
  }
  return t;
}
