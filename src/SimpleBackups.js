import EventEmitter from 'node:events';

/**
 * @typedef {Object} Backup
 * @property {string} id The unique identifier of the backup.
 * @property {number} timestamp The timestamp at which the backup was created (in milliseconds).
 */

/**
 * @typedef {Object} BackupWindow
 * @property {number} interval_ms The interval at which this window's backups should be created (in milliseconds).
 * @property {number} limit The maximum number of backups to keep in this window.
 */

/**
 * @typedef {Object} BackupAdapters
 * @property {function():Backup[]|Promise<Backup[]>} list This method **must** return an array of all backups from the upstream storage mechanism.
 * @property {function():Backup|Promise<Backup>} create This method **must** create a new backup and persist it to the upstream storage mechanism.
 * @property {function(Backup):boolean|Promise<boolean>} delete This method **must** attempt to delete the specified backups from the upstream storage mechanism and return a boolean indicating whether the operation was successful.
 */

/**
 * @typedef {Object} SimpleBackupsOptions
 * @property {BackupAdapters} adapters The backup adapters to use.
 * @property {BackupWindow[]} windows The backup windows to use.
 */

/**
 * @typedef {'create'|'delete'} SimpleBackupsBackupEvent
 */

/**
 * @typedef {'error'} SimpleBackupsErrorEvent
 */

/**
 * @typedef {(backup: Backup) => void} SimpleBackupsBackupListener
 */

/**
 * @typedef {(error: Error) => void} SimpleBackupsErrorListener
 */

export class SimpleBackups extends EventEmitter {
    #destroyed = false;
    #initialized = false;

    /**
     * The options for the SimpleBackups instance.
     * @type {SimpleBackupsOptions}
     */
    #options;

    /**
     * The intervals for the backup windows.
     * @type {Map<string, ReturnType<typeof setInterval>>}
     */
    #intervals = new Map();

    /**
     * The most recently listed backups from the upstream storage mechanism.
     * @type {Backup[]}
     */
    #backups = [];

    /**
     * The smallest backup window interval.
     * @type {number}
     */
    #smallest_interval_ms = Infinity;

    /**
     * Constructs a new SimpleBackups instance.
     * @param {SimpleBackupsOptions} options
     */
    constructor(options) {
        super();
        this.#options = options;

        // Enforce valid options
        if (!Array.isArray(this.#options?.windows) || !this.#options?.windows?.length)
            throw new Error('You must specify at least one backup window.');
        if (typeof this.#options?.adapters?.list !== 'function')
            throw new Error('You must specify a backup adapters list method.');
        if (typeof this.#options?.adapters?.create !== 'function')
            throw new Error('You must specify a backup adapters create method.');
        if (typeof this.#options?.adapters?.delete !== 'function')
            throw new Error('You must specify a backup adapters delete method.');

        // Find the most frequent backup interval
        for (const window of this.#options.windows) {
            if (
                Number.isNaN(window?.limit) ||
                !Number.isFinite(window?.limit) ||
                !Number.isInteger(window?.limit) ||
                window?.limit <= 0
            )
                throw new Error('Backup windows must have a positive finite limit.');

            if (
                Number.isNaN(window?.interval_ms) ||
                !Number.isFinite(window?.interval_ms) ||
                !Number.isInteger(window?.interval_ms) ||
                window?.interval_ms <= 0
            )
                throw new Error('Backup windows must have a positive finite interval_ms.');

            if (window?.interval_ms <= this.#smallest_interval_ms) this.#smallest_interval_ms = window?.interval_ms;
        }

        // Create a tick interval with the smallest interval (aka. most precision)
        this.#intervals.set(
            'tick',
            setInterval(() => this.__tick(), this.#smallest_interval_ms),
        );
        setTimeout(() => this.__tick(), 0); // Schedule an immediate tick
    }

    #tick_in_flight = false;
    /**
     * Ticks the SimpleBackups instance.
     */
    async __tick() {
        if (this.#destroyed || this.#tick_in_flight) return;
        this.#tick_in_flight = true;
        try {
            // If we have not initialized yet, then list all available backups from the upstream storage mechanism and cache them in memory
            if (!this.#initialized) {
                try {
                    this.#backups = await this.#options.adapters.list();
                    if (!Array.isArray(this.#backups))
                        throw new Error('Backup adapters list method must return an array of backups.');

                    // Validate the backups
                    const seen_ids = new Set();
                    for (const backup of this.#backups) {
                        if (!backup?.id || typeof backup?.id !== 'string' || seen_ids.has(backup?.id))
                            throw new Error(
                                'Backup adapters list method must return an array of backups with unique IDs.',
                            );
                        seen_ids.add(backup.id);

                        if (
                            typeof backup?.timestamp !== 'number' ||
                            !Number.isFinite(backup?.timestamp) ||
                            backup?.timestamp < 0
                        )
                            throw new Error(
                                'Backup adapters list method must return an array of backups with finite timestamps.',
                            );
                    }

                    this.#backups.sort((a, b) => a.timestamp - b.timestamp); // Sort by ascending timestamp (oldest to newest)
                    this.#initialized = true;
                    if (this.#destroyed) return; // If the instance has been destroyed, then we should stop ticking
                } catch (error) {
                    this.emit('error', error); // Emit the error which may have occurred when listing the backups
                    return;
                }
            }

            let now = Date.now();
            let should_create_backup = true; // Scan all existing backups to determine if we have a backup within the smallest interval slot to determine whether we need to create a new backup
            for (let i = 0; i < this.#backups.length; i++) {
                const backup = this.#backups[i];
                const backup_age = now - backup.timestamp; // Measure the age of the backup (in milliseconds)
                if (backup_age >= 0 && backup_age < this.#smallest_interval_ms) {
                    should_create_backup = false; // We already have a backup within the smallest interval, so we don't need to create another one
                    break;
                }
            }
            if (should_create_backup) {
                try {
                    const backup = await this.#options.adapters.create(); // Create a new backup

                    let already_exists = false; // Determine if a backup with the same ID already exists
                    for (const _backup of this.#backups) {
                        if (_backup.id === backup?.id) {
                            already_exists = true;
                            break;
                        }
                    }
                    if (!backup?.id || typeof backup?.id !== 'string' || already_exists)
                        throw new Error('Backup adapters create method must return a backup with a unique ID.');
                    if (
                        typeof backup.timestamp !== 'number' ||
                        !Number.isFinite(backup.timestamp) ||
                        backup.timestamp < 0
                    )
                        throw new Error('Backup adapters create method must return a backup with a finite timestamp.');

                    this.#backups.push(backup); // Add the new backup to the list of backups in cache
                    this.#backups.sort((a, b) => a.timestamp - b.timestamp); // Sort by ascending timestamp (oldest to newest)
                    now = Date.now(); // Update the current time since we did a potentially asynchronous operation
                    this.emit('create', backup); // Emit this backup as being created
                    if (this.#destroyed) return; // If the instance has been destroyed, then we should stop ticking
                } catch (error) {
                    this.emit('error', error); // Emit the error which may have occurred when creating the backup
                    return;
                }
            }

            const keep_backups_ids = new Set(); // Determine which backup IDs to keep
            for (let i = 0; i < this.#options.windows.length; i++) {
                const best_by_slot = new Map();
                const window = this.#options.windows[i];
                for (let j = 0; j < this.#backups.length; j++) {
                    const backup = this.#backups[j];
                    const backup_age_ms = now - backup.timestamp;
                    if (backup_age_ms < 0) continue; // Ignore future backups (this should not even be possible?)

                    const slot = Math.floor(backup_age_ms / window.interval_ms); // Calculate the window slot for the backup
                    if (slot >= window.limit) continue; // Ignore backups outside this window

                    const target_timestamp = now - slot * window.interval_ms; // Calculate the target timestamp for this backup's ideal slot
                    const distance_to_target_ms = Math.abs(backup.timestamp - target_timestamp); // Calculate the distance between the backup's timestamp and the target timestamp

                    const candidate = best_by_slot.get(slot); // Measure and track the best or lowest distance to target timestamp for a given slot
                    if (!candidate || distance_to_target_ms < candidate.distance_to_target_ms) {
                        best_by_slot.set(slot, { backup, distance_to_target_ms });
                    }
                }

                for (const [_, { backup }] of best_by_slot) keep_backups_ids.add(backup.id); // Add the remaining best backup slot candidates to the list of backups to keep
            }

            const stale_backups = []; // Determine which backups are stale and need to be deleted
            const deleted_backups_ids = new Set(); // Determine which backup IDs have been deleted
            for (let i = 0; i < this.#backups.length; i++) {
                const backup = this.#backups[i];
                if (!keep_backups_ids.has(backup.id)) stale_backups.push(backup);
            }
            for (const backup of stale_backups) {
                try {
                    const deleted = await this.#options.adapters.delete(backup); // Attempt to delete the stale backup
                    if (deleted) {
                        this.emit('delete', backup); // Emit this backup as being deleted
                        deleted_backups_ids.add(backup.id); // If the deletion was successful, add the backup ID to the list of deleted backups
                    }
                    if (this.#destroyed) return; // If the instance has been destroyed, then we should stop ticking
                } catch (error) {
                    this.emit('error', error); // Emit the error which may have occurred when deleting the backup
                }
            }
            if (deleted_backups_ids.size > 0) {
                const remaining_backups = [];
                for (let i = 0; i < this.#backups.length; i++) {
                    const backup = this.#backups[i];
                    if (!deleted_backups_ids.has(backup.id)) remaining_backups.push(backup);
                }
                this.#backups = remaining_backups; // Rebuild and overwrite the backups array with the remaining backups
            }
        } catch (error) {
            this.emit('error', error);
        } finally {
            this.#tick_in_flight = false;
        }
    }

    /**
     * @overload
     * @param {SimpleBackupsBackupEvent} event
     * @param {SimpleBackupsBackupListener} listener
     * @returns {this}
     */
    /**
     * @overload
     * @param {SimpleBackupsErrorEvent} event
     * @param {SimpleBackupsErrorListener} listener
     * @returns {this}
     */
    /**
     * @param {SimpleBackupsBackupEvent|SimpleBackupsErrorEvent} event
     * @param {SimpleBackupsBackupListener|SimpleBackupsErrorListener} listener
     * @returns {this}
     */
    on(event, listener) {
        return super.on(event, listener);
    }

    /**
     * @overload
     * @param {SimpleBackupsBackupEvent} event
     * @param {SimpleBackupsBackupListener} listener
     * @returns {this}
     */
    /**
     * @overload
     * @param {SimpleBackupsErrorEvent} event
     * @param {SimpleBackupsErrorListener} listener
     * @returns {this}
     */
    /**
     * @param {SimpleBackupsBackupEvent|SimpleBackupsErrorEvent} event
     * @param {SimpleBackupsBackupListener|SimpleBackupsErrorListener} listener
     * @returns {this}
     */
    once(event, listener) {
        return super.once(event, listener);
    }

    /**
     * @overload
     * @param {SimpleBackupsBackupEvent} event
     * @param {SimpleBackupsBackupListener} listener
     * @returns {this}
     */
    /**
     * @overload
     * @param {SimpleBackupsErrorEvent} event
     * @param {SimpleBackupsErrorListener} listener
     * @returns {this}
     */
    /**
     * @param {SimpleBackupsBackupEvent|SimpleBackupsErrorEvent} event
     * @param {SimpleBackupsBackupListener|SimpleBackupsErrorListener} listener
     * @returns {this}
     */
    off(event, listener) {
        return super.off(event, listener);
    }

    /**
     * @overload
     * @param {SimpleBackupsBackupEvent} event
     * @param {Backup} backup
     * @returns {boolean}
     */
    /**
     * @overload
     * @param {SimpleBackupsErrorEvent} event
     * @param {Error} error
     * @returns {boolean}
     */
    /**
     * @param {SimpleBackupsBackupEvent|SimpleBackupsErrorEvent} event
     * @param {Backup|Error} value
     * @returns {boolean}
     */
    emit(event, value) {
        return super.emit(event, value);
    }

    /**
     * Destroys the SimpleBackups instance and stops all intervals.
     */
    destroy() {
        if (this.#destroyed) return;
        this.#destroyed = true; // Only destroy once

        for (const [_, interval] of this.#intervals) clearInterval(interval);
        this.#intervals.clear(); // Clear all intervals

        super.removeAllListeners(); // Remove all event listeners (which effectively destroys the EventEmitter)
    }

    /**
     * Returns the current list of backups (if in cache).
     */
    get backups() {
        return [...this.#backups]; // Return a copy of the backups array
    }

    /**
     * Whether the SimpleBackups instance has been destroyed.
     */
    get destroyed() {
        return this.#destroyed;
    }
}
