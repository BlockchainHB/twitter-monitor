#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Starting Twitter Monitor Bot deployment...${NC}"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js is not installed. Please install Node.js first.${NC}"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2)
if [ "$(printf '%s\n' "14.0.0" "$NODE_VERSION" | sort -V | head -n1)" = "14.0.0" ]; then
    echo -e "${GREEN}Node.js version $NODE_VERSION detected${NC}"
else
    echo -e "${RED}Node.js version 14.0.0 or higher is required. Current version: $NODE_VERSION${NC}"
    exit 1
fi

# Check if .env file exists
if [ ! -f .env ]; then
    echo -e "${RED}.env file not found. Please create one based on .env.example${NC}"
    exit 1
fi

# Install dependencies
echo -e "${YELLOW}Installing dependencies...${NC}"
npm install
if [ $? -ne 0 ]; then
    echo -e "${RED}Failed to install dependencies${NC}"
    exit 1
fi

# Create necessary directories
mkdir -p logs data

# Set production environment
export NODE_ENV=production

# Run deployment script for verification
echo -e "${YELLOW}Running deployment verification...${NC}"
node src/scripts/deploy.js --verify
if [ $? -ne 0 ]; then
    echo -e "${RED}Deployment verification failed${NC}"
    exit 1
fi

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}Installing PM2...${NC}"
    npm install -g pm2
    if [ $? -ne 0 ]; then
        echo -e "${RED}Failed to install PM2${NC}"
        exit 1
    fi
fi

# Stop any existing instances
echo -e "${YELLOW}Stopping existing instances...${NC}"
pm2 stop twitter-monitor 2>/dev/null || true
pm2 delete twitter-monitor 2>/dev/null || true

# Start with PM2 ecosystem
echo -e "${YELLOW}Starting bot with PM2...${NC}"
pm2 start ecosystem.config.js --env production
if [ $? -ne 0 ]; then
    echo -e "${RED}Failed to start bot with PM2${NC}"
    exit 1
fi

# Save PM2 configuration
pm2 save

echo -e "${GREEN}Deployment complete!${NC}"
echo -e "${YELLOW}Monitoring commands:${NC}"
echo -e "  ${GREEN}pm2 logs twitter-monitor${NC} - View logs"
echo -e "  ${GREEN}pm2 monit${NC} - Monitor process"
echo -e "  ${GREEN}pm2 stop twitter-monitor${NC} - Stop bot"
echo -e "  ${GREEN}pm2 restart twitter-monitor${NC} - Restart bot" 