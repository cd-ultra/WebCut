FROM node:22-alpine

WORKDIR /app

# Install standard build dependencies for native node modules (like canvas or onnx if needed)
RUN apk add --no-cache python3 make g++ git

# Expose Vite's default dev server port
EXPOSE 5173

# Keep container alive and interactive for development
CMD ["sh"]
