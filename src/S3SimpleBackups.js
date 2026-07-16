import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
    UploadPartCommand,
} from '@aws-sdk/client-s3';

import { SimpleBackups } from './SimpleBackups.js';

const minimum_part_size = 1024 * 1024 * 5;
const maximum_part_size = 1024 * 1024 * 1024 * 5;
const maximum_parts = 10000;

/**
 * @typedef {Object} S3SimpleBackupsCreateResult
 * @property {string} path The path of the backup file to upload.
 * @property {S3SimpleBackupsUploadOptions} [options] S3 SDK options applied to the uploaded object.
 */

/**
 * @typedef {Object} S3SimpleBackupsAdapters
 * @property {() => Promise<S3SimpleBackupsCreateResult>} create Creates a backup file and returns its path and upload options.
 */

/**
 * @typedef {Omit<import('@aws-sdk/client-s3').CreateMultipartUploadCommandInput, 'Bucket'|'Key'>} S3SimpleBackupsUploadOptions
 */

/**
 * @typedef {import('@aws-sdk/client-s3').S3ClientConfig & {name: string}} S3SimpleBackupsBucket
 */

/**
 * @typedef {Object} S3SimpleBackupsOptions
 * @property {import('./SimpleBackups.js').BackupWindow[]} windows The backup windows to use.
 * @property {S3SimpleBackupsBucket} bucket The S3 bucket and client configuration to use.
 * @property {S3SimpleBackupsAdapters} adapters The backup creation adapter to use.
 * @property {S3Client} [client] An existing S3 client to use.
 * @property {boolean} [destroy_client] Whether the S3 client should be destroyed with this instance.
 * @property {number} [part_size=8388608] The multipart upload part size in bytes.
 * @property {number} [queue_size=4] The maximum number of parts to upload concurrently.
 */

/**
 * Implements the S3 storage operations used by S3SimpleBackups.
 */
class S3BackupStorage {
    /** @type {S3SimpleBackupsBucket} */
    #bucket;

    /** @type {S3Client|undefined} */
    #client;

    /** @type {S3SimpleBackupsAdapters} */
    #adapters;

    /** @type {Set<string>} */
    #backup_keys = new Set();

    /** @type {boolean} */
    #destroy_client;

    /** @type {number} */
    #part_size;

    /** @type {number} */
    #queue_size;

    /**
     * @param {S3SimpleBackupsOptions} options
     */
    constructor(options) {
        if (
            !options?.bucket ||
            typeof options.bucket !== 'object' ||
            Array.isArray(options.bucket)
        )
            throw new Error('You must specify an S3 bucket configuration object.');
        if (!options.bucket.name || typeof options.bucket.name !== 'string' || !options.bucket.name.trim())
            throw new Error('You must specify a non-empty S3 bucket name.');
        if (typeof options?.adapters?.create !== 'function')
            throw new Error('You must specify an S3 backup adapters create method.');
        if (options?.client !== undefined && typeof options.client?.send !== 'function')
            throw new Error('S3 backup client must be an S3Client-compatible object.');
        if (
            options?.destroy_client !== undefined &&
            typeof options.destroy_client !== 'boolean'
        )
            throw new Error('S3 backup destroy_client must be a boolean.');
        if (
            options?.part_size !== undefined &&
            (!Number.isInteger(options.part_size) ||
                options.part_size < minimum_part_size ||
                options.part_size > maximum_part_size)
        )
            throw new Error(
                `S3 backup part_size must be an integer between ${minimum_part_size} and ${maximum_part_size}.`,
            );
        if (
            options?.queue_size !== undefined &&
            (!Number.isInteger(options.queue_size) || options.queue_size <= 0)
        )
            throw new Error('S3 backup queue_size must be a positive integer.');
        this.#adapters = options.adapters;
        this.#bucket = options.bucket;
        this.#client = options.client;
        this.#destroy_client = options.destroy_client ?? !options.client;
        this.#part_size = options.part_size ?? 1024 * 1024 * 8;
        this.#queue_size = options.queue_size ?? 4;
    }

    /**
     * Lists every backup stored in this instance's bucket.
     * @returns {Promise<import('./SimpleBackups.js').Backup[]>}
     */
    async list() {
        const backups = [];
        let continuation_token;

        do {
            const response = await this.client.send(
                new ListObjectsV2Command({
                    Bucket: this.#bucket.name,
                    ContinuationToken: continuation_token,
                }),
            );

            for (const object of response.Contents || []) {
                if (!object.Key) continue;
                const timestamp = this._get_backup_timestamp(object.LastModified);
                if (timestamp === undefined) continue;

                backups.push({
                    id: object.Key,
                    timestamp,
                });
            }

            continuation_token = response.IsTruncated ? response.NextContinuationToken : undefined;
        } while (continuation_token);

        this.#backup_keys = new Set(backups.map((backup) => backup.id));
        return backups;
    }

    /**
     * Creates a backup file using the user adapter and uploads it to S3.
     * @returns {Promise<import('./SimpleBackups.js').Backup>}
     */
    async create() {
        const source = await this.#adapters.create();
        this._validate_create_result(source);

        const file = await stat(source.path);
        if (!file.isFile()) throw new Error('S3 backup path must reference a file.');

        const timestamp = Date.now();
        const key = this._get_backup_key(basename(source.path));
        if (this.#backup_keys.has(key)) {
            await rm(source.path, { force: true });
            throw new Error(`An S3 backup named "${key}" already exists.`);
        }
        const upload_options = this._get_upload_options(source);

        try {
            await this._upload(key, source.path, file.size, upload_options);
        } catch (upload_error) {
            try {
                await rm(source.path, { force: true });
            } catch (cleanup_error) {
                throw new AggregateError(
                    [upload_error, cleanup_error],
                    'S3 backup upload and cleanup both failed.',
                );
            }
            throw upload_error;
        }

        try {
            await rm(source.path, { force: true });
        } catch (cleanup_error) {
            try {
                await this.client.send(
                    new DeleteObjectCommand({
                        Bucket: this.#bucket.name,
                        Key: key,
                        ExpectedBucketOwner: upload_options.ExpectedBucketOwner,
                        RequestPayer: upload_options.RequestPayer,
                    }),
                );
            } catch (rollback_error) {
                throw new AggregateError(
                    [cleanup_error, rollback_error],
                    'S3 backup cleanup and upload rollback both failed.',
                );
            }
            throw cleanup_error;
        }

        this.#backup_keys.add(key);
        return {
            id: key,
            timestamp,
        };
    }

    /**
     * Deletes a backup from S3.
     * @param {import('./SimpleBackups.js').Backup} backup
     * @returns {Promise<boolean>}
     */
    async delete(backup) {
        await this.client.send(
            new DeleteObjectCommand({
                Bucket: this.#bucket.name,
                Key: backup.id,
            }),
        );
        this.#backup_keys.delete(backup.id);
        return true;
    }

    /**
     * Destroys the internally managed S3 client when configured to do so.
     */
    destroy() {
        if (this.#destroy_client) this.#client?.destroy();
    }

    /**
     * Uploads a backup file using a single request or a bounded multipart upload.
     * @param {string} key
     * @param {string} path
     * @param {number} content_length
     * @param {S3SimpleBackupsUploadOptions} upload_options
     */
    async _upload(key, path, content_length, upload_options) {
        if (content_length <= this.#part_size) {
            await this._put_object(
                key,
                content_length ? createReadStream(path) : Buffer.alloc(0),
                content_length,
                upload_options,
            );
            return;
        }

        const required_part_size = Math.ceil(content_length / maximum_parts);
        const part_size = Math.max(this.#part_size, required_part_size);
        if (part_size > maximum_part_size)
            throw new Error('S3 backup file exceeds the maximum multipart upload size.');

        const iterator = this._get_parts(createReadStream(path), part_size)[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done) {
            await this._put_object(key, Buffer.alloc(0), 0, upload_options);
            return;
        }
        if (first.value.length < part_size) {
            await this._put_object(key, first.value, first.value.length, upload_options);
            return;
        }

        await this._multipart_upload(
            key,
            upload_options,
            [first.value],
            iterator,
        );
    }

    /**
     * Uploads a body using a single PutObject request.
     * @param {string} key
     * @param {NonNullable<import('@aws-sdk/client-s3').PutObjectCommandInput['Body']>} body
     * @param {number} content_length
     * @param {S3SimpleBackupsUploadOptions} upload_options
     */
    async _put_object(key, body, content_length, upload_options) {
        await this.client.send(
            new PutObjectCommand({
                ...upload_options,
                Bucket: this.#bucket.name,
                Key: key,
                Body: body,
                ContentLength: content_length,
            }),
        );
    }

    /**
     * Uploads buffered parts concurrently and completes or aborts the multipart upload.
     * @param {string} key
     * @param {S3SimpleBackupsUploadOptions} upload_options
     * @param {Buffer[]} initial_parts
     * @param {AsyncIterator<Buffer>} iterator
     */
    async _multipart_upload(key, upload_options, initial_parts, iterator) {
        const create_response = await this.client.send(
            new CreateMultipartUploadCommand({
                ...upload_options,
                Bucket: this.#bucket.name,
                Key: key,
            }),
        );
        if (!create_response.UploadId)
            throw new Error('S3 did not return an upload ID for the multipart backup upload.');

        const upload_id = create_response.UploadId;
        const completed_parts = [];
        const uploads = new Set();
        let part_upload_error;
        let part_number = 0;

        const upload_part = (body) => {
            part_number++;
            if (part_number > maximum_parts)
                throw new Error(`S3 backup uploads cannot exceed ${maximum_parts} parts.`);

            const current_part_number = part_number;
            const upload = this._upload_part(
                key,
                upload_id,
                current_part_number,
                body,
                upload_options,
            )
                .then((completed_part) => {
                    completed_parts[current_part_number - 1] = completed_part;
                })
                .catch((error) => {
                    part_upload_error ??= error;
                    throw error;
                });

            uploads.add(upload);
            upload.then(
                () => uploads.delete(upload),
                () => uploads.delete(upload),
            );
        };

        try {
            for (const part of initial_parts) {
                upload_part(part);
                if (uploads.size >= this.#queue_size) await Promise.race(uploads);
                if (part_upload_error) throw part_upload_error;
            }

            for (;;) {
                const next = await iterator.next();
                if (part_upload_error) throw part_upload_error;
                if (next.done) break;

                upload_part(next.value);
                if (uploads.size >= this.#queue_size) await Promise.race(uploads);
                if (part_upload_error) throw part_upload_error;
            }

            await Promise.all(uploads);
            if (part_upload_error) throw part_upload_error;
            await this.client.send(
                new CompleteMultipartUploadCommand({
                    Bucket: this.#bucket.name,
                    Key: key,
                    UploadId: upload_id,
                    MultipartUpload: {
                        Parts: completed_parts,
                    },
                    ExpectedBucketOwner: upload_options.ExpectedBucketOwner,
                    RequestPayer: upload_options.RequestPayer,
                }),
            );
        } catch (upload_error) {
            await Promise.allSettled(uploads);
            try {
                await this.client.send(
                    new AbortMultipartUploadCommand({
                        Bucket: this.#bucket.name,
                        Key: key,
                        UploadId: upload_id,
                        ExpectedBucketOwner: upload_options.ExpectedBucketOwner,
                        RequestPayer: upload_options.RequestPayer,
                    }),
                );
            } catch (abort_error) {
                throw new AggregateError(
                    [upload_error, abort_error],
                    'S3 backup multipart upload and abort both failed.',
                );
            }
            throw upload_error;
        }
    }

    /**
     * Uploads a single multipart body part.
     * @param {string} key
     * @param {string} upload_id
     * @param {number} part_number
     * @param {Buffer} body
     * @param {S3SimpleBackupsUploadOptions} upload_options
     * @returns {Promise<import('@aws-sdk/client-s3').CompletedPart>}
     */
    async _upload_part(key, upload_id, part_number, body, upload_options) {
        const response = await this.client.send(
            new UploadPartCommand({
                Bucket: this.#bucket.name,
                Key: key,
                UploadId: upload_id,
                PartNumber: part_number,
                Body: body,
                ContentLength: body.length,
                ChecksumAlgorithm: upload_options.ChecksumAlgorithm,
                ExpectedBucketOwner: upload_options.ExpectedBucketOwner,
                RequestPayer: upload_options.RequestPayer,
                SSECustomerAlgorithm: upload_options.SSECustomerAlgorithm,
                SSECustomerKey: upload_options.SSECustomerKey,
                SSECustomerKeyMD5: upload_options.SSECustomerKeyMD5,
            }),
        );
        if (!response.ETag)
            throw new Error(`S3 did not return an ETag for backup upload part ${part_number}.`);

        const completed_part = {
            ETag: response.ETag,
            PartNumber: part_number,
        };
        for (const checksum of [
            'ChecksumCRC32',
            'ChecksumCRC32C',
            'ChecksumCRC64NVME',
            'ChecksumSHA1',
            'ChecksumSHA256',
        ]) {
            if (response[checksum] !== undefined) completed_part[checksum] = response[checksum];
        }
        return completed_part;
    }

    /**
     * Splits a backup file stream into fixed-size multipart buffers.
     * @param {import('node:fs').ReadStream} body
     * @param {number} part_size
     * @returns {AsyncGenerator<Buffer>}
     */
    async *_get_parts(body, part_size) {
        let buffers = [];
        let buffered_bytes = 0;

        for await (const chunk of body) {
            const buffer = this._to_buffer(chunk);
            let offset = 0;

            while (offset < buffer.length) {
                const available_bytes = part_size - buffered_bytes;
                const bytes_to_copy = Math.min(available_bytes, buffer.length - offset);
                buffers.push(buffer.subarray(offset, offset + bytes_to_copy));
                buffered_bytes += bytes_to_copy;
                offset += bytes_to_copy;

                if (buffered_bytes === part_size) {
                    yield Buffer.concat(buffers, part_size);
                    buffers = [];
                    buffered_bytes = 0;
                }
            }
        }

        if (buffered_bytes > 0) yield Buffer.concat(buffers, buffered_bytes);
    }

    /**
     * Converts a streamed body chunk into a Buffer.
     * @param {unknown} chunk
     * @returns {Buffer}
     */
    _to_buffer(chunk) {
        if (typeof chunk === 'string') return Buffer.from(chunk);
        if (chunk instanceof Uint8Array)
            return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
        throw new Error('S3 backup streams must emit strings or byte arrays.');
    }

    /**
     * Validates a backup creation adapter result.
     * @param {S3SimpleBackupsCreateResult} source
     */
    _validate_create_result(source) {
        if (!source || typeof source !== 'object' || Array.isArray(source))
            throw new Error('S3 backup adapters create method must return an object.');
        if (!source.path || typeof source.path !== 'string')
            throw new Error('S3 backup adapters create method must return a non-empty path.');
        if (
            source.options !== undefined &&
            (!source.options || typeof source.options !== 'object' || Array.isArray(source.options))
        )
            throw new Error('S3 backup options must be an object.');
    }

    /**
     * Creates an object key using the backup filename.
     * @param {string} filename
     * @returns {string}
     */
    _get_backup_key(filename) {
        return filename;
    }

    /**
     * Gets a timestamp from an S3 modification date.
     * @param {Date|undefined} last_modified
     * @returns {number|undefined}
     */
    _get_backup_timestamp(last_modified) {
        const timestamp = new Date(last_modified).getTime();
        if (!Number.isFinite(timestamp) || timestamp < 0) return;
        return timestamp;
    }

    /**
     * Returns the protected S3 SDK options for a backup upload.
     * @param {S3SimpleBackupsCreateResult} source
     * @returns {S3SimpleBackupsUploadOptions}
     */
    _get_upload_options(source) {
        return this._remove_protected_upload_options(source.options ?? {});
    }

    /**
     * Removes request properties which are managed internally by this class.
     * @param {S3SimpleBackupsUploadOptions} upload_options
     * @returns {S3SimpleBackupsUploadOptions}
     */
    _remove_protected_upload_options(upload_options) {
        const {
            Body: _,
            Bucket: __,
            ContentLength: ___,
            Key: ____,
            ...remaining_upload_options
        } = upload_options;
        return remaining_upload_options;
    }

    /**
     * Returns the configured S3 client, constructing it lazily when needed.
     * @returns {S3Client}
     */
    get client() {
        if (!this.#client) {
            const { name: _, ...client_options } = this.#bucket;
            this.#client = new S3Client({
                requestChecksumCalculation: 'WHEN_REQUIRED',
                responseChecksumValidation: 'WHEN_REQUIRED',
                ...client_options,
            });
        }
        return this.#client;
    }

    /**
     * Returns the configured S3 bucket.
     */
    get bucket() {
        return this.#bucket.name;
    }
}

/**
 * A SimpleBackups implementation which stores backups in any S3-compatible object storage bucket.
 */
export class S3SimpleBackups extends SimpleBackups {
    /** @type {S3BackupStorage} */
    #storage;

    /**
     * Constructs a new S3SimpleBackups instance.
     * @param {S3SimpleBackupsOptions} options
     */
    constructor(options) {
        const storage = new S3BackupStorage(options);
        super({
            windows: options?.windows,
            adapters: {
                list: () => storage.list(),
                create: () => storage.create(),
                delete: (backup) => storage.delete(backup),
            },
        });
        this.#storage = storage;
    }

    /**
     * Destroys this instance and its internally managed S3 client.
     */
    destroy() {
        if (this.destroyed) return;
        super.destroy();
        this.#storage.destroy();
    }

    /**
     * Returns the configured S3 client.
     */
    get client() {
        return this.#storage.client;
    }

    /**
     * Returns the configured S3 bucket.
     */
    get bucket() {
        return this.#storage.bucket;
    }

}
