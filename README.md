# Up Closets dashboard

Dark dashboard for Up Closets of Rhode Island, mirroring Workiz.

- **Front end:** static site (`index.html`, `app.js`, `styles.css`), hosted on Vercel. No build step.
- **Data:** Supabase project `Up Closet`. Workiz data is copied in by Edge Functions every 10 minutes.
- **Workiz key:** stored only as the Supabase Edge Function secret `WORKIZ_API_KEY`. It is never in this repo.
- **Login:** Supabase Auth. Only emails in the `allowed_users` table can see data.

## What writes where
| Action | Goes to |
|---|---|
| Job costs, closet type, measurements, photos, crew rates | Dashboard only (Supabase) |
| New lead | Creates one new lead in Workiz (`booking-to-workiz` function) |
| Everything else | Read-only copy of Workiz |

Nothing in the dashboard edits or deletes existing Workiz records.

## Adding a user
In Supabase → SQL editor: `insert into allowed_users(email) values ('name@upclosets.com');`
