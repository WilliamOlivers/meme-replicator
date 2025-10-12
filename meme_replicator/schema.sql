CREATE TABLE memes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  author TEXT DEFAULT 'Anonymous',
  score INTEGER DEFAULT 100,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meme_id INTEGER REFERENCES memes(id),
  type TEXT CHECK(type IN ('refute', 'refine', 'praise')),
  comment TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert some sample data
INSERT INTO memes (content, author, score) VALUES 
('The best way to predict the future is to invent it.', 'Alan Kay', 95),
('All problems in computer science can be solved by another level of indirection.', 'David Wheeler', 87),
('The fundamental cause of trouble is that in the modern world the stupid are cocksure while the intelligent are full of doubt.', 'Bertrand Russell', 112);