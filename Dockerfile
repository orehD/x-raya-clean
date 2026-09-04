FROM node:20-alpine
WORKDIR /app
# Копируем весь репозиторий: кроме server.js и index.html нужны страницы help/stats/privacy,
# шрифты, справочники candy-kb и движок candy-json. Лишнее отсекает .dockerignore.
# Зависимостей нет, npm install не требуется.
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
