# Meme Replicator

*"In the evolution of ideas, only the fittest survive"* - Inspired by Deutsch & Dawkins

A web application for testing and evolving ideas (memes) through community interaction, built with Cloudflare Workers and D1 Database.

## 🧬 Concept

Meme Replicator treats ideas as evolutionary organisms in a digital environment. Each "meme" (idea) has a fitness score that changes based on community interactions:

- **REFUTE (-15)**: Challenge flawed or incorrect ideas
- **REFINE (+10)**: Improve and make ideas more precise
- **PRAISE (+5)**: Support valuable insights

The best ideas rise to the top, while weaker ones are refined or fade away.

## 🚀 Live Demo

Visit: [https://meme-replicator.oliverpartridge.workers.dev/](https://meme-replicator.oliverpartridge.workers.dev/)

## ✨ Features

- **View memes without login** - Browse all ideas anonymously
- **Email authentication** - Passwordless Auth0 one-time codes
- **Submit ideas** - Share your memes with the community
- **Interact with memes** - REFUTE, REFINE, or PRAISE
- **Fitness scoring** - Ideas evolve based on interactions
- **Multiple sort options** - By fitness score, age, or activity
- **Real-time updates** - Auto-refresh every 30 seconds

## 🛠️ Tech Stack

- **Runtime**: Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite)
- **Authentication**: Auth0 Passwordless (email OTP)
- **Deployment**: Wrangler CLI

## 📦 Setup

### Prerequisites

- Node.js (v20+)
- A Cloudflare account
- Auth0 tenant with Passwordless Email enabled (see `AUTH0_SETUP.md`)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/WilliamOlivers/meme-replicator.git
   cd meme-replicator
   ```

2. **Install dependencies**
   ```bash
   npm install wrangler
   ```

3. **Create D1 Database**
   ```bash
   npx wrangler d1 create meme-replicator
   ```
   Update `wrangler.toml` with your database ID.

4. **Initialize database**
   ```bash
   npx wrangler d1 execute meme-replicator --local --file=schema.sql
   npx wrangler d1 execute meme-replicator --local --file=schema-auth.sql
   ```

5. **Run locally**
   ```bash
   npx wrangler dev
   ```
   Visit `http://localhost:8787`

### Auth0 Passwordless Setup

Follow `AUTH0_SETUP.md` for detailed instructions. In summary you will:

1. Create an Auth0 Single Page Application
2. Enable the **Passwordless > Email** connection
3. Add your production and local callback URLs
4. Set `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, and the `AUTH0_CLIENT_SECRET` Wrangler secret

## 🚢 Deployment

### Deploy to Cloudflare Workers

```bash
npx wrangler deploy
```

### Set up production database

```bash
npx wrangler d1 execute meme-replicator --remote --file=schema.sql
npx wrangler d1 execute meme-replicator --remote --file=schema-auth.sql
```

## 📁 Project Structure

```
meme-replicator/
├── src/
│   └── worker.js          # Main application code
├── schema.sql             # Main database schema
├── schema-auth.sql        # Authentication tables
├── wrangler.toml          # Cloudflare Workers config
├── .gitignore
└── README.md
```

## 🗃️ Database Schema

### Tables

- **memes** - Stores ideas with content, author, score, and timestamps
- **users** - User accounts with email and metadata
- **auth_tokens** - Legacy table for magic link tokens (unused with Auth0 OTP)
- **interactions** - User interactions (refute, refine, praise) with memes

## 🎯 Usage

### Viewing Memes

No login required! Just visit the site to browse all memes.

### Submitting Memes

1. Login with your email (magic link authentication)
2. Enter your idea in the submission form
3. Click "REPLICATE"

### Interacting

1. Login with your email
2. Click REFUTE, REFINE, or PRAISE on any meme
3. Optionally add a comment
4. Submit your interaction

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT License - feel free to use this project for your own purposes.

## 🙏 Acknowledgments

- Inspired by Richard Dawkins' concept of memes
- Built on David Deutsch's ideas about knowledge evolution
- Powered by Cloudflare's edge computing platform

## 📧 Contact

Project Link: [https://github.com/WilliamOlivers/meme-replicator](https://github.com/WilliamOlivers/meme-replicator)

---

**Remember**: Ideas, like organisms, evolve through variation and selection. May the fittest memes survive! 🧬
