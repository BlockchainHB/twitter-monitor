const sqlite3 = require('sqlite3').verbose();

// Simple in-memory database configuration
const config = {
    dialect: 'sqlite',
    storage: ':memory:',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    define: {
        timestamps: true,
        underscored: true
    },
    dialectOptions: {
        foreignKeys: true
    },
    pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000
    }
};

module.exports = config;