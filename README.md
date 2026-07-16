# SimpleBackups: A Simple Package To Automatically Create And Prune Backups.

<div align="left">

[![NPM version](https://img.shields.io/npm/v/simple-backups.svg?style=flat)](https://www.npmjs.com/package/simple-backups)
[![NPM downloads](https://img.shields.io/npm/dm/simple-backups.svg?style=flat)](https://www.npmjs.com/package/simple-backups)
[![GitHub issues](https://img.shields.io/github/issues/kartikk221/simple-backups)](https://github.com/kartikk221/simple-backups/issues)
[![GitHub stars](https://img.shields.io/github/stars/kartikk221/simple-backups)](https://github.com/kartikk221/simple-backups/stargazers)
[![GitHub license](https://img.shields.io/github/license/kartikk221/simple-backups)](https://github.com/kartikk221/simple-backups/blob/master/LICENSE)

</div>

## Motivation
This package aims to simplify the task of automatically creating and pruning backups from any upstream storage mechanism. This package does not care where your backups are stored and instead uses a small adapter interface to list, create and delete backups while maintaining multiple backup retention windows.

## Features
- Simple-to-use API
- JSDoc Type Support
- TypeScript Type Definitions
- Automatic Backup Creation
- Multi-Window Backup Retention
- S3-Compatible Object Storage
- CPU & Memory Efficient
- Dependency-Free Core

## Installation
SimpleBackups can be installed using node package manager (`npm`)
```
npm i simple-backups
```

## How To Use?
Below is a small snippet that shows how to use a `SimpleBackups` instance.

```javascript
import { SimpleBackups } from 'simple-backups';

const hour = 1000 * 60 * 60;
const day = hour * 24;

// Create a simple backups instance which keeps 24 hourly backups and 30 daily backups
const backups = new SimpleBackups({
    windows: [
        { interval_ms: hour, limit: 24 },
        { interval_ms: day, limit: 30 }
    ],
    adapters: {
        async list() {
            // Return every backup currently stored in the upstream storage mechanism
            // Each backup must have a unique id and a timestamp in milliseconds
            return await storage.list_backups();
        },
        async create() {
            // Create a new backup in the upstream storage mechanism
            const backup = await storage.create_backup();

            // Return the backup record so SimpleBackups can track it
            return {
                id: backup.id,
                timestamp: backup.timestamp
            };
        },
        async delete(backup) {
            // Attempt to delete the backup from the upstream storage mechanism
            // Return true only if the backup was successfully deleted
            return await storage.delete_backup(backup.id);
        }
    }
});

// Listen for newly created backups
backups.on('create', (backup) => {
    console.log('Created backup:', backup.id);
});

// Listen for successfully deleted backups
backups.on('delete', (backup) => {
    console.log('Deleted backup:', backup.id);
});

// Listen for adapter or validation errors
backups.on('error', (error) => {
    console.error(error);
});
```

## TypeScript
SimpleBackups includes first-party TypeScript declarations. No separate `@types` package is required.

```typescript
import {
    SimpleBackups,
    S3SimpleBackups,
    type Backup,
    type BackupAdapters,
    type BackupWindow,
    type S3SimpleBackupsOptions,
    type SimpleBackupsOptions
} from 'simple-backups';
```

## S3SimpleBackups
`S3SimpleBackups` extends `SimpleBackups` and supplies its `list`, `create` and `delete` adapters using an S3-compatible object storage bucket. The user only needs to provide an asynchronous adapter which creates a local backup file and returns an object containing its path.

The core `SimpleBackups` class remains dependency-free. S3 support uses the official modular [`@aws-sdk/client-s3`](https://www.npmjs.com/package/@aws-sdk/client-s3) package as its only direct runtime dependency.

The following example creates a MySQL dump in the operating system's temporary directory and returns an object containing its path and native S3 upload options. `S3SimpleBackups` determines the filename and file size, streams the file to Vultr Object Storage and removes the temporary file after the upload attempt.

```javascript
import { exec } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { S3SimpleBackups } from 'simple-backups';

// Convert exec into a promise so the adapter can await mysqldump.
const exec_async = promisify(exec);

// Retention window intervals are expressed in milliseconds.
const hour = 1000 * 60 * 60;
const day = hour * 24;

const backups = new S3SimpleBackups({
    // Keep one backup per hour for 24 hours and one per day for 30 days.
    windows: [
        { interval_ms: hour, limit: 24 },
        { interval_ms: day, limit: 30 }
    ],

    // The bucket name and connection properties used by the official AWS S3
    // client. Vultr accepts us-east-1 as the request-signing region.
    bucket: {
        name: 'wuup-db-backups',
        region: 'us-east-1',
        endpoint: 'https://ewr1.vultrobjects.com',
        credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
        }
    },

    // This is the only storage adapter the application needs to implement.
    adapters: {
        async create() {
            // Include a timestamp so every temporary filename is unique.
            const file_path = join(tmpdir(), `wuupdb_${Date.now()}.sql`);

            // mysqldump runs as a child process. Awaiting it does not block the
            // Node.js event loop; it only delays this backup until the dump exits.
            await exec_async(`mysqldump wuupdb > "${file_path}"`);

            // S3SimpleBackups opens, sizes, streams and removes this file. The
            // options object is passed to the underlying S3 SDK as-is.
            return {
                path: file_path,
                options: {
                    ContentType: 'application/sql',
                    StorageClass: 'STANDARD_IA',
                    Metadata: {
                        database: 'wuupdb'
                    }
                }
            };
        }
    }
});

backups.on('create', (backup) => {
    console.log('Created S3 backup:', backup.id);
});

backups.on('delete', (backup) => {
    console.log('Deleted S3 backup:', backup.id);
});

backups.on('error', (error) => {
    console.error(error);
});
```

`S3SimpleBackups` uses the local backup file's basename as the S3 object key without adding or changing anything.

```text
wuupdb_1784230616789.sql
```

Every object in the configured bucket is treated as a backup managed by this instance. Backup timestamps are read from the standard S3 `LastModified` value returned by `ListObjectsV2`; timestamps are not encoded into object keys or custom metadata.

S3 identifies an object by its key and does not assign a separate object ID. Uploading another file with the same name would overwrite the existing object unless bucket versioning is enabled. To protect retained backups consistently across S3-compatible providers, `S3SimpleBackups` rejects a filename which already exists. Backup creation adapters should therefore create unique filenames, commonly by including `Date.now()` as shown above.

Files larger than the configured part size are streamed using bounded [S3 multipart uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html). The default part size is 8 MiB and the default concurrency is four parts. These can be customized with `part_size` and `queue_size`. Memory use is bounded by the part size and upload concurrency rather than the total backup size.

The creation adapter must return `{ path, options? }`. The optional `options` object is passed directly to the underlying S3 SDK, so it uses native SDK property names such as `ContentType`, `StorageClass`, `Metadata`, `ServerSideEncryption` and `SSEKMSKeyId`. `Bucket`, `Key`, `Body` and `ContentLength` are managed internally and cannot be overridden. Created local backup files are removed after every upload attempt.

An existing `S3Client` can be provided using `client`. Injected clients are not destroyed by default; clients constructed from the `bucket` configuration are destroyed when the `S3SimpleBackups` instance is destroyed. This behavior can be overridden with `destroy_client`.

The configured S3 identity needs permission to list the bucket and to create, upload, complete, abort and delete its objects.

## SimpleBackups
Below is a breakdown of the `SimpleBackups` class.

#### Constructor Parameters
* `new SimpleBackups(Object: options)`: Creates a new SimpleBackups instance with the provided `options`.
  * `options` [`Object`]: Constructor options for this instance.
    * `adapters` [`BackupAdapters`]: Adapter methods used to list, create and delete backups from the upstream storage mechanism.
    * `windows` [`BackupWindow[]`]: Retention windows used to determine the backup creation cadence and which backups should be kept.
  * **Note!** the SimpleBackups instance starts automatically when constructed.
  * **Note!** the smallest `interval_ms` from the provided windows is used as the backup creation cadence and internal tick interval. Larger windows retain backups created at that cadence instead of creating additional backups.
  * **Note!** all window `interval_ms` and `limit` values must be positive finite integers.

#### SimpleBackups Properties
| Property  | Type     | Description                |
| :-------- | :------- | :------------------------- |
| `backups`   | `Backup[]`    | The most recently listed backups from the upstream storage mechanism.   |
| `destroyed`   | `Boolean`    | Whether this SimpleBackups instance has been destroyed.   |

#### SimpleBackups Methods
* `destroy()`: Destroys the SimpleBackups instance and stops all internal intervals.
  * **Note** this method also removes all event listeners from the instance.
* `on(String: event, Function: listener)`: Adds a listener for a SimpleBackups event.
  * **Returns** the SimpleBackups instance.
* `once(String: event, Function: listener)`: Adds a one-time listener for a SimpleBackups event.
  * **Returns** the SimpleBackups instance.
* `off(String: event, Function: listener)`: Removes a listener for a SimpleBackups event.
  * **Returns** the SimpleBackups instance.

#### SimpleBackups Events
* [`create`]: The `create` event is emitted whenever a backup is successfully created.
    * **Example:** `backups.on('create', (backup) => { /* Your Code */ });`
* [`delete`]: The `delete` event is emitted whenever a backup is successfully deleted.
    * **Example:** `backups.on('delete', (backup) => { /* Your Code */ });`
* [`error`]: The `error` event is emitted whenever an adapter or validation error occurs.
    * **Example:** `backups.on('error', (error) => { /* Your Code */ });`
    * **Note** this is a standard Node.js `error` event and should be handled by the user.

### BackupAdapters Properties
| Property  | Type     | Description                |
| :-------- | :------- | :------------------------- |
| `list`   | `function(): Backup[] \| Promise<Backup[]>`    | Lists all backups from the upstream storage mechanism.   |
| `create`   | `function(): Backup \| Promise<Backup>`    | Creates a new backup in the upstream storage mechanism.   |
| `delete`   | `function(Backup): Boolean \| Promise<Boolean>`    | Attempts to delete the specified backup from the upstream storage mechanism.   |

### BackupWindow Properties
| Property  | Type     | Description                |
| :-------- | :------- | :------------------------- |
| `interval_ms`   | `Number`    | The width of each retention slot in this window in milliseconds.   |
| `limit`   | `Number`    | The maximum number of backups to keep in this window.   |

### Backup Properties
| Property  | Type     | Description                |
| :-------- | :------- | :------------------------- |
| `id`   | `String`    | The unique identifier of the backup.   |
| `timestamp`   | `Number`    | The timestamp at which the backup was created in milliseconds.   |

## Retention Behavior
SimpleBackups creates a new backup when no existing backup exists within the smallest configured backup window interval. During each tick, every backup window independently selects one backup for each populated retention slot and stale backups which are not selected by any window are deleted.

Retention slots are fixed and derived only from each backup's timestamp using `Math.floor(timestamp / interval_ms)`. The earliest available backup in a slot is retained because it is closest to the start of that slot. A backup therefore remains in the same slot as time passes, allowing an hourly backup selected by a daily window to remain available for later daily slots instead of being replaced and deleted every hour.

Slots are anchored to the Unix epoch. As a result, `day` in the example represents consecutive fixed 24-hour periods rather than local calendar days, and is not affected by time zones or daylight saving time.

For example, the following windows will attempt to keep up to 24 hourly backups and up to 30 daily backups.

```javascript
windows: [
    { interval_ms: 1000 * 60 * 60, limit: 24 },
    { interval_ms: 1000 * 60 * 60 * 24, limit: 30 }
]
```

With uninterrupted hourly backups, this configuration converges to 24 populated hourly slots and 30 populated daily slots (the current slot plus the previous 29 slots). Because one backup can satisfy both windows at the same time, this normally represents 53 unique stored backups rather than 54.

* **Note** backups can satisfy multiple windows at the same time.
* **Note** SimpleBackups can only keep backups that exist and cannot create missed backups for time periods where the process was offline.
* **Note** backups are selected by timestamp and not by filename or storage order.

## Testing
The test suite uses the built-in Node.js test runner and does not require any additional dependencies.

```bash
npm test
```

## License
[MIT](./LICENSE)
