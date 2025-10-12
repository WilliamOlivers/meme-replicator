# GitHub Setup Instructions

After creating your repository on GitHub, run these commands:

## Set up remote and push

Replace YOUR_USERNAME with your actual GitHub username:

```bash
cd /Users/oliverpartridge/python/meme_replicator
git remote add origin https://github.com/YOUR_USERNAME/meme-replicator.git
git branch -M main
git push -u origin main
```

## Alternative: Using SSH (if you have SSH keys set up)

```bash
cd /Users/oliverpartridge/python/meme_replicator
git remote add origin git@github.com:YOUR_USERNAME/meme-replicator.git
git branch -M main
git push -u origin main
```

## Future updates

After making changes, use:

```bash
git add .
git commit -m "Description of your changes"
git push
```

## Important Notes

1. Your wrangler.toml contains environment variables but NO secrets
2. The .gitignore properly excludes sensitive files
3. Remember to update the README with your actual GitHub username and email
4. Never commit your RESEND_API_KEY or other secrets!
