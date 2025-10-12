-- User management
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);

-- Magic link tokens
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add user_id to existing memes table (if it doesn't exist)
-- Note: This will fail if column already exists, which is fine
ALTER TABLE memes ADD COLUMN user_id INTEGER REFERENCES users(id);

-- Add user_id to existing interactions table (if it doesn't exist)
-- Note: This will fail if column already exists, which is fine
ALTER TABLE interactions ADD COLUMN user_id INTEGER REFERENCES users(id);