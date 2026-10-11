/**
 * plan → 落地（P2 的"apply"那一层）。
 *
 * ★ 三条纪律：
 *   ① **有阻塞项就整体不动**（连能做的也不做）。半个落地比整体不动更难查 ——
 *      库里会进入"既不是声明说的样子、也不是原来的样子"的中间态，而没人知道走到了哪一步。
 *   ② **结构变更与列契约在同一个事务里**。数据与元数据要么一起新、要么一起旧
 *      （这条与 `runIngest` 把 `registerMeta()` 放进落库事务是同一条理由）。
 *   ③ **删列 / 改类型永不自动做**（`plan` 把它们标成阻塞）—— 那是丢数据的事，得由人决定。
 *
 * ★ 为什么 `registerMeta()` 也要在这里调一次（接入层已经在落库事务里调过一次）：
 *   两处调的是**同一份投影**（`metaOf(ir)`），所以谁先谁后都一样；
 *   而"结构建好了、契约还没登记"这段窗口不该存在 —— catalog 会在那段窗口里说瞎话。
 */
import { execute } from '../db/index.ts';
import { registerMeta } from '../meta/columns.ts';
import { depsOf } from './ddl.ts';
import { ddlHashOf, metaOf, type Ir } from './ir.ts';
import { planModels, type ModelChange, type ModelPlan } from './plan.ts';

export interface ApplyResult {
  applied: ModelChange[];
  blocked: ModelChange[];
  plan: ModelPlan;
  tables: number;
  irHash: string;
  note: string;
}

/** SQL 字符串字面量转义。⚠️ 本仓库另有几份同功能实现（meta/columns.ts 等），待收拢 */
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * 把声明落地。
 *
 * @param ir `loadModels(dir)` 的产物 —— **唯一输入**（本函数不读盘，于是 e2e 能拿临时目录的 IR 进来跑）
 */
export async function applyModels(ir: Ir): Promise<ApplyResult> {
  const plan = await planModels(ir);
  const base = { plan, tables: plan.tables, irHash: plan.irHash };

  if (plan.blocking.length > 0) {
    return {
      ...base,
      applied: [],
      blocked: plan.blocking,
      note:
        `有 ${plan.blocking.length} 项**不会自动做**（删列 / 改类型 / 加 NOT NULL 列 / 无主的语义表 / 存量契约漂移）：` +
        `一行都没动。先看 \`bilite plan\` 的清单，改声明或手工处理库。`,
    };
  }

  const structural = plan.changes.filter((c) => typeof c.sql === 'string');
  const metaOnly = plan.changes.filter((c) => c.kind === 'register-meta');
  if (plan.changes.length === 0) {
    return { ...base, applied: [], blocked: [], note: '声明与库结构一致，没有任何变更（幂等）。' };
  }

  await execute('BEGIN');
  try {
    for (const c of structural) await execute(c.sql!);

    // 列契约：**投影自同一份 IR**，所以 apply 与接入层两次登记必然一致
    await registerMeta(metaOf(ir));

    // 模型指纹与依赖图：plan 靠 `_model.ddl_hash` 判断"声明变了要不要重登一次契约"
    for (const t of ir.tables) {
      await execute(
        `INSERT INTO _model (name, kind, title, ddl_hash, declared_at) VALUES ` +
          `(${lit(t.name)}, ${lit(t.kind)}, ${lit(t.title)}, ${lit(ddlHashOf(t))}, now()) ` +
          `ON CONFLICT (name) DO UPDATE SET kind = EXCLUDED.kind, title = EXCLUDED.title, ` +
          `ddl_hash = EXCLUDED.ddl_hash, declared_at = EXCLUDED.declared_at`,
      );
      // 依赖按声明**整体重写**：它是纯投影，留着旧边比删掉危险（依赖图错一块，plan 的建表顺序就错）
      await execute(`DELETE FROM _model_dep WHERE name = ${lit(t.name)}`);
      for (const d of depsOf(t)) {
        await execute(
          `INSERT INTO _model_dep (name, depends_on, column_name) VALUES ` +
            `(${lit(t.name)}, ${lit(d.refs)}, ${lit(d.column)})`,
        );
      }
    }
    await execute('COMMIT');
  } catch (e) {
    try {
      await execute('ROLLBACK');
    } catch (rollbackErr) {
      // 回滚本身失败也要喊出来，但**不许盖过真正的原错**（与 runIngest 同一条）
      console.error(`[gen] ROLLBACK 失败（原错误随后抛出）: ${(rollbackErr as Error).message}`);
    }
    throw e;
  }

  return {
    ...base,
    applied: plan.changes,
    blocked: [],
    note:
      `${structural.length} 条结构变更 + ${metaOnly.length} 张表的契约刷新已落地；` +
      `再跑一次 plan 应当为空（幂等）。`,
  };
}
