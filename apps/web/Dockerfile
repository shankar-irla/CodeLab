FROM node:24-alpine

WORKDIR /app
COPY package.json ./package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm install --workspace apps/web
COPY apps/web ./apps/web

EXPOSE 5173
CMD ["npm", "run", "dev", "--workspace", "apps/web", "--", "--host", "0.0.0.0"]
