module.exports = {
    // The root directory that Jest should scan for tests and modules
    rootDir: '.',

    // The test environment that will be used for testing
    testEnvironment: 'node',

    // The glob patterns Jest uses to detect test files
    testMatch: [
        '**/tests/**/*.test.js'
    ],

    // Setup files to run before each test
    setupFilesAfterEnv: ['<rootDir>/src/tests/setup.js'],

    // An array of regexp pattern strings that are matched against all test paths
    testPathIgnorePatterns: ['/node_modules/'],

    // Automatically clear mock calls and instances between every test
    clearMocks: true,

    // Indicates whether the coverage information should be collected while executing the test
    collectCoverage: false,

    // The directory where Jest should output its coverage files
    coverageDirectory: 'coverage',

    // Indicates which provider should be used to instrument code for coverage
    coverageProvider: 'v8',

    // A list of paths to directories that Jest should use to search for files in
    roots: ['<rootDir>/src'],

    // The maximum amount of workers used to run your tests
    maxWorkers: 1
}; 