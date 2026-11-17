import type { Db } from "./db.js";

let depth = 0;

/**
 * 一个动作一个事务（不变量 7 的落点）：用 SAVEPOINT 实现，可安全嵌套。
 * 调用链全部同步，事务内不 await。
 */
export function withTx<T>(db: Db, fn: () => T): T {
  if (depth > 32) throw new Error("transaction nesting too deep");
  const name = `ck_sp_${depth++}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  } finally {
    depth--;
  }
}
