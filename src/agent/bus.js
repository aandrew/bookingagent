'use strict';

// v4: in-process event bus for SSE push updates.
//
// Design notes:
//   - The bus is a single-process EventEmitter — there's no Redis/AMQP/etc
//     because the agent is a single Node process. emit() and subscribe()
//     are synchronous, in-memory, microsecond-fast.
//   - Subscribers are *live* handles (a { write, dead, buffer } triple),
//     not just plain callbacks. The SSE handler wraps each EventSource
//     connection in a Subscriber and uses write() to push events to the
//     HTTP response. If write() throws (client gone, slow client, etc.),
//     the subscriber is marked dead and cleaned up on the next emit().
//   - Slow-subscriber handling: each subscriber has a small bounded buffer
//     (default 100 events). If the buffer fills (the client can't keep up
//     with the heartbeat + events), we drop the OLDEST event for that
//     subscriber (with a `droppedEvents` counter on the subscriber so
//     operators can see the damage). We don't block the bus waiting for
//     a slow client — that would freeze every other subscriber too.
//   - emit() NEVER throws to the caller. A misbehaving subscriber can't
//     crash the bus. The error is logged and the subscriber is marked
//     dead so it's cleaned up on the next emit().
//
// This module exports a singleton `bus`. Tests can use `bus.reset()` to
// clear subscribers between cases.

const { EventEmitter } = require('events');
const log = require('../logger');

const DEFAULT_BUFFER_SIZE = 100;

class Bus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0); // we manage subscriptions ourselves
    this._subscribers = new Set();
  }

  /**
   * Subscribe a live subscriber. Returns an unsubscribe function.
   * The subscriber must expose:
   *   - write(eventName, payload): async-safe; throws on failure
   *   - dead: boolean flag, set by the bus when the subscriber is bad
   *   - buffer: array used for buffered events (or undefined to skip buffering)
   *   - droppedEvents: number, incremented when we drop an event
   */
  subscribe(subscriber) {
    this._subscribers.add(subscriber);
    return () => this._subscribers.delete(subscriber);
  }

  /**
   * Emit an event. Fan out to all live subscribers. Dead subscribers
   * (subscriber.dead === true or write() throws) are removed.
   * Never throws.
   */
  emit(eventName, payload) {
    const data = safeStringify(payload);
    for (const sub of [...this._subscribers]) {
      this._deliver(sub, eventName, data);
    }
  }

  _deliver(sub, eventName, data) {
    if (sub.dead) {
      this._subscribers.delete(sub);
      return;
    }
    // Buffer if the subscriber has a buffer and it has accumulated events
    if (sub.buffer && sub.buffer.length >= DEFAULT_BUFFER_SIZE) {
      sub.buffer.shift(); // drop oldest
      sub.droppedEvents = (sub.droppedEvents || 0) + 1;
    }
    try {
      sub.write(eventName, data);
    } catch (e) {
      // Subscriber is broken — mark dead and clean up on next emit.
      sub.dead = true;
      try { if (typeof sub.close === 'function') sub.close(); } catch {}
      this._subscribers.delete(sub);
      log.warn('bus.subscriber.dead', { event: eventName, error: e.message });
    }
  }

  /**
   * Snapshot of subscriber count + total dropped events (for /api/bus-stats).
   */
  stats() {
    let dropped = 0;
    for (const sub of this._subscribers) {
      dropped += sub.droppedEvents || 0;
    }
    return {
      subscribers: this._subscribers.size,
      droppedEvents: dropped,
    };
  }

  /**
   * Test helper: drop all subscribers and clear internal state.
   */
  reset() {
    for (const sub of this._subscribers) {
      try { if (typeof sub.close === 'function') sub.close(); } catch {}
    }
    this._subscribers.clear();
  }
}

function safeStringify(payload) {
  try {
    return JSON.stringify(payload);
  } catch (e) {
    return JSON.stringify({ error: 'bus.safeStringify.failed', message: e.message });
  }
}

const bus = new Bus();

module.exports = bus;
module.exports.Bus = Bus;
module.exports.DEFAULT_BUFFER_SIZE = DEFAULT_BUFFER_SIZE;
