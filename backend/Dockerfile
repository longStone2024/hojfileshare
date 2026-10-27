FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 3000
CMD ["node", "src/index.js"]