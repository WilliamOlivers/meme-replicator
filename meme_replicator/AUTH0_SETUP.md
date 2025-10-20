# Auth0 Passwordless Setup

## 1. Create Auth0 Account
- Sign up at https://auth0.com
- Create a new application (Single Page Application)

## 2. Get Your Credentials
In Auth0 dashboard:
- Go to Settings > Basic Information
- Copy: **Domain** (e.g., `your-tenant.eu.auth0.com`)
- Copy: **Client ID**

## 3. Configure Auth0 Application
- **Allowed Callback URLs**: `https://meme-replicator.oliverpartridge.workers.dev/auth/callback`
- **Allowed Logout URLs**: `https://meme-replicator.oliverpartridge.workers.dev/`

## 4. Enable Passwordless Email
- Go to **Connections > Passwordless > Email**
- Enable it
- In the email template, make sure the body references the one-time code (e.g. `{{code}}`) so users know what to enter in the app

## 5. Allow OTP Grant Type
- In your Auth0 application, open **Advanced Settings → Grant Types**
- Enable **Passwordless OTP (email)** so the Worker can exchange codes for tokens

## 6. Update wrangler.toml
```toml
[vars]
AUTH0_DOMAIN = "your-tenant.eu.auth0.com"
AUTH0_CLIENT_ID = "your_client_id_here"
```

## 7. Set Client Secret
```bash
npx wrangler secret put AUTH0_CLIENT_SECRET
# Paste your Client Secret when prompted
```

## 8. Deploy
```bash
npx wrangler deploy
```

Done! Users receive a one-time verification code from Auth0 and enter it in the app to finish signing in.
