const { EventEmitter } = require('events');
const { emitter, EVENTS } = require('./events');

class RateLimitManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = config;
        this.state = {
            windows: new Map(),
            queue: [],
            isProcessing: false,
            batchState: {
                lastBatchTime: 0,
                retryCount: new Map()
            }
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

    getEndpointLimits(endpoint) {
        return this.config.endpoints?.[endpoint] || this.config.defaultLimit;
    }

    getOrCreateWindow(endpoint) {
        if (!this.state.windows.has(endpoint)) {
            this.state.windows.set(endpoint, {
                startTime: Date.now(),
                requestCount: 0
            });
        }
        return this.state.windows.get(endpoint);
    }

    resetWindow(endpoint) {
        this.state.windows.set(endpoint, {
            startTime: Date.now(),
            requestCount: 0
        });
        this.emit('debug', `Rate limit window reset for ${endpoint}`);
        emitter.emit(EVENTS.RATE_LIMIT_RESET);
    }

    async scheduleRequest(requestFn, endpoint = 'default') {
        return new Promise(async (resolve, reject) => {
            try {
                const limits = this.getEndpointLimits(endpoint);
                const window = this.getOrCreateWindow(endpoint);

                // Check if this is a batch request
                const isBatchEndpoint = endpoint === 'tweets/search/recent';
                if (isBatchEndpoint) {
                    await this.handleBatchRequest(requestFn, limits, window, resolve, reject);
                    return;
                }

                // Standard request handling
                const now = Date.now();
                const windowSize = limits.windowSizeMinutes * 60 * 1000;
                if (now - window.startTime >= windowSize) {
                    this.resetWindow(endpoint);
                }

                // Check if we're within rate limits
                const safeLimit = Math.floor(limits.requestsPerWindow * this.config.safetyMargin);
                if (window.requestCount >= safeLimit) {
                    const waitTime = windowSize - (now - window.startTime);
                    this.emit('debug', `Rate limit approaching for ${endpoint}, waiting ${waitTime}ms`);
                    emitter.emit(EVENTS.RATE_LIMIT_WARNING, { waitTime, endpoint });
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    this.resetWindow(endpoint);
                }

                // Execute the request
                window.requestCount++;
                this.emit('debug', `Executing request for ${endpoint} (${window.requestCount}/${safeLimit})`);
                emitter.emit(EVENTS.REQUEST_SCHEDULED, { endpoint });
                
                const result = await requestFn();
                this.emit('debug', `Request completed for ${endpoint}`);
                emitter.emit(EVENTS.REQUEST_COMPLETED, { endpoint });
                resolve(result);
        } catch (error) {
                this.handleRequestError(error, endpoint, reject);
            }
        });
    }

    async handleBatchRequest(requestFn, limits, window, resolve, reject) {
        try {
            const now = Date.now();
            const { minIntervalMs } = this.config.batchConfig;
            
            // Enforce minimum interval between batches
            const timeSinceLastBatch = now - this.state.batchState.lastBatchTime;
            if (timeSinceLastBatch < minIntervalMs) {
                const waitTime = minIntervalMs - timeSinceLastBatch;
                this.emit('debug', `Enforcing batch interval, waiting ${waitTime}ms`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }

            // Check and reset window if needed
            const windowSize = limits.windowSizeMinutes * 60 * 1000;
            if (now - window.startTime >= windowSize) {
                this.resetWindow('tweets/search/recent');
            }

            // Check rate limits with aggressive safety margin
            const safeLimit = Math.floor(limits.requestsPerWindow * this.config.safetyMargin);
            if (window.requestCount >= safeLimit) {
                const waitTime = windowSize - (now - window.startTime);
                this.emit('debug', `Batch rate limit approaching, waiting ${waitTime}ms`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                this.resetWindow('tweets/search/recent');
            }

            // Execute batch request
            window.requestCount++;
            this.state.batchState.lastBatchTime = Date.now();
            const result = await requestFn();
            resolve(result);

        } catch (error) {
            const retryCount = this.state.batchState.retryCount.get(window.startTime) || 0;
            
            if (error.code === 'RATE_LIMIT' && retryCount < this.config.batchConfig.maxRetries) {
                this.state.batchState.retryCount.set(window.startTime, retryCount + 1);
                this.emit('debug', `Retrying batch request (attempt ${retryCount + 1}/${this.config.batchConfig.maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, this.config.batchConfig.retryDelayMs));
                await this.handleBatchRequest(requestFn, limits, window, resolve, reject);
            } else {
                this.handleRequestError(error, 'tweets/search/recent', reject);
            }
        }
    }

    handleRequestError(error, endpoint, reject) {
        this.emit('debug', `Request failed for ${endpoint}: ${error.message}`);
        this.emit('debug', `Error details: ${JSON.stringify(error, null, 2)}`);
        
        const isTwitterRateLimit = 
            (error.data?.errors?.some(e => e.code === 88)) ||
            (error.rateLimit?.remaining === 0) ||
            (error.code === 429 && 
             error.data?.errors?.some(e => 
                e.message?.toLowerCase().includes('rate limit') ||
                e.message?.toLowerCase().includes('too many requests')
             ));

        if (isTwitterRateLimit) {
            this.emit('debug', `Twitter rate limit hit for ${endpoint}, resetting window`);
            emitter.emit(EVENTS.RATE_LIMIT_EXCEEDED, { endpoint });
            this.resetWindow(endpoint);
            
            const rateError = new Error('Twitter API rate limit exceeded');
            rateError.code = 'RATE_LIMIT';
            rateError.endpoint = endpoint;
            rateError.resetTime = error.rateLimit?.reset;
            reject(rateError);
        } else {
            this.emit('debug', `Non-rate-limit error for ${endpoint}: ${error.message}`);
            emitter.emit(EVENTS.REQUEST_FAILED, { error, endpoint });
            reject(error);
        }
    }
}

module.exports = RateLimitManager; 