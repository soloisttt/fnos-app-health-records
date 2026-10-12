import { definePlugin } from 'nitro';
import { getDatabase, getUnreleasedSchemaMaintenance } from '../database/client';
import { getFeedbackInstallation } from '../services/feedback-installation.service';
import { syncFeedbackUpdates } from '../services/feedback-sync.service';
import { getAppConfig } from '../utils/runtime-config';
import { storageMigrationPaused } from '../utils/storage-migration-state';

export default definePlugin(() => {
  try {
    if (getAppConfig().storageError || storageMigrationPaused()) return;
    const db = getDatabase();
    if (getUnreleasedSchemaMaintenance()) return;
    getFeedbackInstallation(db);
    // Startup feedback is optional: consume failures without UI errors or logs.
    void syncFeedbackUpdates(db).catch(() => {});
  } catch {
    // Initialization failures are silent too; core application startup owns its diagnostics.
  }
});
