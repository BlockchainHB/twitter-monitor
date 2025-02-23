module.exports = {
    apps: [{
        name: 'twitter-monitor',
        script: 'src/scripts/deploy.js',
        watch: false,
        instances: 1,
        autorestart: true,
        max_memory_restart: '1G',
        env_production: {
            NODE_ENV: 'production',
            LOG_LEVEL: 'info'
        },
        error_file: 'logs/pm2_error.log',
        out_file: 'logs/pm2_out.log',
        log_file: 'logs/pm2_combined.log',
        time: true,
        merge_logs: true,
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
        // Basic tier rate limit settings
        env: {
            TWITTER_RATE_LIMIT_WINDOW: '900',  // 15 minutes in seconds
            TWITTER_RATE_LIMIT_REQUESTS: '180', // Requests per window
            TWITTER_MONTHLY_READ_LIMIT: '10000' // Basic tier monthly read limit
        }
    }]
}; 