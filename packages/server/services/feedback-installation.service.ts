import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../database/client';

const key = 'x-client-id';
export function readFeedbackInstallation(db: DatabaseSync): string | null {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE setting_key=?').get(key) as {value_json:string}|undefined;
  if (!row) return null;
  let value: unknown;
  try { value = JSON.parse(row.value_json); } catch { throw new Error('反馈安装标识损坏，请保留数据并联系维护人员'); }
  if(typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('反馈安装标识损坏，请保留数据并联系维护人员');
  return value;
}
export function getFeedbackInstallation(db: DatabaseSync = getDatabase()): string {
  const existing = readFeedbackInstallation(db);
  if(existing) return existing;
  // The primary key arbitrates concurrent processes; read the persisted winner.
  db.prepare('INSERT OR IGNORE INTO app_settings(setting_key,value_json) VALUES (?,?)').run(key,JSON.stringify(randomBytes(32).toString('base64url')));
  return readFeedbackInstallation(db)!;
}

export function preserveFeedbackInstallation(restored: DatabaseSync, current: DatabaseSync) {
  if(readFeedbackInstallation(restored)) return;
  const existing=readFeedbackInstallation(current);
  if(existing) restored.prepare('INSERT OR IGNORE INTO app_settings(setting_key,value_json) VALUES (?,?)').run(key,JSON.stringify(existing));
}
