import type {
    CreateMultipartUploadCommandInput,
    S3Client,
    S3ClientConfig,
} from '@aws-sdk/client-s3';

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

/** S3 SDK upload options which can be applied without overriding internally managed fields. */
export type S3SimpleBackupsUploadOptions = Omit<
    CreateMultipartUploadCommandInput,
    'Body' | 'Bucket' | 'ContentLength' | 'Key'
>;

/** The bucket name and native configuration used to construct the S3 client. */
export type S3SimpleBackupsBucket = S3ClientConfig & {
    /** The name of the S3 bucket in which backups should be stored. */
    name: string;
};

/**
 * A backup file and its optional S3 object properties.
 */
export interface S3SimpleBackupsCreateResult {
    /** The path of the backup file to upload. */
    path: string;

    /** Native S3 SDK options applied to the uploaded object. */
    options?: S3SimpleBackupsUploadOptions;
}

/**
 * The backup creation adapter used by S3SimpleBackups.
 */
export interface S3SimpleBackupsAdapters {
    /** Creates a backup file and returns its path and upload options. */
    create(): Promise<S3SimpleBackupsCreateResult>;
}

/**
 * Options used to construct an S3SimpleBackups instance.
 */
export interface S3SimpleBackupsOptions {
    /** The backup retention windows to maintain. */
    windows: BackupWindow[];

    /** The S3 bucket and client configuration to use. */
    bucket: S3SimpleBackupsBucket;

    /** The backup creation adapter to use. */
    adapters: S3SimpleBackupsAdapters;

    /** An existing S3 client to use. */
    client?: S3Client;

    /** Whether the S3 client should be destroyed with this instance. */
    destroy_client?: boolean;

    /** The multipart upload part size in bytes. */
    part_size?: number;

    /** The maximum number of parts to upload concurrently. */
    queue_size?: number;

}

/**
 * A SimpleBackups implementation which stores backups in any S3-compatible object storage bucket.
 */
export class S3SimpleBackups extends SimpleBackups {
    constructor(options: S3SimpleBackupsOptions);

    /** The configured S3 client. */
    readonly client: S3Client;

    /** The configured S3 bucket. */
    readonly bucket: string;

}
