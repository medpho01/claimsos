FROM node:22-alpine

RUN apk add --no-cache ghostscript

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 8000

CMD ["npm", "start"]
