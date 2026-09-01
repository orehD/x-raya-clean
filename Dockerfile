FROM node:20-alpine
WORKDIR /app
# Копируем весь репозиторий: кроме server.js и index.html приложению нужны
# help/stats/privacy/cabinet, шрифты, api/ и candy-prompt.md (схема подборок Candy).
# Лишнее отсекает .dockerignore. Зависимостей нет — npm install не нужен.
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
