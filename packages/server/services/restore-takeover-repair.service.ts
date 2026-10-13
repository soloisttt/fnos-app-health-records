import { createHash } from 'node:crypto';
import { createError } from 'h3';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { createId } from '../utils/identifier';
import { getAppConfig } from '../utils/runtime-config';
import { getDeploymentIdentity } from '../utils/deployment-identity';
import { activeStorageRequests } from '../utils/storage-migration-state';
import { isStorageMaintenanceActive } from './maintenance-runner.service';
import { isStorageNormalizationActive } from './indicator-normalization-task.service';
import { isUsableMemberAccount } from './member.service';
import { assertRestoreAdministrator, grantRestoredMembers } from './restore-access.service';
import { createFullBackup, inspectBackupForTakeover, isStorageExportActive } from './records.service';
import { getJobRunnerStatus } from './job-runner.service';

type RestoreEvent = { id: string; target_id: string; actor_user_id: string; rowid: number };
type RepairPlan = { actor: string; deployment: string; digest: string; fingerprint: string; eventId: string; memberIds: string[]; expires: number };
const plans = new Map<string, RepairPlan>();
const conflict = () => createError({ statusCode: 409, statusMessage: '恢复档案状态已变化或无法核实，请重新检查原始备份' });

function sourceProvider() {
  return getAppConfig().authMode === 'local' ? 'fnos_gateway' : getAppConfig().authMode === 'fnos' ? 'local' : null;
}

function latestRepairableRestore(user: RequestUser): RestoreEvent | null {
  const db = getDatabase();
  if (!sourceProvider()) return null;
  const event = db.prepare("SELECT rowid,id,target_id,actor_user_id FROM audit_logs WHERE action='backup.restore' ORDER BY rowid DESC LIMIT 1").get() as RestoreEvent | undefined;
  if (!event || event.actor_user_id !== user.id) return null;
  const identity = db.prepare("SELECT actor_user_id,detail_json FROM audit_logs WHERE action='backup.identity_restore' AND rowid<? ORDER BY rowid DESC LIMIT 1").get(event.rowid) as { actor_user_id: string; detail_json: string } | undefined;
  if (!identity || identity.actor_user_id !== user.id) return null;
  try {
    const detail = JSON.parse(identity.detail_json);
    if (detail.strategy !== 'cross' || detail.accessPolicy === 'admin_takeover') return null;
  } catch { return null; }
  if (db.prepare("SELECT 1 FROM audit_logs WHERE action='backup.takeover_repair' AND target_id=?").get(event.id)) return null;
  return event;
}

function candidates() {
  const db = getDatabase();
  const pending = db.prepare('SELECT user_id,source_json,mapped_at FROM identity_recovery_pending ORDER BY user_id').all() as Array<{ user_id: string; source_json: string; mapped_at: string | null }>;
  const sourceUsers = new Set(pending.filter(row => {
    if (row.mapped_at) return false;
    try { const source = JSON.parse(row.source_json); return source.identities?.some((i: { provider: string }) => i.provider === sourceProvider()); } catch { return false; }
  }).map(row => row.user_id));
  const result: string[] = [];
  for (const member of db.prepare('SELECT id,created_by FROM health_members ORDER BY id').all() as Array<{ id: string; created_by: string }>) {
    const grants = db.prepare('SELECT user_id,permission,can_manage_sharing FROM member_permissions WHERE member_id=? ORDER BY user_id').all(member.id) as Array<{ user_id: string; permission: string; can_manage_sharing: number }>;
    const related = new Set([member.created_by, ...grants.map(p => p.user_id)]);
    if (!grants.some(p => sourceUsers.has(p.user_id))) continue;
    if (pending.some(p => related.has(p.user_id) && p.mapped_at)) continue;
    if (grants.some(p => p.permission === 'manager' && p.can_manage_sharing === 1 && isUsableMemberAccount(p.user_id))) continue;
    result.push(member.id);
  }
  return result;
}

function fingerprint() {
  const db = getDatabase();
  return createHash('sha256').update(JSON.stringify([
    db.prepare('SELECT * FROM health_members ORDER BY id').all(),
    db.prepare('SELECT * FROM member_permissions ORDER BY member_id,user_id').all(),
    db.prepare('SELECT * FROM member_permission_versions ORDER BY member_id').all(),
    db.prepare('SELECT * FROM identity_recovery_pending ORDER BY user_id').all(),
    db.prepare('SELECT * FROM user_identities ORDER BY id').all(),
    db.prepare('SELECT * FROM local_accounts ORDER BY id').all(),
    db.prepare('SELECT id,is_gateway_admin FROM users ORDER BY id').all(),
    db.prepare("SELECT id FROM audit_logs WHERE action IN ('backup.restore','backup.takeover_repair') ORDER BY rowid").all()
  ])).digest('hex');
}

export function getRestoreTakeoverRepairStatus(user: RequestUser) {
  assertRestoreAdministrator(user);
  const event = latestRepairableRestore(user);
  return { available: Boolean(event && candidates().length) };
}

function verifySourceMembers(source: DatabaseSync, ids: string[]) {
  const db = getDatabase();
  return ids.filter(id => {
    const before = source.prepare('SELECT created_by FROM health_members WHERE id=?').get(id);
    const current = db.prepare('SELECT created_by FROM health_members WHERE id=?').get(id);
    if (!before || before.created_by !== current?.created_by) return false;
    const sourceGrants = source.prepare('SELECT user_id FROM member_permissions WHERE member_id=?').all(id) as Array<{ user_id: string }>;
    return sourceGrants.some(grant => {
      const pending = db.prepare('SELECT source_json,mapped_at FROM identity_recovery_pending WHERE user_id=?').get(grant.user_id);
      if (!pending || pending.mapped_at) return false;
      const identities = source.prepare('SELECT provider,subject FROM user_identities WHERE user_id=? ORDER BY provider,subject').all(grant.user_id);
      try {
        const original = JSON.parse(String(pending.source_json)).identities;
        return identities.some(i => i.provider === sourceProvider()) && Array.isArray(original)
          && JSON.stringify(identities) === JSON.stringify(original.map((i: { provider: string; subject: string }) => ({ provider: i.provider, subject: i.subject })).sort((a: { provider: string; subject: string }, b: { provider: string; subject: string }) => a.provider.localeCompare(b.provider) || a.subject.localeCompare(b.subject)));
      } catch { return false; }
    });
  });
}

export function preflightRestoreTakeoverRepair(user: RequestUser, archivePath: string) {
  assertRestoreAdministrator(user);
  const event = latestRepairableRestore(user);
  if (!event) throw conflict();
  return inspectBackupForTakeover(archivePath, (manifest, source, digest) => {
    if (manifest.id !== event.target_id || (manifest.identity && manifest.identity.authMode !== (sourceProvider() === 'local' ? 'local' : 'fnos'))) throw conflict();
    const memberIds = verifySourceMembers(source, candidates());
    if (!memberIds.length) throw conflict();
    for (const [key, plan] of plans) if (plan.expires < Date.now()) plans.delete(key);
    const token = createId('repair');
    plans.set(token, { actor: user.id, deployment: getDeploymentIdentity().identityDomain, digest, fingerprint: fingerprint(), eventId: event.id, memberIds, expires: Date.now() + 15 * 60000 });
    return { token, memberCount: memberIds.length, warning: `将原备份中仍未分配的 ${memberIds.length} 个成员档案授权给当前管理员。已分配档案不变；执行前会创建安全备份。` };
  });
}

export function applyRestoreTakeoverRepair(user: RequestUser, archivePath: string, token: string) {
  assertRestoreAdministrator(user);
  const plan = plans.get(token);
  if (!plan || plan.actor !== user.id || plan.expires < Date.now() || plan.deployment !== getDeploymentIdentity().identityDomain
    || plan.eventId !== latestRepairableRestore(user)?.id || plan.fingerprint !== fingerprint()) throw conflict();
  if (getJobRunnerStatus().busy || isStorageMaintenanceActive() || isStorageNormalizationActive() || isStorageExportActive() || activeStorageRequests() > 1) {
    throw createError({ statusCode: 409, statusMessage: '仍有请求或后台任务正在执行，请稍后重试' });
  }
  return inspectBackupForTakeover(archivePath, (_manifest, _source, digest) => {
    if (digest !== plan.digest) throw conflict();
    const safetyBackup = createFullBackup(user, 'pre_restore');
    const db = getDatabase();
    runInTransaction(db, () => {
      if (fingerprint() !== plan.fingerprint) throw conflict();
      grantRestoredMembers(db, user.id, plan.memberIds);
      db.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,'backup.takeover_repair','backup',?,?)")
        .run(createId('audit'), user.id, plan.eventId, JSON.stringify({ memberCount: plan.memberIds.length, safetyBackupId: safetyBackup.id }));
    });
    plans.delete(token);
    return { repaired: true, memberCount: plan.memberIds.length, safetyBackupId: safetyBackup.id };
  });
}
