import { definePlugin } from "nitro";
import { initializeDatabaseForStartup } from "../database/client";
import { startMaintenanceRunner } from "../services/maintenance-runner.service";
import { getAppConfig } from '../utils/runtime-config';
import { storageMigrationPaused } from '../utils/storage-migration-state';

export default definePlugin(() => {
  if (getAppConfig().storageError || storageMigrationPaused()) return;
  // 数据库维护模式下不启动后台任务。
  if (initializeDatabaseForStartup()) return;
  startMaintenanceRunner();
});
