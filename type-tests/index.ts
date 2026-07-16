import {
    SimpleBackups,
    type Backup,
    type BackupAdapters,
    type BackupWindow,
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
