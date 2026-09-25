# Secrets locaux

Pour le développement local, placer les clés fournisseur dans `providers.env`
avec une variable par ligne (`ANTHROPIC_API_KEY=...`, `GEMINI_API_KEY=...`).
Ce fichier est ignoré par Git et chargé avant le `.env` racine. Les variables
injectées par Render ont priorité sur les fichiers locaux et restent la
configuration de production.

Ne pas copier ici une clé dans la variable d'un autre fournisseur. La clé
commençant par `AQ.` est une clé Google Gemini; elle ne peut pas appeler
l'API Anthropic de Claude Haiku.
