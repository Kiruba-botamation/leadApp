import test from 'node:test';
import assert from 'node:assert/strict';
import { calcPreReminderDate } from '../queue/reminderQueue.js';
import { calculatePreScheduledAt } from '../services/reminderService.js';

test('pre-reminder due time is materialized consistently', () => {
    const scheduledAt = new Date('2026-08-26T12:00:00.000Z');
    const expected = '2026-08-26T10:00:00.000Z';

    assert.equal(calcPreReminderDate(scheduledAt, 2, 'hours').toISOString(), expected);
    assert.equal(calculatePreScheduledAt(scheduledAt, true, 2, 'hours').toISOString(), expected);
    assert.equal(calculatePreScheduledAt(scheduledAt, false, 2, 'hours'), null);
});
