FROM node:22-alpine
RUN apk add --no-cache unzip
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
ENTRYPOINT ["node", "src/import.js"]
