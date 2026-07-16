import {
    SimpleBackups,
    S3SimpleBackups,
    type Backup,
    type BackupAdapters,
    type BackupWindow,
    type S3SimpleBackupsCreateResult,
    type S3SimpleBackupsOptions,
    type SimpleBackupsOptions,
} from 'simple-backups';

const backup: Backup = {
    id: 'backup-id',
    timestamp: Date.now(),
};

const adapters: BackupAdapters = {
    list: () => [backup],
    create: async () => backup,
    delete: async (_backup) => true,
};

const windows: BackupWindow[] = [{ interval_ms: 1000, limit: 1 }];
const options: SimpleBackupsOptions = { adapters, windows };
const backups = new SimpleBackups(options);

backups.on('create', (_backup) => {});
backups.on('delete', (_backup) => {});
backups.on('error', (_error) => {});
backups.once('create', (_backup) => {});
backups.off('create', (_backup) => {});
backups.emit('create', backup);
backups.emit('error', new Error('Example error.'));
backups.destroy();

const backup_list: Backup[] = backups.backups;
const destroyed: boolean = backups.destroyed;

void backup_list;
void destroyed;

// @ts-expect-error Backup timestamps must be numbers
const invalid_backup: Backup = { id: 'invalid', timestamp: 'invalid' };

// @ts-expect-error SimpleBackups only supports create, delete and error events
backups.on('invalid', () => {});

// @ts-expect-error The destroyed property is read-only
backups.destroyed = false;

void invalid_backup;

const s3_source: S3SimpleBackupsCreateResult = {
    path: '/tmp/database.sql',
    options: {
        ContentType: 'application/sql',
        Metadata: { environment: 'test' },
        StorageClass: 'STANDARD_IA',
    },
};
const s3_options: S3SimpleBackupsOptions = {
    windows,
    bucket: {
        name: 'backups',
        region: 'us-east-1',
        endpoint: 'https://ewr1.vultrobjects.com',
        credentials: {
            accessKeyId: 'access-key-id',
            secretAccessKey: 'secret-access-key',
        },
    },
    adapters: {
        create: async () => s3_source,
    },
};
const s3_backups = new S3SimpleBackups(s3_options);
new S3SimpleBackups({
    windows,
    bucket: { name: 'backups', region: 'us-east-1' },
    adapters: { create: async () => ({ path: '/tmp/database.sql' }) },
});

const s3_bucket: string = s3_backups.bucket;

void s3_bucket;

new S3SimpleBackups({
    windows,
    bucket: { name: 'backups', region: 'us-east-1' },
    // @ts-expect-error The S3 creation adapter must be asynchronous
    adapters: { create: () => s3_source },
});
