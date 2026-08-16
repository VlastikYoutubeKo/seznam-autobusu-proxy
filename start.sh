#!/bin/bash

# Seznam-autobusu.cz Proxy - Quick Start Script
# This script helps you quickly start the proxy server

echo "================================================"
echo "Seznam-autobusu.cz Proxy - Quick Start"
echo "================================================"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Creating from .env.example..."
    cp .env.example .env
    echo "✅ Created .env file. Please edit it with your configuration:"
    echo "   nano .env"
    echo ""
    read -p "Press Enter to continue after editing .env, or Ctrl+C to exit..."
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed."
    echo "   Please install Node.js 18+ first:"
    echo "   https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js version: $(node -v)"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed."
    exit 1
fi

echo "✅ npm version: $(npm -v)"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install dependencies."
        exit 1
    fi
    echo "✅ Dependencies installed successfully."
    echo ""
fi

# Ask user how to start
echo "How would you like to start the server?"
echo "1) Production mode (node server.js)"
echo "2) Development mode (nodemon with auto-reload)"
echo "3) Docker (docker-compose)"
echo ""
read -p "Enter choice [1-3]: " choice

case $choice in
    1)
        echo ""
        echo "🚀 Starting in production mode..."
        echo "================================================"
        node server.js
        ;;
    2)
        echo ""
        echo "🛠️  Starting in development mode..."
        echo "================================================"
        npm run dev
        ;;
    3)
        # Check if docker is installed
        if ! command -v docker &> /dev/null; then
            echo "❌ Docker is not installed."
            echo "   Please install Docker first:"
            echo "   https://docs.docker.com/get-docker/"
            exit 1
        fi

        if ! command -v docker-compose &> /dev/null; then
            echo "❌ Docker Compose is not installed."
            exit 1
        fi

        echo ""
        echo "🐳 Starting with Docker..."
        echo "================================================"
        docker-compose up -d
        echo ""
        echo "✅ Docker container started!"
        echo "   View logs: docker-compose logs -f"
        echo "   Stop: docker-compose down"
        ;;
    *)
        echo "❌ Invalid choice."
        exit 1
        ;;
esac
