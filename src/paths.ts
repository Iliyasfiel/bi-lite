/**
 * 源文件路径白名单 —— **唯一实现**。
 *
 * 为什么单独一个模块：它有三个使用者，分属不同层 ——
 *   - `src/ingest/dryrun.ts`（接入层在执行前先确认源在允许目录内）
 *   - `src/land/raw.ts`（着陆层要读源文件）
 *   - `src/mcp/tools.ts` 的 `look_at_source`（agent 看源文件）
 *
 * 它留在 `ingest/` 里的话，`land/` 就得反向 import `ingest/`，
 * 而接入层随后要改成"从 raw 读"—— 立刻成环。所以搬到这里。
 *
 * ★ 这是**安全判据**，不是普通工具函数：一份 YAML / 一次 CLI 调用都不能变成
 *   "读任意文件"的入口。**不要在任何地方另写一份包含判断**（`AGENTS.md` 铁律 17 的同理：
 *   两份判据一定漂移，而这里的漂移形态是"某个入口能读到白名单外的文件"）。
 */
import path from 'node:path';

/** 允许作为 source 的根目录（相对仓库根）。★ 用 path.relative 判包含，不用 startsWith */
export const SOURCE_ROOTS = ['data', 'templates', 'test/fixtures'];

/**
 * 把 source 解析成绝对路径并确认它落在允许的根目录内。
 *
 * ★ 为什么不能用 `abs.startsWith(root)`：`data/uploads-evil/x.xlsx` 也以
 *   `data/uploads` 开头，前缀检查会放它过去（旧实现就是这么写的）。
 *   `path.relative` 的结果里出现 `..` 才是真正"在外面"的判据。
 *
 * @throws 路径落在白名单外
 */
export function resolveSource(source: string): string {
  const abs = path.resolve(source);
  const inside = SOURCE_ROOTS.some((r) => {
    const rel = path.relative(path.resolve(r), abs);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!inside) {
    throw new Error(
      `source 必须落在这些目录内：${SOURCE_ROOTS.join(' / ')}（收到 ${source}）。` +
        ` 接入器只读白名单目录，避免一份 YAML 变成"读任意文件"的入口。`,
    );
  }
  return abs;
}
