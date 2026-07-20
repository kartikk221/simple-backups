import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { SimpleBackups } from 'simple-backups';

const minute = 1000 * 60;
const hour = minute * 60;
const day = hour * 24;
const original_date_now = Date.now;
const original_clear_timeout = globalThis.clearTimeout;
const original_set_timeout = globalThis.setTimeout;
const active_backups = new Set();

/**
 * Constructs and tracks a SimpleBackups instance so its timers are always destroyed after a test.
 * @param {ConstructorParameters<typeof SimpleBackups>[0]} options
 * @returns {SimpleBackups}
 */
function create_simple_backups(options) {
    const backups = new SimpleBackups(options);
    active_backups.add(backups);
    return backups;
}

afterEach(() => {
    for (const backups of active_backups) backups.destroy();
    active_backups.clear();
    Date.now = original_date_now;
    globalThis.clearTimeout = original_clear_timeout;
    globalThis.setTimeout = original_set_timeout;
});

test('exports SimpleBackups through the package entry point', () => {
    assert.equal(typeof SimpleBackups, 'function');
});

test('validates constructor options', () => {
    const adapters = {
        list: () => [],
        create: () => ({ id: 'backup', timestamp: Date.now() }),
        delete: () => true,
    };

    assert.throws(() => new SimpleBackups(), /at least one backup window/);
    assert.throws(() => new SimpleBackups({ windows: [], adapters }), /at least one backup window/);
    assert.throws(
        () => new SimpleBackups({ windows: [{ interval_ms: hour, limit: 1 }], adapters: {} }),
        /adapters list method/,
    );
    assert.throws(
        () =>
            new SimpleBackups({
                windows: [{ interval_ms: hour, limit: 1 }],
                adapters: { ...adapters, create: undefined },
            }),
        /adapters create method/,
    );
    assert.throws(
        () =>
            new SimpleBackups({
                windows: [{ interval_ms: hour, limit: 1 }],
                adapters: { ...adapters, delete: undefined },
            }),
        /adapters delete method/,
    );

    for (const limit of [undefined, 0, -1, 1.5, NaN, Infinity]) {
        assert.throws(
            () => new SimpleBackups({ windows: [{ interval_ms: hour, limit }], adapters }),
            /positive finite limit/,
        );
    }
    for (const interval_ms of [undefined, 0, -1, 1.5, NaN, Infinity]) {
        assert.throws(
            () => new SimpleBackups({ windows: [{ interval_ms, limit: 1 }], adapters }),
            /positive finite interval_ms/,
        );
    }
});

test('creates backups at the smallest configured interval and returns a defensive backup list', async () => {
    let now = day * 100;
    let create_calls = 0;
    const created_backups = [];
    Date.now = () => now;

    const backups = create_simple_backups({
        windows: [{ interval_ms: hour, limit: 2 }],
        adapters: {
            list: () => [],
            create: () => ({ id: `backup-${create_calls++}`, timestamp: now }),
            delete: () => true,
        },
    });
    backups.on('create', (backup) => created_backups.push(backup));

    await backups.__tick();
    assert.equal(create_calls, 1);

    now += hour - 1;
    await backups.__tick();
    assert.equal(create_calls, 1);

    now += 1;
    await backups.__tick();
    assert.equal(create_calls, 2);
    assert.deepEqual(
        created_backups.map((backup) => backup.id),
        ['backup-0', 'backup-1'],
    );

    const backup_list = backups.backups;
    backup_list.length = 0;
    assert.equal(backups.backups.length, 2);
});

test('schedules creation relative to a delayed backup timestamp instead of the initial timer phase', async () => {
    let now = day * 100;
    let create_calls = 0;
    let next_timer_id = 0;
    const timers = new Map();
    Date.now = () => now;
    globalThis.setTimeout = (callback, delay = 0) => {
        const id = ++next_timer_id;
        timers.set(id, { callback, due_at: now + delay });
        return id;
    };
    globalThis.clearTimeout = (id) => timers.delete(id);

    const backups = create_simple_backups({
        windows: [{ interval_ms: hour, limit: 2 }],
        adapters: {
            list: () => [],
            create: () => {
                if (create_calls === 0) now += minute * 2; // Simulate a slow initial dump.
                return { id: `backup-${create_calls++}`, timestamp: now };
            },
            delete: () => true,
        },
    });

    async function run_next_timer() {
        const [id, timer] = [...timers].sort((left, right) => left[1].due_at - right[1].due_at)[0];
        timers.delete(id);
        now = timer.due_at;
        await timer.callback();
    }

    await run_next_timer();
    assert.equal(create_calls, 1);
    assert.equal(now, day * 100 + minute * 2);

    await run_next_timer();
    assert.equal(now, day * 100 + minute * 2 + hour);
    assert.equal(create_calls, 2);

    backups.destroy();
    active_backups.delete(backups);
});

test('retains 24 hourly slots and 30 daily slots as backups age', async () => {
    let now = day * 100 + hour * 15 + minute * 34;
    let create_calls = 0;
    Date.now = () => now;

    const backups = create_simple_backups({
        windows: [
            { interval_ms: hour, limit: 24 },
            { interval_ms: day, limit: 30 },
        ],
        adapters: {
            list: () => [],
            create: () => ({ id: `backup-${create_calls++}`, timestamp: now }),
            delete: () => true,
        },
    });

    await backups.__tick();
    for (let i = 1; i <= 31 * 24; i++) {
        now += hour;
        await backups.__tick();
    }

    const expected_timestamps = new Set();
    for (let i = 0; i < 24; i++) expected_timestamps.add(now - i * hour);
    const current_day_start = Math.floor(now / day) * day;
    for (let i = 0; i < 30; i++) expected_timestamps.add(current_day_start - i * day + minute * 34);

    assert.equal(create_calls, 31 * 24 + 1);
    assert.equal(backups.backups.length, 53); // One recent backup satisfies both the hourly and daily windows
    assert.deepEqual(
        backups.backups.map((backup) => backup.timestamp),
        [...expected_timestamps].sort((a, b) => a - b),
    );
});

test('keeps failed deletions cached and retries them on the next tick', async () => {
    const now = day * 100;
    const stale_backup = { id: 'stale', timestamp: now - hour };
    const current_backup = { id: 'current', timestamp: now };
    const delete_attempts = [];
    const deleted_backups = [];
    Date.now = () => now;

    const backups = create_simple_backups({
        windows: [{ interval_ms: hour, limit: 1 }],
        adapters: {
            list: () => [stale_backup, current_backup],
            create: () => {
                throw new Error('A current backup already exists.');
            },
            delete: (backup) => {
                delete_attempts.push(backup);
                return delete_attempts.length > 1;
            },
        },
    });
    backups.on('delete', (backup) => deleted_backups.push(backup));

    await backups.__tick();
    assert.deepEqual(backups.backups, [stale_backup, current_backup]);
    assert.equal(deleted_backups.length, 0);

    await backups.__tick();
    assert.deepEqual(backups.backups, [current_backup]);
    assert.deepEqual(deleted_backups, [stale_backup]);
    assert.equal(delete_attempts.length, 2);
});

test('emits adapter errors and retries initialization on a later tick', async () => {
    const now = day * 100;
    const adapter_error = new Error('Storage is temporarily unavailable.');
    const emitted_errors = [];
    let list_calls = 0;
    let create_calls = 0;
    Date.now = () => now;

    const backups = create_simple_backups({
        windows: [{ interval_ms: hour, limit: 1 }],
        adapters: {
            list: () => {
                list_calls++;
                if (list_calls === 1) throw adapter_error;
                return [];
            },
            create: () => ({ id: `backup-${create_calls++}`, timestamp: now }),
            delete: () => true,
        },
    });
    backups.on('error', (error) => emitted_errors.push(error));

    await backups.__tick();
    assert.deepEqual(emitted_errors, [adapter_error]);
    assert.equal(create_calls, 0);

    await backups.__tick();
    assert.equal(list_calls, 2);
    assert.equal(create_calls, 1);
    assert.equal(backups.backups.length, 1);
});

test('destroy stops future ticks and removes event listeners', async () => {
    let list_calls = 0;
    const backups = create_simple_backups({
        windows: [{ interval_ms: hour, limit: 1 }],
        adapters: {
            list: () => {
                list_calls++;
                return [];
            },
            create: () => ({ id: 'backup', timestamp: Date.now() }),
            delete: () => true,
        },
    });
    backups.on('create', () => {});

    backups.destroy();
    await backups.__tick();

    assert.equal(backups.destroyed, true);
    assert.equal(backups.listenerCount('create'), 0);
    assert.equal(list_calls, 0);
});
