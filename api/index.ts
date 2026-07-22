// Vercel serverless entrypoint. Vercel only treats a ROOT `api/` directory as functions, so
// this thin file re-exports the real handler that lives with the API app. Everything is routed
// here by the catch-all rewrite in vercel.json, so the whole Fastify app is served on this
// deployment's domain. See apps/api/api/index.ts for the notes on the serverless model.
export { default } from '../apps/api/api/index.ts'
