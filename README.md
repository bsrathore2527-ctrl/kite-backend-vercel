#new changes# Kite backend on Vercel

## Deploy
1. Create a GitHub repo and add these files.
2. Import the repo into Vercel (New Project → Import Git Repository).
3. Set Environment Variables as shown in this README.
4. Add the **Redirect URL** in your Kite developer console to `https://<your-domain>/api/callback`.
5. Open `https://<your-domain>/api/login` to start auth.

## Using from your frontend (fetch example)
```js
fetch("https://<your-domain>/api/funds", { credentials: "include" })
  .then(r => r.json())
  .then(console.log)
###
