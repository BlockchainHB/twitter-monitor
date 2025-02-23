const MonitoringValidation = require('./monitoring');
const RateLimitValidation = require('./rateLimit');
const DatabaseValidation = require('./database');

/**
 * System event validation schemas
 */
const SystemValidation = {
    ERROR: {
        required: ['error', 'context'],
        properties: {
            error: {
                type: 'object',
                required: ['message'],
                properties: {
                    message: { type: 'string' },
                    name: { type: 'string' },
                    code: { type: 'string' },
                    type: { type: 'string' }
                }
            },
            context: {
                type: 'object',
                properties: {
                    eventType: { type: 'string' },
                    timestamp: { type: 'number' }
                }
            },
            severity: { type: 'string' },
            correlationId: { type: 'string' }
        }
    }
};

/**
 * Validation schemas for all event types
 */
const EventValidation = {
    MONITORING: MonitoringValidation,
    RATE_LIMIT: RateLimitValidation,
    DATABASE: DatabaseValidation,
    SYSTEM: SystemValidation
};

/**
 * Validates event payload against its schema
 * @param {string} eventType - Event type from EventTypes
 * @param {Object} payload - Event payload to validate
 * @returns {boolean} - Whether the payload is valid
 * @throws {Error} - If validation fails
 */
function validateEventPayload(eventType, payload) {
    // Skip validation for error events
    if (eventType === 'error') {
        return true;
    }

    // Extract category and type from event type
    const [category, ...typeParts] = eventType.split('.');
    const type = typeParts.join('_');

    // Debug logging
    console.debug('Validating event:', {
        eventType,
        category: category.toUpperCase(),
        type: type.toUpperCase(),
        availableSchemas: Object.keys(EventValidation),
        availableTypes: Object.keys(EventValidation[category.toUpperCase()] || {})
    });
    
    // Get validation schema
    const schema = EventValidation[category.toUpperCase()]?.[type.toUpperCase()];
    if (!schema) {
        throw new Error(`No validation schema found for event type: ${eventType}`);
    }

    // Check required fields
    for (const field of schema.required) {
        if (!(field in payload)) {
            throw new Error(`Missing required field: ${field}`);
        }
    }

    // Validate properties
    for (const [key, value] of Object.entries(payload)) {
        const propertySchema = schema.properties[key];
        if (!propertySchema) continue; // Skip validation for extra properties

        // Type validation
        if (propertySchema.type === 'string' && typeof value !== 'string') {
            throw new Error(`Invalid type for ${key}: expected string`);
        }
        if (propertySchema.type === 'number' && typeof value !== 'number') {
            throw new Error(`Invalid type for ${key}: expected number`);
        }
        if (propertySchema.type === 'boolean' && typeof value !== 'boolean') {
            throw new Error(`Invalid type for ${key}: expected boolean`);
        }
        if (propertySchema.type === 'object' && (typeof value !== 'object' || value === null)) {
            throw new Error(`Invalid type for ${key}: expected object`);
        }
        if (propertySchema.type === 'array' && !Array.isArray(value)) {
            throw new Error(`Invalid type for ${key}: expected array`);
        }

        // Enum validation
        if (propertySchema.enum && !propertySchema.enum.includes(value)) {
            throw new Error(`Invalid value for ${key}: must be one of ${propertySchema.enum.join(', ')}`);
        }

        // Format validation
        if (propertySchema.format === 'date-time') {
            const date = new Date(value);
            if (isNaN(date.getTime())) {
                throw new Error(`Invalid date-time format for ${key}`);
            }
        }
    }

    return true;
}

module.exports = {
    EventValidation,
    validateEventPayload
}; 