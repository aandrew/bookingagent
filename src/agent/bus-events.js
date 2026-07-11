'use strict';

// v4: event name constants for the SSE bus. Single source of truth —
// the SSE handler, the test suite, and the frontend all reference these.

module.exports = Object.freeze({
  ACCOUNT_UPDATED:      'account_updated',
  FIRE_EVENT_CREATED:   'fire_event_created',
  BOOKING_CREATED:      'booking_created',
  BOOKING_UPDATED:      'booking_updated',
  RECURRING_CREATED:    'recurring_created',
  RECURRING_UPDATED:    'recurring_updated',
  ERROR_APPEARED:       'error_appeared',
  ERROR_DISMISSED:      'error_dismissed',
  SCHEDULER_STATUS:     'scheduler_status',
});
