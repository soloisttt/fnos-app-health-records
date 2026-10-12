// Formal migration v19; additive and idempotent for earlier installed drafts.
export const feedbackNotificationsSchemaSql = `
CREATE TABLE IF NOT EXISTS feedback_sync_state (
  client_hash TEXT NOT NULL,
  number TEXT NOT NULL,
  status TEXT NOT NULL,
  remote_version INTEGER NOT NULL,
  PRIMARY KEY (client_hash, number)
);
CREATE TABLE IF NOT EXISTS feedback_notifications (
  id TEXT PRIMARY KEY,
  client_hash TEXT NOT NULL,
  number TEXT NOT NULL,
  remote_version INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_hash, number, remote_version)
);
CREATE TABLE IF NOT EXISTS feedback_notification_reads (
  notification_id TEXT NOT NULL REFERENCES feedback_notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('unread', 'read', 'archived')),
  read_at TEXT,
  PRIMARY KEY (notification_id, user_id)
);
`;
