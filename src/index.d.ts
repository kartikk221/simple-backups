/**
 * A backup managed by SimpleBackups.
 */
export interface Backup {
    /** The unique identifier of the backup. */
    id: string;

    /** The timestamp at which the backup was created (in milliseconds). */
    timestamp: number;
}

/**
 * A retention window used by SimpleBackups.
 */
export interface BackupWindow {
    /** The width of each retention slot in this window (in milliseconds). */
    interval_ms: number;

    /** The maximum number of backups to keep in this window. */
    limit: number;
}

/**
 * Adapter methods used to persist backups in an upstream storage mechanism.
 */
export interface BackupAdapters {
    /** Lists all backups from the upstream storage mechanism. */
    list(): Backup[] | Promise<Backup[]>;

    /** Creates and persists a new backup in the upstream storage mechanism. */
    create(): Backup | Promise<Backup>;

    /** Attempts to delete a backup and reports whether the deletion succeeded. */
    delete(backup: Backup): boolean | Promise<boolean>;
}

/**
 * Options used to construct a SimpleBackups instance.
 */
export interface SimpleBackupsOptions {
    /** The backup adapters to use. */
    adapters: BackupAdapters;

    /** The backup retention windows to maintain. */
    windows: BackupWindow[];
}

export type SimpleBackupsBackupEvent = 'create' | 'delete';
export type SimpleBackupsErrorEvent = 'error';
export type SimpleBackupsBackupListener = (backup: Backup) => void;
export type SimpleBackupsErrorListener = (error: Error) => void;

/**
 * Automatically creates and prunes backups using the configured adapters and retention windows.
 */
export class SimpleBackups {
    constructor(options: SimpleBackupsOptions);

    on(event: SimpleBackupsBackupEvent, listener: SimpleBackupsBackupListener): this;
    on(event: SimpleBackupsErrorEvent, listener: SimpleBackupsErrorListener): this;

    once(event: SimpleBackupsBackupEvent, listener: SimpleBackupsBackupListener): this;
    once(event: SimpleBackupsErrorEvent, listener: SimpleBackupsErrorListener): this;

    off(event: SimpleBackupsBackupEvent, listener: SimpleBackupsBackupListener): this;
    off(event: SimpleBackupsErrorEvent, listener: SimpleBackupsErrorListener): this;

    emit(event: SimpleBackupsBackupEvent, backup: Backup): boolean;
    emit(event: SimpleBackupsErrorEvent, error: Error): boolean;

    /** Destroys this instance, stops its internal interval and removes its event listeners. */
    destroy(): void;

    /** The current cached backups, returned as a new array. */
    readonly backups: Backup[];

    /** Whether this instance has been destroyed. */
    readonly destroyed: boolean;
}
