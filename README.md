# Webnovel Translator 2.0

Architecture:
iPhone/PC -> Render Web Service -> Supabase PostgreSQL + Gemini API

## Local
1. Copy `.env.example` to `.env`.
2. Fill Gemini and Supabase credentials.
3. Run `npm install`.
4. Run `npm run dev`.
5. Open http://localhost:3000.

## Supabase
Create a project, open SQL Editor, run `supabase.sql`, then put the project URL and Service Role key into `.env`.
Never expose the Service Role key in frontend code or GitHub.

## New database/account later
Create a new Supabase project/account, run the same `supabase.sql`, replace SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the Render environment variables, redeploy, then use the app's Export/Import backup tools to move novels if desired.

## Important
Render free filesystem is not the database. All important cloud data goes to Supabase.
