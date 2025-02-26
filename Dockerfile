FROM node:18.19-slim AS builder

# Install dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install dependencies using ci to respect package-lock.json
RUN npm ci

# Copy app source
COPY . .

# Start the bot
CMD ["npm", "start"] 