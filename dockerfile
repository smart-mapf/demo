# Start with the official Bun image
FROM oven/bun:debian

# Install make and build essentials
RUN apt-get update && apt-get install -y build-essential qtbase5-dev

# Verify make is installed
RUN make --version

# Set the working directory inside the container
WORKDIR /app

# Copy package.json
COPY package.json bun.lock ./

COPY smart/package.json smart/bun.lock ./smart/
COPY smart-service/package.json smart-service/bun.lock ./smart/

# Install dependencies
RUN bun install

# Copy all files
COPY . .

WORKDIR /app/smart

RUN sh build.sh

# ──────────────────────────────────────────────────────────────────────────────

ENV PORT=80

EXPOSE 80

WORKDIR /app/smart-service

# Define the command to start your app
CMD ["bun", "start"]
