import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    UploadPartCommand,
} from '@aws-sdk/client-s3';

import { S3SimpleBackups } from 'simple-backups';

const hour = 1000 * 60 * 60;
const minimum_part_size = 1024 * 1024 * 5;
const original_date_now = Date.now;
const active_backups = new Set();

/**
 * Creates a temporary backup file for an adapter to return.
 * @param {string|Buffer} [contents]
 * @param {string} [filename]
 * @returns {Promise<string>}
 */
async function create_backup_file(contents = 'backup', filename = 'backup.sql') {
    const path = join(tmpdir(), `${randomUUID()}_${filename}`);
    await writeFile(path, contents);
    return path;
}

/**
 * Reads a stream body as a Buffer to emulate an S3 client consuming it before resolving.
 * @param {AsyncIterable<Buffer>} body
 * @returns {Promise<Buffer>}
 */
async function read_body(body) {
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks);
}

class MockS3Client {
    commands = [];
    destroyed = false;

    /**
     * @param {function(Object):Object|Promise<Object>} handler
     */
    constructor(handler) {
        this.handler = handler;
    }

    async send(command) {
        this.commands.push(command);
        return await this.handler(command);
    }

    destroy() {
        this.destroyed = true;
    }
}

/**
 * Constructs and tracks an S3SimpleBackups instance so its timers are always destroyed after a test.
 * @param {ConstructorParameters<typeof S3SimpleBackups>[0]} options
 * @returns {S3SimpleBackups}
 */
function create_s3_simple_backups(options) {
    const backups = new S3SimpleBackups(options);
    active_backups.add(backups);
    return backups;
}

afterEach(() => {
    Date.now = original_date_now;
    for (const backups of active_backups) backups.destroy();
    active_backups.clear();
});

test('validates S3 constructor options', () => {
    const client = new MockS3Client(() => ({}));
    const adapters = { create: async () => ({ path: '/tmp/backup.sql' }) };
    const windows = [{ interval_ms: hour, limit: 1 }];

    assert.throws(() => new S3SimpleBackups({ windows, adapters }), /configuration object/);
    assert.throws(
        () => new S3SimpleBackups({ windows, bucket: { name: 'backups' }, adapters: {} }),
        /adapters create method/,
    );
    assert.throws(
        () => new S3SimpleBackups({ windows, bucket: { name: 'backups' }, adapters, client: {} }),
        /S3Client-compatible object/,
    );
    assert.throws(
        () =>
            new S3SimpleBackups({
                windows,
                bucket: { name: '' },
                adapters,
            }),
        /bucket name/,
    );
    assert.throws(
        () =>
            new S3SimpleBackups({
                windows,
                bucket: { name: 'backups' },
                adapters,
                client,
                part_size: minimum_part_size - 1,
            }),
        /part_size/,
    );
    assert.throws(
        () =>
            new S3SimpleBackups({
                windows,
                bucket: { name: 'backups' },
                adapters,
                client,
                queue_size: 0,
            }),
        /queue_size/,
    );
});

test('destroys injected S3 clients only when explicitly configured', () => {
    const client = new MockS3Client(() => ({}));
    const backups = create_s3_simple_backups({
        windows: [{ interval_ms: hour, limit: 1 }],
        bucket: { name: 'backups' },
        client,
        destroy_client: true,
        adapters: {
            create: async () => ({ path: '/tmp/backup.sql' }),
        },
    });

    backups.destroy();

    assert.equal(client.destroyed, true);
});

test('requires creation adapters to return an object containing a path', async () => {
    const emitted_errors = [];
    const client = new MockS3Client((command) => {
        if (command instanceof ListObjectsV2Command) return { Contents: [] };
        throw new Error('Unexpected S3 command.');
    });
    const backups = create_s3_simple_backups({
        windows: [{ interval_ms: hour, limit: 1 }],
        bucket: { name: 'backups' },
        client,
        adapters: {
            create: async () => '/tmp/backup.sql',
        },
    });
    backups.on('error', (error) => emitted_errors.push(error));

    await backups.__tick();

    assert.equal(emitted_errors.length, 1);
    assert.match(emitted_errors[0].message, /must return an object/);
    assert.equal(backups.backups.length, 0);
});

test('lists every timestamped object in the bucket across pages', async () => {
    const now = hour * 100;
    const current_key = 'current.sql';
    const older_key = 'older.sql';
    let create_calls = 0;
    Date.now = () => now;

    const client = new MockS3Client((command) => {
        if (!(command instanceof ListObjectsV2Command)) throw new Error('Unexpected S3 command.');
        if (!command.input.ContinuationToken) {
            return {
                Contents: [
                    { Key: current_key, LastModified: new Date(now) },
                ],
                IsTruncated: true,
                NextContinuationToken: 'next-page',
            };
        }
        return {
            Contents: [
                { Key: older_key, LastModified: new Date(now - hour) },
                { Key: 'missing-date.sql' },
            ],
            IsTruncated: false,
        };
    });
    const backups = create_s3_simple_backups({
        windows: [{ interval_ms: hour, limit: 2 }],
        bucket: { name: 'backups' },
        client,
        adapters: {
            create: async () => {
                create_calls++;
                return { path: await create_backup_file() };
            },
        },
    });

    await backups.__tick();

    assert.equal(backups.bucket, 'backups');
    assert.equal(backups.client, client);
    assert.equal(create_calls, 0);
    assert.deepEqual(backups.backups, [
        { id: older_key, timestamp: now - hour },
        { id: current_key, timestamp: now },
    ]);
    assert.equal(client.commands.length, 2);
});

test('streams small backup files with PutObject and removes them after upload', async () => {
    const now = hour * 100;
    const created_backups = [];
    let path;
    let uploaded_body;
    Date.now = () => now;

    const client = new MockS3Client(async (command) => {
        if (command instanceof ListObjectsV2Command) return { Contents: [] };
        if (command instanceof PutObjectCommand) {
            uploaded_body = await read_body(command.input.Body);
            return { ETag: 'small-backup' };
        }
        throw new Error('Unexpected S3 command.');
    });
    const backups = create_s3_simple_backups({
        windows: [{ interval_ms: hour, limit: 1 }],
        bucket: { name: 'backups' },
        client,
        adapters: {
            create: async () => {
                path = await create_backup_file('small backup', 'generated.sql');
                return {
                    path,
                    options: {
                        ContentType: 'application/sql',
                        Metadata: { environment: 'production' },
                        StorageClass: 'STANDARD_IA',
                    },
                };
            },
        },
    });
    backups.on('create', (backup) => created_backups.push(backup));

    await backups.__tick();

    const put_command = client.commands.find((command) => command instanceof PutObjectCommand);
    assert.ok(put_command);
    assert.equal(put_command.input.Key, basename(path));
    assert.equal(uploaded_body.toString(), 'small backup');
    assert.equal(put_command.input.ContentLength, 12);
    assert.equal(put_command.input.ContentType, 'application/sql');
    assert.equal(put_command.input.StorageClass, 'STANDARD_IA');
    assert.deepEqual(put_command.input.Metadata, {
        environment: 'production',
    });
    await assert.rejects(access(path));
    assert.equal(created_backups.length, 1);
    assert.equal(created_backups[0].id, put_command.input.Key);
});

test('derives the filename and content length from the returned backup path', async () => {
    const now = hour * 100;
    let path;
    Date.now = () => now;

    const client = new MockS3Client(async (command) => {
        if (command instanceof ListObjectsV2Command) return { Contents: [] };
        if (command instanceof PutObjectCommand) {
            await read_body(command.input.Body);
            return {};
        }
        throw new Error('Unexpected S3 command.');
    });
    const backups = create_s3_simple_backups({
        windows: [{ interval_ms: hour, limit: 1 }],
        bucket: { name: 'backups' },
        client,
        adapters: {
            create: async () => {
                path = await create_backup_file('known-length backup', 'database.sql');
                return { path };
            },
        },
    });

    await backups.__tick();

    const put_command = client.commands.find((command) => command instanceof PutObjectCommand);
    assert.equal(put_command.input.ContentLength, 19);
    assert.equal(put_command.input.Key, basename(path));
    await assert.rejects(access(path));
});

test('rejects duplicate filenames instead of overwriting existing S3 objects', async () => {
    const now = hour * 100;
    const emitted_errors = [];
    const path = await create_backup_file('replacement backup', 'duplicate.sql');
    const key = basename(path);
    Date.now = () => now;

    const client = new MockS3Client((command) => {
        if (command instanceof ListObjectsV2Command)
            return {
                Contents: [{ Key: key, LastModified: new Date(now - hour) }],
            };
        throw new Error('Unexpected S3 command.');
    });
    const backups = create_s3_simple_backups({
        windows: [{ interval_ms: hour, limit: 1 }],
        bucket: { name: 'backups' },
        client,
        adapters: {
            create: async () => ({ path }),
        },
    });
    backups.on('error', (error) => emitted_errors.push(error));

    await backups.__tick();

    assert.equal(emitted_errors.length, 1);
    assert.match(emitted_errors[0].message, /already exists/);
    assert.equal(client.commands.length, 1);
    await assert.rejects(access(path));
});

test('uploads large streams using bounded multipart concurrency', async () => {
    const now = hour * 100;
    let active_uploads = 0;
    let maximum_active_uploads = 0;
    Date.now = () => now;

    const client = new MockS3Client((command) => {
        if (command instanceof ListObjectsV2Command) return { Contents: [] };
        if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-id' };
        if (command instanceof UploadPartCommand) {
            active_uploads++;
            maximum_active_uploads = Math.max(maximum_active_uploads, active_uploads);
            return new Promise((resolve) => {
                setImmediate(() => {
                    active_uploads--;
                    resolve({ ETag: `part-${command.input.PartNumber}` });
                });
            });
        }
        if (command instanceof CompleteMultipartUploadCommand) return {};
        throw new Error('Unexpected S3 command.');
    });
    const backups = create_s3_simple_backups({
        windows: [{ interval_ms: hour, limit: 1 }],
        bucket: { name: 'backups' },
        client,
        part_size: minimum_part_size,
        queue_size: 1,
        adapters: {
            create: async () => ({
                path: await create_backup_file(
                    Buffer.alloc(minimum_part_size + 10, 1),
                    'large.backup',
                ),
            }),
        },
    });

    await backups.__tick();

    const upload_commands = client.commands.filter((command) => command instanceof UploadPartCommand);
    const complete_command = client.commands.find(
        (command) => command instanceof CompleteMultipartUploadCommand,
    );
    assert.equal(maximum_active_uploads, 1);
    assert.equal(upload_commands.length, 2);
    assert.equal(upload_commands[0].input.Body.length, minimum_part_size);
    assert.equal(upload_commands[1].input.Body.length, 10);
    assert.deepEqual(complete_command.input.MultipartUpload.Parts, [
        { ETag: 'part-1', PartNumber: 1 },
        { ETag: 'part-2', PartNumber: 2 },
    ]);
});

test('aborts failed multipart uploads and removes the created backup file', async () => {
    const now = hour * 100;
    const upload_error = new Error('Upload failed.');
    const emitted_errors = [];
    let path;
    Date.now = () => now;

    const client = new MockS3Client((command) => {
        if (command instanceof ListObjectsV2Command) return { Contents: [] };
        if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-id' };
        if (command instanceof UploadPartCommand) throw upload_error;
        if (command instanceof AbortMultipartUploadCommand) return {};
        throw new Error('Unexpected S3 command.');
    });
    const backups = create_s3_simple_backups({
        windows: [{ interval_ms: hour, limit: 1 }],
        bucket: { name: 'backups' },
        client,
        part_size: minimum_part_size,
        queue_size: 4,
        adapters: {
            create: async () => {
                path = await create_backup_file(Buffer.alloc(minimum_part_size + 1));
                return { path };
            },
        },
    });
    backups.on('error', (error) => emitted_errors.push(error));

    await backups.__tick();

    assert.deepEqual(emitted_errors, [upload_error]);
    await assert.rejects(access(path));
    assert.equal(backups.backups.length, 0);
    assert.equal(
        client.commands.filter((command) => command instanceof AbortMultipartUploadCommand).length,
        1,
    );
    assert.equal(
        client.commands.filter((command) => command instanceof UploadPartCommand).length,
        1,
    );
});

test('removes created backup files after successful uploads', async () => {
    const now = hour * 100;
    let path;
    Date.now = () => now;

    const client = new MockS3Client(async (command) => {
        if (command instanceof ListObjectsV2Command) return { Contents: [] };
        if (command instanceof PutObjectCommand) {
            await read_body(command.input.Body);
            return {};
        }
        throw new Error('Unexpected S3 command.');
    });
    const backups = create_s3_simple_backups({
        windows: [{ interval_ms: hour, limit: 1 }],
        bucket: { name: 'backups' },
        client,
        adapters: {
            create: async () => {
                path = await create_backup_file();
                return { path };
            },
        },
    });

    await backups.__tick();

    await assert.rejects(access(path));
    assert.equal(backups.backups.length, 1);
});

test('deletes stale S3 backups and respects injected client ownership', async () => {
    const now = hour * 100;
    const current_key = 'current.sql';
    const stale_key = 'stale.sql';
    Date.now = () => now;

    const client = new MockS3Client((command) => {
        if (command instanceof ListObjectsV2Command)
            return {
                Contents: [
                    { Key: stale_key, LastModified: new Date(now - hour) },
                    { Key: current_key, LastModified: new Date(now) },
                ],
            };
        if (command instanceof DeleteObjectCommand) return {};
        throw new Error('Unexpected S3 command.');
    });
    const backups = create_s3_simple_backups({
        windows: [{ interval_ms: hour, limit: 1 }],
        bucket: { name: 'backups' },
        client,
        adapters: {
            create: async () => ({ path: await create_backup_file() }),
        },
    });

    await backups.__tick();
    backups.destroy();

    const delete_command = client.commands.find((command) => command instanceof DeleteObjectCommand);
    assert.equal(delete_command.input.Key, stale_key);
    assert.deepEqual(backups.backups, [{ id: current_key, timestamp: now }]);
    assert.equal(client.destroyed, false);
});
