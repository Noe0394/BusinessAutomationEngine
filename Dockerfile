FROM node:18-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 10000

CMD ["npm", "start"]
