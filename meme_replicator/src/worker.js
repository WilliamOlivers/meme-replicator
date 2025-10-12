export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Handle API routes
    if (path.startsWith('/api/')) {
      return handleAPI(request, env, path);
    }
    
    // Serve the HTML page for root
    if (path === '/' || path === '') {
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    // Handle magic link authentication
    if (path === '/auth' && url.searchParams.has('token')) {
      return handleMagicLink(request, env, url.searchParams.get('token'));
    }
    
    // 404 for other routes
    return new Response('Not Found', { status: 404 });
  }
};

async function handleMagicLink(request, env, token) {
  try {
    // Find valid token
    const authToken = await env.DB.prepare(`
      SELECT at.*, u.email, u.name, u.id as user_id
      FROM auth_tokens at
      JOIN users u ON at.user_id = u.id
      WHERE at.token = ? AND at.expires_at > datetime('now') AND at.used = FALSE
    `).bind(token).first();
    
    if (!authToken) {
      return new Response(getAuthErrorHTML('Invalid or expired login link'), {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    // Mark token as used
    await env.DB.prepare('UPDATE auth_tokens SET used = TRUE WHERE token = ?').bind(token).run();
    
    // Update last login
    await env.DB.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?').bind(authToken.user_id).run();
    
    // Create session cookie (simple JWT-like token, valid for 30 days)
    const sessionData = {
      userId: authToken.user_id,
      email: authToken.email,
      name: authToken.name,
      exp: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days
    };
    
    const sessionToken = btoa(JSON.stringify(sessionData));
    
    // Redirect to home with session cookie
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/',
        'Set-Cookie': `session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}`
      }
    });
    
  } catch (error) {
    console.error('Auth error:', error);
    return new Response(getAuthErrorHTML('Authentication failed'), {
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

async function getUserFromRequest(request, env) {
  try {
    const cookies = request.headers.get('Cookie') || '';
    const sessionMatch = cookies.match(/session=([^;]+)/);
    
    if (!sessionMatch) return null;
    
    const sessionData = JSON.parse(atob(sessionMatch[1]));
    
    // Check if session is expired
    if (sessionData.exp < Date.now()) return null;
    
    // Verify user still exists
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(sessionData.userId).first();
    
    return user || null;
  } catch (error) {
    return null;
  }
}

async function handleAPI(request, env, path) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  try {
    // Auth endpoints
    if (path === '/api/auth/login' && request.method === 'POST') {
      return handleLogin(request, env, corsHeaders);
    }
    
    if (path === '/api/auth/user' && request.method === 'GET') {
      const user = await getUserFromRequest(request, env);
      return new Response(JSON.stringify({ user }), { headers: corsHeaders });
    }
    
    if (path === '/api/auth/logout' && request.method === 'POST') {
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          ...corsHeaders,
          'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
        }
      });
    }
    
    // Get current user for protected endpoints
    const currentUser = await getUserFromRequest(request, env);
    
    if (path === '/api/memes' && request.method === 'GET') {
      // Get all memes with interactions
      const memes = await env.DB.prepare(`
        SELECT m.*, u.name as author_name, u.email as author_email, COUNT(i.id) as interaction_count
        FROM memes m
        LEFT JOIN users u ON m.user_id = u.id
        LEFT JOIN interactions i ON m.id = i.meme_id
        GROUP BY m.id
        ORDER BY m.score DESC
      `).all();
      
      // Get interactions for each meme
      for (let meme of memes.results) {
        const interactions = await env.DB.prepare(`
          SELECT i.*, u.name as user_name 
          FROM interactions i
          LEFT JOIN users u ON i.user_id = u.id
          WHERE i.meme_id = ? 
          ORDER BY i.created_at DESC
        `).bind(meme.id).all();
        meme.interactions = interactions.results || [];
      }
      
      return new Response(JSON.stringify(memes.results), { headers: corsHeaders });
    }
    
    if (path === '/api/memes' && request.method === 'POST') {
      if (!currentUser) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), 
          { status: 401, headers: corsHeaders });
      }
      
      const { content } = await request.json();
      
      if (!content || content.trim() === '') {
        return new Response(JSON.stringify({ error: 'Content is required' }), 
          { status: 400, headers: corsHeaders });
      }
      
      const result = await env.DB.prepare(`
        INSERT INTO memes (content, author, user_id, score, created_at)
        VALUES (?, ?, ?, 100, datetime('now'))
      `).bind(content.trim(), currentUser.name || currentUser.email, currentUser.id).run();
      
      return new Response(JSON.stringify({ 
        success: true, 
        id: result.meta.last_row_id 
      }), { headers: corsHeaders });
    }
    
    if (path === '/api/interactions' && request.method === 'POST') {
      if (!currentUser) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), 
          { status: 401, headers: corsHeaders });
      }
      
      const { meme_id, type, comment = '' } = await request.json();
      
      if (!meme_id || !type || !['refute', 'refine', 'praise'].includes(type)) {
        return new Response(JSON.stringify({ error: 'Invalid interaction data' }), 
          { status: 400, headers: corsHeaders });
      }
      
      // Check if user already interacted with this meme
      const existingInteraction = await env.DB.prepare(`
        SELECT id FROM interactions WHERE meme_id = ? AND user_id = ? AND type = ?
      `).bind(meme_id, currentUser.id, type).first();
      
      if (existingInteraction) {
        return new Response(JSON.stringify({ error: 'You already have this type of interaction with this meme' }), 
          { status: 400, headers: corsHeaders });
      }
      
      // Add the interaction
      await env.DB.prepare(`
        INSERT INTO interactions (meme_id, user_id, type, comment, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).bind(meme_id, currentUser.id, type, comment.trim()).run();
      
      // Update meme score
      let scoreChange = 0;
      switch(type) {
        case 'refute': scoreChange = -15; break;
        case 'refine': scoreChange = 10; break;
        case 'praise': scoreChange = 5; break;
      }
      
      await env.DB.prepare(`
        UPDATE memes SET score = score + ? WHERE id = ?
      `).bind(scoreChange, meme_id).run();
      
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }
    
    // Debug endpoint
    if (path === '/api/debug' && request.method === 'GET') {
      try {
        const count = await env.DB.prepare('SELECT COUNT(*) as count FROM memes').first();
        const userCount = await env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
        const sample = await env.DB.prepare('SELECT * FROM memes LIMIT 1').first();
        
        return new Response(JSON.stringify({
          database_connected: true,
          meme_count: count.count,
          user_count: userCount.count,
          sample_meme: sample,
          current_user: currentUser ? currentUser.email : null,
          timestamp: new Date().toISOString()
        }), { headers: corsHeaders });
      } catch (error) {
        return new Response(JSON.stringify({
          database_connected: false,
          error: error.message,
          timestamp: new Date().toISOString()
        }), { status: 500, headers: corsHeaders });
      }
    }
    
    return new Response(JSON.stringify({ error: 'Not found' }), 
      { status: 404, headers: corsHeaders });
      
  } catch (error) {
    console.error('API Error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), 
      { status: 500, headers: corsHeaders });
  }
}

async function handleLogin(request, env, corsHeaders) {
  try {
    const { email } = await request.json();
    
    if (!email || !email.includes('@')) {
      return new Response(JSON.stringify({ error: 'Valid email required' }), 
        { status: 400, headers: corsHeaders });
    }
    
    // Find or create user
    let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    
    if (!user) {
      const result = await env.DB.prepare(`
        INSERT INTO users (email, created_at) VALUES (?, datetime('now'))
      `).bind(email).run();
      
      user = { id: result.meta.last_row_id, email };
    }
    
    // Generate magic link token
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes
    
    await env.DB.prepare(`
      INSERT INTO auth_tokens (user_id, token, expires_at, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).bind(user.id, token, expiresAt).run();
    
    // Send email (you'll need to implement this based on your email service)
    const magicLink = `${env.SITE_URL}/auth?token=${token}`;
    const emailSent = await sendMagicLinkEmail(email, magicLink, env);
    
    if (!emailSent) {
      return new Response(JSON.stringify({ error: 'Failed to send email' }), 
        { status: 500, headers: corsHeaders });
    }
    
    return new Response(JSON.stringify({ 
      success: true, 
      message: 'Magic link sent to your email' 
    }), { headers: corsHeaders });
    
  } catch (error) {
    console.error('Login error:', error);
    return new Response(JSON.stringify({ error: 'Login failed' }), 
      { status: 500, headers: corsHeaders });
  }
}

async function sendMagicLinkEmail(email, magicLink, env) {
  try {
    // Using Resend as an example - replace with your preferred email service
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: email,
        subject: 'Login to Meme Replicator',
        html: `
          <h2>Login to Meme Replicator</h2>
          <p>Click the link below to login:</p>
          <p><a href="${magicLink}" style="background: #333; color: white; padding: 10px 20px; text-decoration: none;">Login to Meme Replicator</a></p>
          <p>This link expires in 15 minutes.</p>
          <p>If you didn't request this login, you can safely ignore this email.</p>
        `
      })
    });
    
    return response.ok;
  } catch (error) {
    console.error('Email sending error:', error);
    return false;
  }
}

function getAuthErrorHTML(message) {
  return `<!DOCTYPE html>
<html>
<head>
    <title>Authentication Error - Meme Replicator</title>
    <style>
        body { font-family: 'Courier New', monospace; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
        .error { color: #d32f2f; border: 2px solid #d32f2f; padding: 20px; margin: 20px 0; }
    </style>
</head>
<body>
    <h1>MEME REPLICATOR</h1>
    <div class="error">
        <h3>Authentication Error</h3>
        <p>${message}</p>
    </div>
    <p><a href="/" style="color: #333;">← Back to Meme Replicator</a></p>
</body>
</html>`;
}

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Meme Replicator</title>
    <style>
        body {
            font-family: 'Courier New', monospace;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
            color: #333;
        }
        
        h1 {
            text-align: center;
            border-bottom: 2px solid #333;
            padding-bottom: 10px;
            margin-bottom: 30px;
        }
        
        .subtitle {
            text-align: center;
            font-style: italic;
            margin-bottom: 30px;
            color: #666;
        }
        
        .auth-section {
            background: white;
            border: 2px solid #333;
            padding: 20px;
            margin-bottom: 30px;
            display: none;
        }
        
        .auth-section.show {
            display: block;
        }
        
        .user-info {
            background: white;
            border: 2px solid #388e3c;
            padding: 15px;
            margin-bottom: 30px;
            display: none;
        }
        
        .user-info.show {
            display: block;
        }
        
        .meme-form {
            background: white;
            border: 2px solid #333;
            padding: 20px;
            margin-bottom: 30px;
        }
        
        .meme-form h3 {
            margin-top: 0;
        }
        
        textarea {
            width: 100%;
            height: 100px;
            border: 1px solid #333;
            padding: 10px;
            font-family: inherit;
            resize: vertical;
            box-sizing: border-box;
        }
        
        input[type="text"], input[type="email"] {
            width: 200px;
            border: 1px solid #333;
            padding: 10px;
            font-family: inherit;
            margin-left: 10px;
        }
        
        button {
            background: #333;
            color: white;
            border: none;
            padding: 10px 20px;
            cursor: pointer;
            font-family: inherit;
            margin: 5px;
        }
        
        button:hover {
            background: #555;
        }
        
        button:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        
        button.logout {
            background: #d32f2f;
            padding: 5px 10px;
            font-size: 12px;
        }
        
        .meme-list {
            background: white;
            border: 2px solid #333;
            padding: 20px;
        }
        
        .meme-item {
            border-bottom: 1px solid #ddd;
            padding: 15px 0;
            position: relative;
        }
        
        .meme-item:last-child {
            border-bottom: none;
        }
        
        .meme-score {
            position: absolute;
            top: 15px;
            right: 0;
            background: #333;
            color: white;
            padding: 5px 10px;
            font-weight: bold;
        }
        
        .meme-content {
            margin-right: 80px;
            font-size: 16px;
            line-height: 1.4;
        }
        
        .meme-meta {
            font-size: 12px;
            color: #666;
            margin-top: 10px;
        }
        
        .meme-actions {
            margin-top: 10px;
        }
        
        .action-btn {
            background: transparent;
            border: 1px solid #333;
            color: #333;
            padding: 5px 10px;
            font-size: 12px;
        }
        
        .refute { border-color: #d32f2f; color: #d32f2f; }
        .refine { border-color: #1976d2; color: #1976d2; }
        .praise { border-color: #388e3c; color: #388e3c; }
        
        .action-btn:hover:not(:disabled) {
            background: #f0f0f0;
        }
        
        .action-btn:disabled {
            opacity: 0.5;
        }
        
        .interaction-form {
            display: none;
            margin-top: 10px;
            padding: 10px;
            background: #f9f9f9;
            border: 1px solid #ddd;
        }
        
        .interaction-form textarea {
            height: 60px;
            margin-bottom: 10px;
        }
        
        .interactions-list {
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px solid #eee;
        }
        
        .interaction-item {
            font-size: 12px;
            margin-bottom: 5px;
            padding: 5px;
            background: #f9f9f9;
        }
        
        .sort-controls {
            margin-bottom: 20px;
            text-align: center;
        }
        
        .sort-btn {
            background: transparent;
            border: 1px solid #333;
            color: #333;
            padding: 5px 15px;
            margin: 0 5px;
        }
        
        .sort-btn.active {
            background: #333;
            color: white;
        }
        
        .loading {
            text-align: center;
            color: #666;
            font-style: italic;
        }
        
        .error {
            color: #d32f2f;
            text-align: center;
            margin: 10px 0;
        }
        
        .success {
            color: #388e3c;
            text-align: center;
            margin: 10px 0;
        }
    </style>
</head>
<body>
    <h1>MEME REPLICATOR</h1>
    <div class="subtitle">
        "In the evolution of ideas, only the fittest survive" - Inspired by Deutsch & Dawkins
    </div>
    
    <!-- Authentication Section -->
    <div id="authSection" class="auth-section">
        <h3>Login to Submit & Interact</h3>
        <p>Enter your email to receive a magic login link:</p>
        <input type="email" id="emailInput" placeholder="your@email.com">
        <button id="loginBtn" onclick="requestLogin()">SEND LOGIN LINK</button>
        <div id="authMessage"></div>
    </div>
    
    <!-- User Info Section -->
    <div id="userInfo" class="user-info">
        <span id="userEmail"></span>
        <button class="logout" onclick="logout()">LOGOUT</button>
    </div>
    
    <div class="meme-form">
        <h3>Submit a Meme (Idea)</h3>
        <div id="loginPrompt" style="display: none;">
            <p style="color: #666; font-style: italic;">Please login above to submit memes and interact with ideas.</p>
        </div>
        <div id="memeSubmission">
            <textarea id="memeContent" placeholder="Enter your meme/idea here. Make it clear, testable, and meaningful..."></textarea>
            <br><br>
            <button id="submitBtn" onclick="submitMeme()">REPLICATE</button>
        </div>
        <div id="submitMessage"></div>
    </div>
    
    <div class="meme-list">
        <h3>Meme Pool</h3>
        <div class="sort-controls">
            Sort by: 
            <button class="sort-btn active" onclick="sortMemes('score')">FITNESS SCORE</button>
            <button class="sort-btn" onclick="sortMemes('age')">AGE</button>
            <button class="sort-btn" onclick="sortMemes('interactions')">ACTIVITY</button>
        </div>
        
        <div id="memeContainer" class="loading">
            Loading memes...
        </div>
    </div>

    <script>
        let memes = [];
        let currentSort = 'score';
        let currentUser = null;
        
        // Load initial state
        checkAuthAndLoad();
        
        async function checkAuthAndLoad() {
            await checkAuth();
            await loadMemes();
        }
        
        async function checkAuth() {
            try {
                const response = await fetch('/api/auth/user');
                const data = await response.json();
                
                if (data.user) {
                    currentUser = data.user;
                    showUserInterface();
                } else {
                    currentUser = null;
                    showLoginInterface();
                }
            } catch (error) {
                console.error('Auth check failed:', error);
                showLoginInterface();
            }
        }
        
        function showUserInterface() {
            document.getElementById('authSection').classList.remove('show');
            document.getElementById('userInfo').classList.add('show');
            document.getElementById('userEmail').textContent = 'Logged in as: ' + (currentUser.name || currentUser.email);
            document.getElementById('loginPrompt').style.display = 'none';
            document.getElementById('memeSubmission').style.display = 'block';
        }
        
        function showLoginInterface() {
            document.getElementById('authSection').classList.add('show');
            document.getElementById('userInfo').classList.remove('show');
            document.getElementById('loginPrompt').style.display = 'block';
            document.getElementById('memeSubmission').style.display = 'none';
        }
        
        async function requestLogin() {
            const email = document.getElementById('emailInput').value.trim();
            const loginBtn = document.getElementById('loginBtn');
            const messageDiv = document.getElementById('authMessage');
            
            if (!email || !email.includes('@')) {
                messageDiv.innerHTML = '<div class="error">Please enter a valid email address!</div>';
                return;
            }
            
            loginBtn.disabled = true;
            loginBtn.textContent = 'SENDING...';
            messageDiv.innerHTML = '';
            
            try {
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    messageDiv.innerHTML = '<div class="success">Magic link sent! Check your email.</div>';
                    document.getElementById('emailInput').value = '';
                } else {
                    messageDiv.innerHTML = '<div class="error">' + (data.error || 'Login failed') + '</div>';
                }
                
            } catch (error) {
                messageDiv.innerHTML = '<div class="error">Network error. Please try again.</div>';
                console.error('Login error:', error);
            } finally {
                loginBtn.disabled = false;
                loginBtn.textContent = 'SEND LOGIN LINK';
            }
        }
        
        async function logout() {
            try {
                await fetch('/api/auth/logout', { method: 'POST' });
                currentUser = null;
                showLoginInterface();
                await loadMemes(); // Refresh to update interaction availability
            } catch (error) {
                console.error('Logout error:', error);
            }
        }
        
        async function loadMemes() {
            try {
                const response = await fetch('/api/memes');
                
                if (!response.ok) {
                    console.error('Failed to load memes:', response.status, response.statusText);
                    throw new Error('Failed to load memes');
                }
                
                const data = await response.json();
                memes = data;
                renderMemes();
            } catch (error) {
                console.error('Error loading memes:', error);
                document.getElementById('memeContainer').innerHTML = 
                    '<div class="error">Failed to load memes. Please refresh the page.</div>';
            }
        }
        
        async function submitMeme() {
            if (!currentUser) {
                document.getElementById('submitMessage').innerHTML = 
                    '<div class="error">Please login to submit memes!</div>';
                return;
            }
            
            const content = document.getElementById('memeContent').value.trim();
            const submitBtn = document.getElementById('submitBtn');
            const messageDiv = document.getElementById('submitMessage');
            
            if (!content) {
                messageDiv.innerHTML = '<div class="error">Please enter a meme/idea!</div>';
                return;
            }
            
            submitBtn.disabled = true;
            submitBtn.textContent = 'REPLICATING...';
            messageDiv.innerHTML = '';
            
            try {
                const response = await fetch('/api/memes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    document.getElementById('memeContent').value = '';
                    messageDiv.innerHTML = '<div class="success">Meme replicated successfully!</div>';
                    await loadMemes();
                } else {
                    messageDiv.innerHTML = '<div class="error">' + (data.error || 'Failed to submit meme') + '</div>';
                }
                
            } catch (error) {
                messageDiv.innerHTML = '<div class="error">Network error. Please try again.</div>';
                console.error('Error submitting meme:', error);
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'REPLICATE';
                
                setTimeout(() => {
                    if (messageDiv.innerHTML.includes('success')) {
                        messageDiv.innerHTML = '';
                    }
                }, 3000);
            }
        }
        
        function interactWithMeme(memeId, type) {
            if (!currentUser) {
                alert('Please login to interact with memes!');
                return;
            }
            
            const form = document.getElementById(\`form-\${memeId}-\${type}\`);
            if (form.style.display === 'none' || !form.style.display) {
                document.querySelectorAll('.interaction-form').forEach(f => f.style.display = 'none');
                form.style.display = 'block';
            } else {
                form.style.display = 'none';
            }
        }
        
        async function submitInteraction(memeId, type) {
            const comment = document.getElementById(\`comment-\${memeId}-\${type}\`).value.trim();
            const submitBtn = document.getElementById(\`submit-\${memeId}-\${type}\`);
            
            submitBtn.disabled = true;
            submitBtn.textContent = 'Submitting...';
            
            try {
                const response = await fetch('/api/interactions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ meme_id: memeId, type, comment })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    document.getElementById('comment-' + memeId + '-' + type).value = '';
                    document.getElementById('form-' + memeId + '-' + type).style.display = 'none';
                    await loadMemes();
                } else {
                    alert(data.error || 'Failed to submit interaction');
                }
                
            } catch (error) {
                alert('Network error. Please try again.');
                console.error('Error submitting interaction:', error);
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Submit ' + type.charAt(0).toUpperCase() + type.slice(1);
            }
        }
        
        function sortMemes(sortType) {
            currentSort = sortType;
            
            // Update active button
            document.querySelectorAll('.sort-btn').forEach(btn => btn.classList.remove('active'));
            event.target.classList.add('active');
            
            switch(sortType) {
                case 'score':
                    memes.sort((a, b) => b.score - a.score);
                    break;
                case 'age':
                    memes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                    break;
                case 'interactions':
                    memes.sort((a, b) => (b.interactions?.length || 0) - (a.interactions?.length || 0));
                    break;
            }
            
            renderMemes();
        }
        
        function formatTimeAgo(dateString) {
            const now = new Date();
            const date = new Date(dateString);
            const diff = now - date;
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor(diff / (1000 * 60));
            
            if (days > 0) return days + 'd ago';
            if (hours > 0) return hours + 'h ago';
            if (minutes > 0) return minutes + 'm ago';
            return 'just now';
        }
        
        function renderMemes() {
            const container = document.getElementById('memeContainer');
            
            if (!memes || memes.length === 0) {
                container.innerHTML = '<div class="loading">No memes yet. Be the first to submit one!</div>';
                return;
            }
            
            container.innerHTML = '';
            
            memes.forEach(meme => {
                const interactionCount = meme.interactions?.length || meme.interaction_count || 0;
                const authorName = meme.author_name || meme.author || 'Anonymous';
                
                const memeDiv = document.createElement('div');
                memeDiv.className = 'meme-item';
                
                // Build interactions display
                let interactionsHtml = '';
                if (meme.interactions && meme.interactions.length > 0) {
                    interactionsHtml = '<div class="interactions-list">';
                    meme.interactions.slice(0, 3).forEach(interaction => {
                        const userName = interaction.user_name || 'Anonymous';
                        const typeColor = interaction.type === 'refute' ? '#d32f2f' : 
                                         interaction.type === 'refine' ? '#1976d2' : '#388e3c';
                        interactionsHtml += 
                            '<div class="interaction-item">' +
                                '<strong style="color: ' + typeColor + '">' + interaction.type.toUpperCase() + '</strong> by ' + userName + ': ' + 
                                (interaction.comment || 'No comment') +
                            '</div>';
                    });
                    if (meme.interactions.length > 3) {
                        interactionsHtml += '<div class="interaction-item" style="font-style: italic;">... and ' + (meme.interactions.length - 3) + ' more</div>';
                    }
                    interactionsHtml += '</div>';
                }
                
                // Check if user can interact (not logged in = disabled buttons)
                const canInteract = currentUser !== null;
                const disabledAttr = canInteract ? '' : 'disabled';
                const disabledTitle = canInteract ? '' : 'title="Login required"';
                
                const htmlContent = '<div class="meme-score">' + meme.score + '</div>' +
                    '<div class="meme-content">' + meme.content + '</div>' +
                    '<div class="meme-meta">' +
                        'By ' + authorName + ' • ' + formatTimeAgo(meme.created_at) + ' • ' + interactionCount + ' interactions' +
                    '</div>' +
                    '<div class="meme-actions">' +
                        '<button class="action-btn refute" ' + disabledAttr + ' ' + disabledTitle + ' onclick="interactWithMeme(' + meme.id + ', ' + "'refute'" + ')">REFUTE (-15)</button>' +
                        '<button class="action-btn refine" ' + disabledAttr + ' ' + disabledTitle + ' onclick="interactWithMeme(' + meme.id + ', ' + "'refine'" + ')">REFINE (+10)</button>' +
                        '<button class="action-btn praise" ' + disabledAttr + ' ' + disabledTitle + ' onclick="interactWithMeme(' + meme.id + ', ' + "'praise'" + ')">PRAISE (+5)</button>' +
                    '</div>' +
                    
                    '<div id="form-' + meme.id + '-refute" class="interaction-form">' +
                        '<textarea id="comment-' + meme.id + '-refute" placeholder="Explain why this meme is flawed or incorrect..."></textarea>' +
                        '<button id="submit-' + meme.id + '-refute" onclick="submitInteraction(' + meme.id + ', ' + "'refute'" + ')">Submit Refutation</button>' +
                    '</div>' +
                    
                    '<div id="form-' + meme.id + '-refine" class="interaction-form">' +
                        '<textarea id="comment-' + meme.id + '-refine" placeholder="How can this meme be improved or made more precise..."></textarea>' +
                        '<button id="submit-' + meme.id + '-refine" onclick="submitInteraction(' + meme.id + ', ' + "'refine'" + ')">Submit Refinement</button>' +
                    '</div>' +
                    
                    '<div id="form-' + meme.id + '-praise" class="interaction-form">' +
                        '<textarea id="comment-' + meme.id + '-praise" placeholder="Why is this meme valuable or insightful..."></textarea>' +
                        '<button id="submit-' + meme.id + '-praise" onclick="submitInteraction(' + meme.id + ', ' + "'praise'" + ')">Submit Praise</button>' +
                    '</div>' +
                    
                    interactionsHtml;
                memeDiv.innerHTML = htmlContent;
                container.appendChild(memeDiv);
            });
        }
        
        // Auto-refresh every 30 seconds
        setInterval(loadMemes, 30000);
    </script>
</body>
</html>`;
}