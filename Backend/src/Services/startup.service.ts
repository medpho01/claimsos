/**
 * StartupService
 *
 * Reserved for post-boot side effects that need DB access.
 *
 * Drive integration removed (May 23, 2026): previously this service
 * had a `recoverDriveBackups()` method that scanned ipd_doc for
 * drive_backup_status IN ('pending','failed') and re-queued them
 * via driveBackup.queue. The method has been removed along with the
 * Drive worker. The class is kept (with no methods) as a stable
 * import target in case other startup tasks are added here later.
 */

class StartupService {
    // Intentionally empty. Add post-boot recovery / catch-up tasks here.
}

export default new StartupService();
