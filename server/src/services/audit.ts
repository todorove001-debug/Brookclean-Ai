import type { Db } from "../db/pool.js";

// журнал действий: кто, что и когда изменил — для разбора спорных случаев
export async function audit(db: Db, userId: string | null, action: string, entity: string, entityId: string | number | null, data?: unknown) {
  await db.query("insert into audit_log(user_id, action, entity, entity_id, data) values ($1,$2,$3,$4,$5)",
    [userId, action, entity, entityId == null ? null : String(entityId), data == null ? null : JSON.stringify(data)]);
}
