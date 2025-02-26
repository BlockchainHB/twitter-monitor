const path = require('path');
// Load environment variables from the correct path
require('dotenv').config({
    path: path.join(__dirname, '../../.env')
});

const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');  // Use regular fs for sync operations
const fsPromises = require('fs').promises;  // Use promises for async operations

// Load config from the main config file
const config = require('../config/config');

class WebhookConfigurator {
    constructor() {
        console.log('\n🚀 Starting webhook configuration...');
        
        // Load config directly to avoid env issues
        this.apiKey = '616882e3-f3c1-47bc-b57f-0858c6bef448';
        this.webhookUrl = 'https://heliusrailways-production.up.railway.app/api/wallet-webhook';
        this.baseUrl = 'https://api.helius.xyz/v0';
        this.walletsPath = path.join(__dirname, '../config/wallets.json');

        console.log('\nConfiguration:');
        console.log('Wallets file:', this.walletsPath);
        console.log('Webhook URL:', this.webhookUrl);
        console.log('API Key:', this.apiKey ? '✓ Set' : '✗ Missing');
    }

    async loadWalletsFromJson() {
        try {
            console.log('\n📝 Loading wallets from JSON file...');
            const data = fs.readFileSync(this.walletsPath, 'utf8');
            const jsonData = JSON.parse(data);
            
            // Extract wallets array from the JSON structure
            const wallets = jsonData.wallets || [];
            
            if (wallets.length === 0) {
                throw new Error('No wallets found in wallets.json');
            }

            console.log(`✅ Found ${wallets.length} wallets in JSON file`);
            
            // Validate wallet format
            const invalidWallets = wallets.filter(w => !w.address || !w.name);
            if (invalidWallets.length > 0) {
                console.warn(`⚠️ Found ${invalidWallets.length} invalid wallet entries`);
            }

            // Log first few wallets as sample
            console.log('\nSample wallets:');
            wallets.slice(0, 3).forEach(w => {
                console.log(`- ${w.name}: ${w.address}`);
            });
            console.log('...');

            return wallets;
        } catch (error) {
            console.error('❌ Failed to load wallets from JSON:', error.message);
            throw error;
        }
    }

    async getCurrentWebhook() {
        try {
            console.log('\n🔍 Checking existing webhooks...');
            const response = await axios.get(`${this.baseUrl}/webhooks?api-key=${this.apiKey}`);
            const webhooks = response.data || [];
            
            // Find webhook matching our URL
            const webhook = webhooks.find(w => w.webhookURL === this.webhookUrl);
            if (webhook) {
                console.log('✅ Found existing webhook:', webhook.webhookID);
            } else {
                console.log('ℹ️ No existing webhook found for this URL');
            }
            return webhook;
        } catch (error) {
            console.error('❌ Failed to list webhooks:', error.response?.data || error.message);
            throw error;
        }
    }

    async updateWebhook(webhookId, wallets) {
        try {
            console.log('\n📡 Updating webhook configuration...');
            
            // Extract just the addresses from wallets
            const addresses = wallets.map(w => w.address);
            console.log(`Configuring ${addresses.length} wallet addresses...`);

            const payload = {
                webhookURL: this.webhookUrl,
                accountAddresses: addresses,
                transactionTypes: ['SWAP', 'TRANSFER'],
                webhookType: 'enhanced',
                encoding: 'jsonParsed'
            };

            console.log('First few addresses being configured:');
            addresses.slice(0, 3).forEach(addr => console.log(`- ${addr}`));
            console.log('...');

            const response = await axios.put(
                `${this.baseUrl}/webhooks/${webhookId}?api-key=${this.apiKey}`,
                payload
            );

            if (!response.data || !response.data.webhookID) {
                throw new Error('Invalid response from Helius API');
            }

            console.log('✅ Successfully updated webhook configuration');
            return response.data;
        } catch (error) {
            console.error('❌ Failed to update webhook:', error.response?.data || error.message);
            throw error;
        }
    }

    async createWebhook(wallets) {
        try {
            console.log('\n🆕 Creating new webhook...');
            
            // Extract just the addresses from wallets
            const addresses = wallets.map(w => w.address);
            console.log(`Configuring ${addresses.length} wallet addresses...`);

            const payload = {
                webhookURL: this.webhookUrl,
                accountAddresses: addresses,
                transactionTypes: ['SWAP', 'TRANSFER'],
                webhookType: 'enhanced',
                encoding: 'jsonParsed'
            };

            console.log('First few addresses being configured:');
            addresses.slice(0, 3).forEach(addr => console.log(`- ${addr}`));
            console.log('...');

            const response = await axios.post(
                `${this.baseUrl}/webhooks?api-key=${this.apiKey}`,
                payload
            );

            if (!response.data || !response.data.webhookID) {
                throw new Error('Invalid response from Helius API');
            }

            console.log('✅ Successfully created new webhook');
            return response.data;
        } catch (error) {
            console.error('❌ Failed to create webhook:', error.response?.data || error.message);
            throw error;
        }
    }

    async configure() {
        try {
            // 1. Load wallets from JSON
            const wallets = await this.loadWalletsFromJson();
            if (!wallets.length) {
                throw new Error('No wallets found in JSON file');
            }

            // Log total unique addresses
            const uniqueAddresses = new Set(wallets.map(w => w.address));
            console.log(`Found ${uniqueAddresses.size} unique wallet addresses`);
            if (uniqueAddresses.size !== wallets.length) {
                console.warn(`⚠️ Note: ${wallets.length - uniqueAddresses.size} duplicate addresses found`);
            }

            // 2. Get current webhook status
            const existingWebhook = await this.getCurrentWebhook();

            // 3. Update or create webhook
            let webhook;
            if (existingWebhook) {
                webhook = await this.updateWebhook(existingWebhook.webhookID, wallets);
            } else {
                webhook = await this.createWebhook(wallets);
            }

            console.log('\n✅ Webhook configuration complete!');
            console.log('Webhook ID:', webhook.webhookID);
            console.log('Monitoring addresses:', uniqueAddresses.size);
            
        } catch (error) {
            console.error('\n❌ Configuration failed:', error);
            throw error;
        }
    }
}

// Run configuration if called directly
if (require.main === module) {
    const configurator = new WebhookConfigurator();
    configurator.configure()
        .then(() => {
            console.log('\n✅ Configuration completed successfully');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n❌ Fatal error:', error);
            process.exit(1);
        });
}

module.exports = WebhookConfigurator; 