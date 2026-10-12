import type { DatabaseSync } from 'node:sqlite';
// Unnumbered additive draft. Register at the next explicitly authorized release.
export const memberMergeSchemaSql = `
CREATE TABLE IF NOT EXISTS member_merges (
 id TEXT PRIMARY KEY,
 actor_id TEXT NOT NULL REFERENCES users(id),
 source_id TEXT NOT NULL UNIQUE REFERENCES health_members(id),
 target_id TEXT NOT NULL REFERENCES health_members(id),
 backup_id TEXT NOT NULL,
 report_count INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(source_id <> target_id)
);
`;
export function ensureMemberMergeDraft(db: DatabaseSync) { db.exec(memberMergeSchemaSql); }
