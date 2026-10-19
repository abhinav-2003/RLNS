# ==============================================================================
# Production Dockerfile - RLNS Lease Billing Web Application
# Intranet & Local Network Production Deployment (Explicit 0.0.0.0 Binding)
# ==============================================================================
FROM node:22-slim

WORKDIR /app

# Install curl for container healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package definitions and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code, utilities, and static frontend assets
COPY split_pdf_by_page.js ./
COPY backend ./backend
COPY frontend ./frontend

# Create persistent storage directories
RUN mkdir -p /app/data /app/uploads /app/uploads/temp

# Production Environment Configuration
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5178
ENV ESTATE_BILLS_DIR=/app/uploads

# Expose production intranet port
EXPOSE 5178

# Container Healthcheck (verifies internal server responds properly on port 5178)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://127.0.0.1:5178/api/health || exit 1

# Launch internal server explicitly bound to 0.0.0.0:5178
CMD ["node", "backend/server.js"]
