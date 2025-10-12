# Debug Checklist for Meme Replicator

## Issues Fixed

### 1. Added Console Logging
- Added detailed console.log statements in `loadMemes()` function
- Added logging in `renderMemes()` function
- These will help you see exactly what's happening in the browser console

### 2. Updated wrangler.toml
- Fixed `FROM_EMAIL` to use a proper email format
- Added comments about setting up Resend API key
- Added note about using `onboarding@resend.dev` for testing

### 3. Improved Error Handling
- Added null check for memes array in renderMemes
- Better error logging throughout

## Next Steps to Debug

### 1. Open Browser Developer Tools
Press F12 or right-click > Inspect, then go to the Console tab

### 2. Refresh the Page
You should see these console messages:
```
Fetching memes from /api/memes...
Response status: 200
Received memes data: [...]
Number of memes: X
renderMemes called, memes count: X
Rendering memes...
Added meme to DOM: ...
Finished rendering X memes
```

### 3. Check for Issues

#### If you see "Response status: 200" but "Number of memes: 0":
- Your database might be empty
- Run the schema.sql to populate sample data:
  ```bash
  wrangler d1 execute meme-replicator --file=schema.sql
  ```

#### If you see errors about fetch failing:
- Make sure your worker is running: `wrangler dev`
- Check the Network tab in dev tools for the actual error

#### If memes load but don't display:
- Check for JavaScript errors in the Console
- Look for CSS issues hiding the content

### 4. Email Authentication Setup

The email feature won't work until you:

1. **Get a Resend API key**:
   - Sign up at https://resend.com
   - Get your API key from the dashboard

2. **Set the API key as a secret**:
   ```bash
   wrangler secret put RESEND_API_KEY
   ```
   Then paste your API key when prompted

3. **Verify your domain** (for production):
   - In Resend dashboard, add and verify your domain
   - Update `FROM_EMAIL` in wrangler.toml to use your verified domain

4. **For testing, use Resend's test email**:
   - Change `FROM_EMAIL` to `"onboarding@resend.dev"`
   - This works without domain verification

### 5. Database Setup

Make sure your database is initialized:

```bash
# Apply main schema
wrangler d1 execute meme-replicator --file=schema.sql

# Apply auth schema
wrangler d1 execute meme-replicator --file=schema-auth.sql
```

### 6. Test the API Directly

```bash
# Test if memes endpoint works
curl http://localhost:8787/api/memes

# Or if deployed:
curl https://meme-replicator.oliverpartridge.workers.dev/api/memes
```

## Common Issues

### Issue: "No memes yet" message appears
**Cause**: Database is empty or query is failing
**Solution**: 
1. Check browser console for errors
2. Reinitialize database with sample data
3. Check if D1 binding is correct in wrangler.toml

### Issue: Memes don't load at all
**Cause**: JavaScript error or fetch failing
**Solution**:
1. Check browser console for errors
2. Check Network tab for failed requests
3. Make sure worker is running

### Issue: Can't login
**Cause**: Email service not configured
**Solution**:
1. Set RESEND_API_KEY secret
2. Use test email: `onboarding@resend.dev`
3. Check Resend dashboard for delivery status

### Issue: Login link doesn't work
**Cause**: Token expired or already used
**Solution**:
1. Request a new login link
2. Check that SITE_URL matches your actual URL
3. Tokens expire after 15 minutes

## Deployment Commands

```bash
# Run locally for testing
wrangler dev

# Deploy to Cloudflare Workers
wrangler deploy

# Check logs
wrangler tail

# Execute SQL migrations
wrangler d1 execute meme-replicator --file=schema.sql
wrangler d1 execute meme-replicator --file=schema-auth.sql
```
