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
    
    // Handle Auth0 callback
    if (path === '/auth/callback') {
      return handleAuth0Callback(request, env);
    }
    
    // 404 for other routes
    return new Response('Not Found', { status: 404 });
  }
};

async function handleAuth0Callback(request, env) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    
    if (!code) {
      return new Response('Missing authorization code', { status: 400 });
    }
    
    // Exchange code for token
    const tokenResponse = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.AUTH0_CLIENT_ID,
        client_secret: env.AUTH0_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: `${env.SITE_URL}auth/callback`
      })
    });
    
    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', await tokenResponse.text());
      return new Response('Authentication failed', { status: 401 });
    }
    
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    
    // Get user info from Auth0
    const userResponse = await fetch(`https://${env.AUTH0_DOMAIN}/userinfo`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!userResponse.ok) {
      return new Response('Failed to get user info', { status: 401 });
    }
    
    const auth0User = await userResponse.json();
    const user = await upsertAuth0User(auth0User, env);
    const sessionDetails = buildSessionCookie(user, auth0User);
    
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/',
        'Set-Cookie': sessionDetails.header
      }
    });
    
  } catch (error) {
    console.error('Auth0 callback error:', error);
    return new Response('Authentication error: ' + error.message, { status: 500 });
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

    if (!user) return null;

    if (!user.username) {
      const username = await generateUsername(env);
      await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?')
        .bind(username, user.id)
        .run();
      user.username = username;
    }

    user.sessionData = sessionData;
    return user;
  } catch (error) {
    return null;
  }
}

async function handleAPI(request, env, path) {
  const origin = request.headers.get('Origin');
  const siteOrigin = env.SITE_URL ? env.SITE_URL.replace(/\/$/, '') : undefined;
  const allowedOrigin = origin && origin !== 'null' ? origin : siteOrigin || '*';

  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
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

    if (path === '/api/auth/verify' && request.method === 'POST') {
      return handleCodeVerification(request, env, corsHeaders);
    }
    
    if (path === '/api/auth/user' && request.method === 'GET') {
      const user = await getUserFromRequest(request, env);
      const headers = { ...corsHeaders };

      if (user && (!user.sessionData?.username || user.sessionData.username !== user.username)) {
        const sessionDetails = buildSessionCookie(user);
        headers['Set-Cookie'] = sessionDetails.header;
      }

      if (user && user.sessionData) {
        delete user.sessionData;
      }

      return new Response(JSON.stringify({ user }), { headers });
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
    
    if (path === '/api/profile' && request.method === 'GET') {
      if (!currentUser) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
          status: 401,
          headers: corsHeaders
        });
      }

      const profile = {
        email: currentUser.email,
        username: currentUser.username,
        name: currentUser.name
      };

      return new Response(JSON.stringify({ profile }), { headers: corsHeaders });
    }

    if (path === '/api/profile' && request.method === 'PUT') {
      if (!currentUser) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
          status: 401,
          headers: corsHeaders
        });
      }

      const body = await request.json();
      const rawUsername = typeof body.username === 'string' ? body.username.trim() : '';

      if (!rawUsername) {
        return new Response(JSON.stringify({ error: 'Username is required' }), {
          status: 400,
          headers: corsHeaders
        });
      }

      const normalized = rawUsername.toLowerCase();
      const pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

      if (normalized.length < 3 || normalized.length > 32 || !pattern.test(normalized)) {
        return new Response(JSON.stringify({ error: 'Username must be 3-32 characters, lowercase letters, numbers, and single hyphens only' }), {
          status: 400,
          headers: corsHeaders
        });
      }

      if (currentUser.username === normalized) {
        const sessionDetails = buildSessionCookie(currentUser);
        return new Response(JSON.stringify({ profile: {
          email: currentUser.email,
          username: currentUser.username,
          name: currentUser.name
        } }), {
          headers: {
            ...corsHeaders,
            'Set-Cookie': sessionDetails.header
          }
        });
      }

      const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(normalized).first();

      if (existing && existing.id !== currentUser.id) {
        return new Response(JSON.stringify({ error: 'Username already taken' }), {
          status: 409,
          headers: corsHeaders
        });
      }

      await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?')
        .bind(normalized, currentUser.id)
        .run();

      const updatedUser = { ...currentUser, username: normalized };
      const sessionDetails = buildSessionCookie(updatedUser);

      return new Response(JSON.stringify({ profile: {
        email: updatedUser.email,
        username: updatedUser.username,
        name: updatedUser.name
      } }), {
        headers: {
          ...corsHeaders,
          'Set-Cookie': sessionDetails.header
        }
      });
    }

    if (path === '/api/memes' && request.method === 'GET') {
      // Get all memes with interactions
      const memes = await env.DB.prepare(`
        SELECT m.*, u.name as author_name, u.email as author_email, u.username as author_username, COUNT(i.id) as interaction_count
        FROM memes m
        LEFT JOIN users u ON m.user_id = u.id
        LEFT JOIN interactions i ON m.id = i.meme_id
        GROUP BY m.id
        ORDER BY m.score DESC
      `).all();
      
      // Get interactions for each meme
      for (let meme of memes.results) {
        const interactions = await env.DB.prepare(`
          SELECT i.*, u.name as user_name, u.username as user_username 
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

      const authorLabel = currentUser.username ? '@' + currentUser.username : (currentUser.name || currentUser.email);
      
      const result = await env.DB.prepare(`
        INSERT INTO memes (content, author, user_id, score, created_at)
        VALUES (?, ?, ?, 100, datetime('now'))
      `).bind(content.trim(), authorLabel, currentUser.id).run();
      
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
    // Request Auth0 to send a passwordless email link
    const payload = {
      client_id: env.AUTH0_CLIENT_ID,
      client_secret: env.AUTH0_CLIENT_SECRET,
      connection: 'email',
      email,
      send: 'code'
    };
    
    const authResponse = await fetch(`https://${env.AUTH0_DOMAIN}/passwordless/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!authResponse.ok) {
      const errorText = await authResponse.text();
      console.error('Auth0 passwordless start failed:', errorText);
      return new Response(JSON.stringify({ error: 'Failed to send login email. Please try again.' }), 
        { status: 502, headers: corsHeaders });
    }
    
    return new Response(JSON.stringify({ 
      success: true,
      message: 'Verification code sent. Check your email.'
    }), { headers: corsHeaders });
    
  } catch (error) {
    console.error('Login error:', error);
    return new Response(JSON.stringify({ error: 'Login failed: ' + error.message }), 
      { status: 500, headers: corsHeaders });
  }
}

async function handleCodeVerification(request, env, corsHeaders) {
  try {
    const { email, code } = await request.json();

    if (!email || !email.includes('@') || !code) {
      return new Response(JSON.stringify({ error: 'Email and verification code are required.' }), {
        status: 400,
        headers: corsHeaders
      });
    }

    const tokenResponse = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'http://auth0.com/oauth/grant-type/passwordless/otp',
        client_id: env.AUTH0_CLIENT_ID,
        client_secret: env.AUTH0_CLIENT_SECRET,
        otp: code,
        realm: 'email',
        username: email,
        scope: 'openid profile email'
      })
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Auth0 OTP exchange failed:', errorText);
      return new Response(JSON.stringify({ error: 'Invalid or expired verification code.' }), {
        status: 401,
        headers: corsHeaders
      });
    }

    const tokenData = await tokenResponse.json();
    let auth0User = null;

    if (tokenData.access_token) {
      const userResponse = await fetch(`https://${env.AUTH0_DOMAIN}/userinfo`, {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });

      if (!userResponse.ok) {
        console.error('Failed to fetch user info after OTP exchange:', await userResponse.text());
        return new Response(JSON.stringify({ error: 'Verification succeeded but user info is unavailable.' }), {
          status: 500,
          headers: corsHeaders
        });
      }

      auth0User = await userResponse.json();
    } else if (tokenData.id_token) {
      const decoded = decodeIdToken(tokenData.id_token);
      if (decoded) {
        auth0User = decoded;
      }
    }

    if (!auth0User || !auth0User.email) {
      // Fallback to the email the user provided if Auth0 response omits it
      auth0User = {
        ...(auth0User || {}),
        email,
        name: auth0User?.name || auth0User?.nickname || email
      };
    }

    const user = await upsertAuth0User(auth0User, env);
    const sessionDetails = buildSessionCookie(user, auth0User);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        ...corsHeaders,
        'Set-Cookie': sessionDetails.header
      }
    });

  } catch (error) {
    console.error('Code verification error:', error);
    return new Response(JSON.stringify({ error: 'Verification failed: ' + error.message }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

async function upsertAuth0User(auth0User, env) {
  if (!auth0User || !auth0User.email) {
    throw new Error('Auth0 profile missing email');
  }

  const preferredName = auth0User.name || auth0User.nickname || auth0User.email;

  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(auth0User.email)
    .first();

  if (!user) {
    const username = await generateUsername(env);
    const result = await env.DB.prepare(`
      INSERT INTO users (email, name, username, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).bind(auth0User.email, preferredName, username).run();

    user = {
      id: result.meta.last_row_id,
      email: auth0User.email,
      name: preferredName,
      username
    };
  } else {
    if (!user.name && preferredName) {
      await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?')
        .bind(preferredName, user.id)
        .run();
      user.name = preferredName;
    }

    if (!user.username) {
      const username = await generateUsername(env);
      await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?')
        .bind(username, user.id)
        .run();
      user.username = username;
    }
  }

  await env.DB.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?')
    .bind(user.id)
    .run();

  return user;
}

function buildSessionCookie(user, auth0User = null) {
  const displayName = user.name || auth0User?.name || auth0User?.nickname || user.email;
  const sessionData = {
    userId: user.id,
    email: user.email,
    name: displayName,
    username: user.username,
    auth0Sub: auth0User?.sub,
    exp: Date.now() + (30 * 24 * 60 * 60 * 1000)
  };

  const sessionToken = btoa(JSON.stringify(sessionData));
  const maxAgeSeconds = 30 * 24 * 60 * 60;

  return {
    token: sessionToken,
    header: `session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`
  };
}

  async function generateUsername(env, maxAttempts = 25) {
    const adjectives = [
      'curious', 'bold', 'clever', 'lively', 'radiant', 'vivid', 'brisk', 'lucid', 'noble', 'brave'
    ];
    const nouns = [
      'aurora', 'comet', 'nebula', 'quark', 'vector', 'cipher', 'vertex', 'lyric', 'signal', 'riddle'
    ];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
      const noun = nouns[Math.floor(Math.random() * nouns.length)];
      const suffix = Math.floor(100 + Math.random() * 900);
      const candidate = `${adjective}-${noun}-${suffix}`;

      const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
        .bind(candidate)
        .first();

      if (!existing) {
        return candidate;
      }
    }

    throw new Error('Unable to generate unique username');
  }

function decodeIdToken(idToken) {
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) {
      return null;
    }

    const payload = base64UrlDecode(parts[1]);
    return JSON.parse(payload);
  } catch (error) {
    console.error('Failed to decode id_token:', error);
    return null;
  }
}

function base64UrlDecode(input) {
  let output = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = output.length % 4;

  if (padding) {
    output += '='.repeat(4 - padding);
  }

  return atob(output);
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
      justify-content: space-between;
      align-items: center;
      gap: 15px;
      flex-wrap: wrap;
    }
        
    .user-info.show {
      display: flex;
        }

    .user-summary {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .profile-handle {
      font-size: 14px;
      color: #1976d2;
    }

    .profile-handle.missing {
      color: #d32f2f;
    }

    .user-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .edit-profile {
      background: transparent;
      border: 1px solid #333;
      color: #333;
      padding: 6px 12px;
      font-size: 12px;
    }
        
    .edit-profile:hover {
      background: #f0f0f0;
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

    .profile-editor {
      background: white;
      border: 2px solid #1976d2;
      padding: 20px;
      margin-bottom: 30px;
      display: none;
    }

    .profile-editor.show {
      display: block;
    }

    .profile-editor h4 {
      margin-top: 0;
      margin-bottom: 10px;
    }

    .profile-editor label {
      font-size: 12px;
      font-weight: bold;
      display: block;
      margin-bottom: 5px;
    }

    .profile-editor input[type="text"] {
      width: 220px;
      border: 1px solid #333;
      padding: 8px 10px;
      font-family: inherit;
      margin-bottom: 10px;
    }

    .profile-controls {
      display: flex;
      gap: 10px;
      margin-bottom: 10px;
    }

    .profile-hint {
      font-size: 12px;
      color: #666;
      margin: 0;
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
    <p>Enter your email to receive a one-time login code:</p>
        <input type="email" id="emailInput" placeholder="your@email.com">
    <button id="loginBtn" onclick="requestLogin()">SEND LOGIN CODE</button>
    <div id="codeSection" style="display: none; margin-top: 15px;">
      <p>Then enter the 6-digit code we just emailed you:</p>
      <input type="text" id="codeInput" maxlength="10" placeholder="123456" style="width: 160px; text-align: center;">
      <button id="verifyBtn" onclick="verifyCode()">VERIFY CODE</button>
    </div>
        <div id="authMessage"></div>
    </div>
    
    <!-- User Info Section -->
  <div id="userInfo" class="user-info">
    <div class="user-summary">
      <div id="userEmail"></div>
      <div id="userHandle" class="profile-handle"></div>
    </div>
    <div class="user-actions">
      <button class="edit-profile" onclick="toggleProfileEditor(true)">EDIT PROFILE</button>
      <button class="logout" onclick="logout()">LOGOUT</button>
    </div>
  </div>

  <div id="profileEditor" class="profile-editor">
    <h4>Profile</h4>
    <label for="usernameInput">Username</label>
    <input type="text" id="usernameInput" maxlength="32" placeholder="lowercase-handle">
    <div id="profileMessage"></div>
    <div class="profile-controls">
      <button id="saveUsernameBtn" onclick="saveUsername()">SAVE</button>
      <button onclick="toggleProfileEditor(false)">CANCEL</button>
      <button id="suggestUsernameBtn" onclick="suggestUsername()">RANDOMIZE</button>
    </div>
    <p class="profile-hint">Usernames use lowercase letters, numbers, and single hyphens.</p>
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
    let pendingEmail = null;
    let profileEditorOpen = false;

    const usernameAdjectives = [
      'curious', 'bold', 'clever', 'lively', 'radiant', 'vivid', 'brisk', 'lucid', 'noble', 'brave',
      'keen', 'mirthful', 'orbiting', 'spry', 'focal', 'stellar', 'mystic', 'quiet', 'restless', 'sage'
    ];

    const usernameNouns = [
      'aurora', 'comet', 'nebula', 'quark', 'vector', 'cipher', 'vertex', 'lyric', 'signal', 'riddle',
      'lemma', 'paradox', 'chorus', 'atlas', 'glyph', 'spark', 'syllable', 'fractal', 'zephyr', 'ember'
    ];
        
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
      updateUserSummary();
            document.getElementById('loginPrompt').style.display = 'none';
            document.getElementById('memeSubmission').style.display = 'block';
      const editor = document.getElementById('profileEditor');
      if (editor) {
        editor.classList.remove('show');
      }
      profileEditorOpen = false;
        }
        
        function showLoginInterface() {
            document.getElementById('authSection').classList.add('show');
            document.getElementById('userInfo').classList.remove('show');
            document.getElementById('loginPrompt').style.display = 'block';
            document.getElementById('memeSubmission').style.display = 'none';
            document.getElementById('codeSection').style.display = 'none';
            document.getElementById('emailInput').disabled = false;
            document.getElementById('loginBtn').disabled = false;
            document.getElementById('loginBtn').textContent = 'SEND LOGIN CODE';
            document.getElementById('codeInput').value = '';
            pendingEmail = null;
      const editor = document.getElementById('profileEditor');
      if (editor) {
        editor.classList.remove('show');
      }
      profileEditorOpen = false;
      updateUserSummary();
        }

    function updateUserSummary() {
      const emailEl = document.getElementById('userEmail');
      const handleEl = document.getElementById('userHandle');

      if (!emailEl || !handleEl) {
        return;
      }

      if (!currentUser) {
        emailEl.textContent = '';
        handleEl.textContent = '';
        handleEl.classList.remove('missing');
        return;
      }

            const namePart = currentUser.name ? currentUser.name + ' (' + currentUser.email + ')' : currentUser.email;
      emailEl.textContent = 'Logged in as: ' + namePart;

      if (currentUser.username) {
        handleEl.textContent = '@' + currentUser.username;
        handleEl.classList.remove('missing');
      } else {
        handleEl.textContent = 'Choose a username so others can find you';
        handleEl.classList.add('missing');
      }

      const input = document.getElementById('usernameInput');
      if (input && !profileEditorOpen) {
        input.value = currentUser.username || '';
      }
    }

    function toggleProfileEditor(open) {
      if (!currentUser) {
        return;
      }

      profileEditorOpen = open;
      const editor = document.getElementById('profileEditor');
      const input = document.getElementById('usernameInput');
      const messageDiv = document.getElementById('profileMessage');

      if (!editor || !input || !messageDiv) {
        return;
      }

      if (open) {
        editor.classList.add('show');
        input.value = currentUser.username || buildUsernameSuggestion();
        input.focus();
        input.select();
        messageDiv.innerHTML = '';
      } else {
        editor.classList.remove('show');
        messageDiv.innerHTML = '';
        input.value = currentUser ? currentUser.username || '' : '';
      }
    }

    function buildUsernameSuggestion() {
      const adjective = usernameAdjectives[Math.floor(Math.random() * usernameAdjectives.length)];
      const noun = usernameNouns[Math.floor(Math.random() * usernameNouns.length)];
      const suffix = Math.floor(100 + Math.random() * 900);
            return adjective + '-' + noun + '-' + suffix;
    }

    function suggestUsername() {
      const input = document.getElementById('usernameInput');
      const messageDiv = document.getElementById('profileMessage');
      if (!input || !messageDiv) {
        return;
      }
      input.value = buildUsernameSuggestion();
      messageDiv.innerHTML = '';
      input.focus();
      input.select();
    }

    async function saveUsername() {
      if (!currentUser) {
        return;
      }

      const input = document.getElementById('usernameInput');
      const messageDiv = document.getElementById('profileMessage');
      const saveBtn = document.getElementById('saveUsernameBtn');

      if (!input || !messageDiv || !saveBtn) {
        return;
      }

      const candidate = input.value.trim().toLowerCase();

      if (!candidate) {
        messageDiv.innerHTML = '<div class="error">Enter a username before saving.</div>';
        return;
      }

      saveBtn.disabled = true;
      messageDiv.innerHTML = '';

      try {
        const response = await fetch('/api/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: candidate })
        });

        const data = await response.json();

        if (response.ok && data?.profile) {
          currentUser.username = data.profile.username;
          if (data.profile.name) {
            currentUser.name = data.profile.name;
          }
          updateUserSummary();
          messageDiv.innerHTML = '<div class="success">Username updated!</div>';
          setTimeout(() => {
            if (profileEditorOpen) {
              toggleProfileEditor(false);
            }
          }, 800);
          await loadMemes();
        } else {
                    const errorMsg = (data && data.error) ? data.error : 'Failed to update username';
                    messageDiv.innerHTML = '<div class="error">' + errorMsg + '</div>';
        }
      } catch (error) {
        console.error('Username update failed:', error);
        messageDiv.innerHTML = '<div class="error">Network error. Please try again.</div>';
      } finally {
        saveBtn.disabled = false;
      }
    }
        
        async function requestLogin() {
            const email = document.getElementById('emailInput').value.trim();
            const loginBtn = document.getElementById('loginBtn');
            const messageDiv = document.getElementById('authMessage');
            const emailInput = document.getElementById('emailInput');
            const codeSection = document.getElementById('codeSection');
            const codeInput = document.getElementById('codeInput');

            if (!email || !email.includes('@')) {
                messageDiv.innerHTML = '<div class="error">Please enter a valid email address!</div>';
                return;
            }

            loginBtn.disabled = true;
            loginBtn.textContent = 'SENDING LOGIN CODE...';
            messageDiv.innerHTML = '';

            try {
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });

                const data = await response.json();

                if (data.success) {
                    pendingEmail = email;
                    emailInput.disabled = true;
                    messageDiv.innerHTML = '<div class="success">' + (data.message || 'Check your email for the 6-digit verification code!') + '</div>';
                    loginBtn.textContent = 'EMAIL SENT!';
                    codeSection.style.display = 'block';
          codeInput.value = '';
                    codeInput.focus();
                    setTimeout(() => {
                        loginBtn.disabled = false;
                        loginBtn.textContent = 'SEND LOGIN CODE';
                    }, 5000);
                } else {
                    messageDiv.innerHTML = '<div class="error">' + (data.error || 'Login failed') + '</div>';
                    loginBtn.disabled = false;
                    loginBtn.textContent = 'SEND LOGIN CODE';
                    pendingEmail = null;
                    emailInput.disabled = false;
                    codeSection.style.display = 'none';
                }

            } catch (error) {
                messageDiv.innerHTML = '<div class="error">Network error. Please try again.</div>';
                console.error('Login error:', error);
                loginBtn.disabled = false;
                loginBtn.textContent = 'SEND LOGIN CODE';
                pendingEmail = null;
                emailInput.disabled = false;
                codeSection.style.display = 'none';
            }
        }
        async function verifyCode() {
            const codeInput = document.getElementById('codeInput');
            const verifyBtn = document.getElementById('verifyBtn');
            const messageDiv = document.getElementById('authMessage');
            const emailInput = document.getElementById('emailInput');
            const codeSection = document.getElementById('codeSection');
            const code = codeInput.value.trim();
            
            if (!pendingEmail) {
                messageDiv.innerHTML = '<div class="error">Please request a code first.</div>';
                return;
            }
            
            if (!code) {
                messageDiv.innerHTML = '<div class="error">Enter the verification code from your email.</div>';
                return;
            }
            
            verifyBtn.disabled = true;
            verifyBtn.textContent = 'VERIFYING...';
            messageDiv.innerHTML = '';
            
            try {
                const response = await fetch('/api/auth/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: pendingEmail, code })
                });
                
                const data = await response.json();
                
                if (response.ok && data.success) {
                    messageDiv.innerHTML = '<div class="success">Verification successful! Redirecting...</div>';
                    codeInput.value = '';
                    pendingEmail = null;
                    emailInput.disabled = false;
                    emailInput.value = '';
                    document.getElementById('loginBtn').disabled = false;
                    document.getElementById('loginBtn').textContent = 'SEND LOGIN CODE';
                    codeSection.style.display = 'none';
                    verifyBtn.disabled = false;
                    verifyBtn.textContent = 'VERIFY CODE';
                    await checkAuth();
                    await loadMemes();
                } else {
                    messageDiv.innerHTML = '<div class="error">' + (data.error || 'Verification failed. Please try again.') + '</div>';
                    verifyBtn.disabled = false;
                    verifyBtn.textContent = 'VERIFY CODE';
                }
            } catch (error) {
                console.error('Verification error:', error);
                messageDiv.innerHTML = '<div class="error">Verification failed. Please try again.</div>';
                verifyBtn.disabled = false;
                verifyBtn.textContent = 'VERIFY CODE';
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
        const authorDisplay = meme.author_username ? '@' + meme.author_username : (meme.author_name || meme.author || meme.author_email || 'Anonymous');
                
                const memeDiv = document.createElement('div');
                memeDiv.className = 'meme-item';
                
                // Build interactions display
                let interactionsHtml = '';
                if (meme.interactions && meme.interactions.length > 0) {
                    interactionsHtml = '<div class="interactions-list">';
                    meme.interactions.slice(0, 3).forEach(interaction => {
            const userName = interaction.user_username ? '@' + interaction.user_username : (interaction.user_name || 'Anonymous');
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
            'By ' + authorDisplay + ' • ' + formatTimeAgo(meme.created_at) + ' • ' + interactionCount + ' interactions' +
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