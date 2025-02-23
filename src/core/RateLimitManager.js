const { EventEmitter } = require('events');
const { emitter, EVENTS } = require('./events');

class RateLimitManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.limits = {
            requestsPerWindow: config.requestsPerWindow || 180,
            windowSizeMinutes: config.windowSizeMinutes || 15,
            safetyMargin: config.safetyMargin || 0.9
        };

        this.state = {
            currentWindow: {
                startTime: Date.now(),
                requestCount: 0
            },
            queue: [],
            isProcessing: false
        };

        // Set higher max listeners limit
        this.setMaxListeners(50);

        // Initialize event handling
        this.setupEventHandlers();
    }

    setupEventHandlers() {
        emitter.on(EVENTS.RATE_LIMIT_EXCEEDED, () => {
            this.emit('debug', 'Rate limit exceeded, waiting for reset...');
            this.resetWindow();
        });
    }

    resetWindow() {
        this.state.currentWindow = {
            startTime: Date.now(),
            requestCount: 0
        };
        this.emit('debug', 'Rate limit window reset');
        emitter.emit(EVENTS.RATE_LIMIT_RESET);
    }

    async scheduleRequest(requestFn, endpoint = 'default') {
        return new Promise(async (resolve, reject) => {
            try {
                // Check if we need to reset the window
                const now = Date.now();
                const windowSize = this.limits.windowSizeMinutes * 60 * 1000;
                if (now - this.state.currentWindow.startTime >= windowSize) {
                    this.resetWindow();
                }

                // Check if we're within rate limits
                const safeLimit = Math.floor(this.limits.requestsPerWindow * this.limits.safetyMargin);
                if (this.state.currentWindow.requestCount >= safeLimit) {
                    const waitTime = windowSize - (now - this.state.currentWindow.startTime);
                    this.emit('debug', `Rate limit approaching for ${endpoint}, waiting ${waitTime}ms`);
                    emitter.emit(EVENTS.RATE_LIMIT_WARNING, { waitTime, endpoint });
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    this.resetWindow();
                }

                // Execute the request
                this.state.currentWindow.requestCount++;
                this.emit('debug', `Executing request for ${endpoint} (${this.state.currentWindow.requestCount}/${safeLimit})`);
                emitter.emit(EVENTS.REQUEST_SCHEDULED, { endpoint });
                
                const result = await requestFn();
                this.emit('debug', `Request completed for ${endpoint}`);
                emitter.emit(EVENTS.REQUEST_COMPLETED, { endpoint });
                resolve(result);
        } catch (error) {
                this.emit('debug', `Request failed for ${endpoint}: ${error.message}`);
                emitter.emit(EVENTS.REQUEST_FAILED, { error, endpoint });
                if (error.code === 429) { // Rate limit error
                    emitter.emit(EVENTS.RATE_LIMIT_EXCEEDED, { endpoint });
                    this.resetWindow();
                }
                reject(error);
            }
        });
    }
}

module.exports = RateLimitManager; 