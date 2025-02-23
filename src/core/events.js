const EventEmitter = require('events');

// Create event emitter instance
const eventEmitter = new EventEmitter();

// Event names
const EVENTS = {
    RATE_LIMIT_WARNING: 'rateLimitWarning',
    RATE_LIMIT_RESET: 'rateLimitReset',
    RATE_LIMIT_EXCEEDED: 'rateLimitExceeded',
    REQUEST_SCHEDULED: 'requestScheduled',
    REQUEST_COMPLETED: 'requestCompleted',
    REQUEST_FAILED: 'requestFailed'
};

module.exports = {
    emitter: eventEmitter,
    EVENTS
}; 