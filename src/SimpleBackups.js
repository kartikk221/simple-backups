import EventEmitter from 'node:events';

/**
 * @typedef {Object} Backup
 * @property {string} id The unique identifier of the backup.
 * @property {number} timestamp The timestamp at which the backup was created (in milliseconds).
 */

/**
 * @typedef {Object} BackupWindow
 * @property {number} interval_ms The width of each retention slot in this window (in milliseconds).
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

    /** @type {ReturnType<typeof setTimeout>|undefined} */
    #tick_timer;

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

        this.#schedule_tick(0); // Schedule an immediate tick
    }

    #tick_in_flight = false;

    /**
     * Schedules the next tick, replacing any previously scheduled tick.
     * @param {number} delay_ms
     */
    #schedule_tick(delay_ms) {
        if (this.#destroyed) return;
        if (this.#tick_timer !== undefined) clearTimeout(this.#tick_timer);

        const timer = setTimeout(() => {
            if (this.#tick_timer === timer) this.#tick_timer = undefined;
            return this.__tick();
        }, delay_ms);
        this.#tick_timer = timer;
    }

    /**
     * Determines when another backup can be created. Scheduling relative to
     * backup timestamps avoids timer phase drift when creation takes time.
     * @param {number} now
     * @returns {number}
     */
    #get_next_tick_delay(now) {
        let newest_current_timestamp = -Infinity;
        for (const backup of this.#backups) {
            const backup_age = now - backup.timestamp;
            if (
                backup_age >= 0 &&
                backup_age < this.#smallest_interval_ms &&
                backup.timestamp > newest_current_timestamp
            )
                newest_current_timestamp = backup.timestamp;
        }

        if (newest_current_timestamp === -Infinity) return this.#smallest_interval_ms;
        return Math.max(0, newest_current_timestamp + this.#smallest_interval_ms - now);
    }

    /**
     * Determines which backup IDs should be kept by the configured backup windows.
     * @param {number} now The current timestamp (in milliseconds).
     * @returns {Set<string>}
     */
    _get_keep_backups_ids(now) {
        /** @type {Set<string>} */
        const keep_backups_ids = new Set();
        for (let i = 0; i < this.#options.windows.length; i++) {
            /** @type {Map<number, Backup>} */
            const best_by_slot = new Map();
            const window = this.#options.windows[i];
            const current_slot = Math.floor(now / window.interval_ms); // Anchor slots to timestamps instead of their ever-changing age
            const oldest_slot = current_slot - window.limit + 1;

            for (let j = 0; j < this.#backups.length; j++) {
                const backup = this.#backups[j];
                if (backup.timestamp > now) continue; // Ignore future backups (this should not even be possible?)

                const slot = Math.floor(backup.timestamp / window.interval_ms); // A backup always belongs to the same slot as it ages
                if (slot < oldest_slot || slot > current_slot) continue; // Ignore backups outside this window

                // Backups are sorted from oldest to newest, so the first backup is the closest one to the start of this slot
                if (!best_by_slot.has(slot)) best_by_slot.set(slot, backup);
            }

            for (const [_, backup] of best_by_slot) keep_backups_ids.add(backup.id); // Add the remaining best backup slot candidates to the list of backups to keep
        }

        return keep_backups_ids;
    }

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

            const keep_backups_ids = this._get_keep_backups_ids(now); // Determine which backup IDs to keep

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
            this.#schedule_tick(this.#get_next_tick_delay(Date.now()));
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
     * Destroys the SimpleBackups instance and stops its timer.
     */
    destroy() {
        if (this.#destroyed) return;
        this.#destroyed = true; // Only destroy once

        if (this.#tick_timer !== undefined) clearTimeout(this.#tick_timer);
        this.#tick_timer = undefined;

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
