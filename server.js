const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'data.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// ============== CONFIGURACIÓN DE GITHUB ==============
// ⚠️ CONFIGURAR ESTO (te explico abajo cómo):
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';  // 'usuario/repo'
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

let pendingSave = null;
let saveTimer = null;
let savingToGitHub = false;

// ============== UTILIDADES ==============
function readJSON(file, defaultValue = {}) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (e) {
    console.error('Error leyendo ' + file, e);
  }
  return defaultValue;
}

function writeJSON(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error('Error escribiendo ' + file, e);
    return false;
  }
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'linkgo_salt_2024_secure').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ============== GUARDAR EN GITHUB ==============
function githubRequest(method, filePath, content) {
  return new Promise((resolve, reject) => {
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
      reject(new Error('GitHub no configurado'));
      return;
    }
    const [owner, repo] = GITHUB_REPO.split('/');
    const url = `/repos/${owner}/${repo}/contents/${filePath}`;
    
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: url,
      method: method,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'linkgo-server',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(data.message || 'Error GitHub: ' + res.statusCode));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    
    const payload = {
      message: `Update ${filePath}`,
      branch: GITHUB_BRANCH,
      content: Buffer.from(content).toString('base64')
    };
    
    // Para PUT necesitamos el SHA del archivo existente
    if (method === 'PUT') {
      const getOptions = { ...options, path: url, method: 'GET' };
      const getReq = https.request(getOptions, (getRes) => {
        let getBody = '';
        getRes.on('data', chunk => getBody += chunk);
        getRes.on('end', () => {
          try {
            const existing = JSON.parse(getBody);
            if (existing.sha) {
              payload.sha = existing.sha;
              req.write(JSON.stringify(payload));
              req.end();
            } else {
              // Archivo no existe, solo crear
              req.write(JSON.stringify(payload));
              req.end();
            }
          } catch (e) {
            req.write(JSON.stringify(payload));
            req.end();
          }
        });
      });
      getReq.on('error', reject);
      getReq.end();
    } else {
      req.write(JSON.stringify(payload));
      req.end();
    }
  });
}

async function syncToGitHub() {
  if (savingToGitHub || !GITHUB_TOKEN || !GITHUB_REPO) return;
  savingToGitHub = true;
  try {
    const dataContent = fs.readFileSync(DATA_FILE, 'utf-8');
    const usersContent = fs.readFileSync(USERS_FILE, 'utf-8');
    const sessionsContent = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    
    await githubRequest('PUT', 'data.json', dataContent);
    console.log('✅ data.json sincronizado a GitHub');
    await githubRequest('PUT', 'users.json', usersContent);
    console.log('✅ users.json sincronizado a GitHub');
    await githubRequest('PUT', 'sessions.json', sessionsContent);
    console.log('✅ sessions.json sincronizado a GitHub');
  } catch (e) {
    console.error('❌ Error sincronizando a GitHub:', e.message);
  }
  savingToGitHub = false;
}

// ============== CARGAR DESDE GITHUB AL INICIAR ==============
async function loadFromGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.log('⚠️ GitHub no configurado, usando archivos locales');
    return false;
  }
  
  const [owner, repo] = GITHUB_REPO.split('/');
  
  async function fetchFile(filePath) {
    return new Promise((resolve, reject) => {
      const url = `/repos/${owner}/${repo}/contents/${filePath}`;
      const options = {
        hostname: 'api.github.com',
        port: 443,
        path: url,
        method: 'GET',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'User-Agent': 'linkgo-server',
          'Accept': 'application/vnd.github.v3+json'
        }
      };
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            const data = JSON.parse(body);
            resolve(Buffer.from(data.content, 'base64').toString('utf-8'));
          } else {
            resolve(null);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }
  
  try {
    const dataContent = await fetchFile('data.json');
    const usersContent = await fetchFile('users.json');
    const sessionsContent = await fetchFile('sessions.json');
    
    if (dataContent) {
      fs.writeFileSync(DATA_FILE, dataContent);
      console.log('✅ data.json descargado de GitHub');
    }
    if (usersContent) {
      fs.writeFileSync(USERS_FILE, usersContent);
      console.log('✅ users.json descargado de GitHub');
    }
    if (sessionsContent) {
      fs.writeFileSync(SESSIONS_FILE, sessionsContent);
      console.log('✅ sessions.json descargado de GitHub');
    }
    return true;
  } catch (e) {
    console.error('❌ Error cargando desde GitHub:', e.message);
    return false;
  }
}

// ============== INICIALIZAR ==============
console.log('🚀 Iniciando Linkgo CRM Server...');

// Crear archivos por defecto si no existen
const defaultUsers = {
  admin: { 
    pass: hashPassword('1234'), 
    name: 'Administrador', 
    role: 'admin',
    created: Date.now()
  }
};

if (!fs.existsSync(USERS_FILE)) {
  writeJSON(USERS_FILE, defaultUsers);
}
if (!fs.existsSync(SESSIONS_FILE)) {
  writeJSON(SESSIONS_FILE, {});
}
if (!fs.existsSync(DATA_FILE)) {
  writeJSON(DATA_FILE, { 
    data: [], 
    nid: 1, 
    activity: [], 
    asesores: ['V - Xiomara Velapatino', 'V - Mariluz Perez', 'V - Brayan Melgarejo', 'V - Gabriela del Pilar', 'Carlos Villarreal'],
    metas: {}, 
    cols: [], 
    ts: 0 
  });
}

// Cargar desde GitHub al iniciar (si está configurado)
loadFromGitHub().then(loaded => {
  if (loaded) console.log('✅ Datos sincronizados desde GitHub');
});

// Sincronizar a GitHub cada 5 minutos automáticamente
setInterval(syncToGitHub, 5 * 60 * 1000);

// ============== MIDDLEWARES ==============
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

function authenticate(req, res, next) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  const sessions = readJSON(SESSIONS_FILE, {});
  const username = sessions[token];
  if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
  const users = readJSON(USERS_FILE, {});
  const user = users[username];
  if (!user) return res.status(401).json({ error: 'Usuario no existe' });
  req.user = { username, name: user.name, role: user.role };
  req.token = token;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Se requiere rol de administrador' });
  }
  next();
}

// ============== AUTENTICACIÓN ==============
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }
  const users = readJSON(USERS_FILE, {});
  const user = users[username];
  if (!user || user.pass !== hashPassword(password)) {
    return res.status(401).json({ error: '❌ Usuario o contraseña incorrectos' });
  }
  const token = generateToken();
  const sessions = readJSON(SESSIONS_FILE, {});
  sessions[token] = username;
  writeJSON(SESSIONS_FILE, sessions);
  scheduleSync();
  res.json({
    token,
    user: { username, name: user.name, role: user.role }
  });
});

app.post('/api/auth/logout', authenticate, (req, res) => {
  const sessions = readJSON(SESSIONS_FILE, {});
  delete sessions[req.token];
  writeJSON(SESSIONS_FILE, sessions);
  scheduleSync();
  res.json({ ok: true });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// ============== DATOS DEL CRM ==============
app.get('/api/data', authenticate, (req, res) => {
  const data = readJSON(DATA_FILE, {});
  const users = readJSON(USERS_FILE, {});
  const safeUsers = {};
  Object.keys(users).forEach(u => {
    safeUsers[u] = { name: users[u].name, role: users[u].role };
  });
  res.json({ ...data, users: safeUsers });
});

app.post('/api/data', authenticate, (req, res) => {
  const data = req.body;
  if (typeof data !== 'object' || data === null) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }
  const clean = { ...data };
  delete clean.users;
  clean.ts = Date.now();
  writeJSON(DATA_FILE, clean);
  scheduleSync();
  res.json({ ok: true, ts: clean.ts });
});

// ============== USUARIOS ==============
app.get('/api/users', authenticate, (req, res) => {
  const users = readJSON(USERS_FILE, {});
  const safeUsers = {};
  Object.keys(users).forEach(u => {
    safeUsers[u] = {
      name: users[u].name,
      role: users[u].role,
      created: users[u].created
    };
  });
  res.json({ users: safeUsers });
});

app.post('/api/users', authenticate, requireAdmin, (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son obligatorios' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'El usuario debe tener al menos 3 caracteres' });
  }
  if (password.length < 3) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 3 caracteres' });
  }
  const users = readJSON(USERS_FILE, {});
  if (users[username]) {
    return res.status(400).json({ error: 'Ese usuario ya existe' });
  }
  users[username] = {
    pass: hashPassword(password),
    name: name || username,
    role: role || 'asesor',
    created: Date.now()
  };
  writeJSON(USERS_FILE, users);
  scheduleSync();
  res.json({ ok: true, user: { username, name: users[username].name, role: users[username].role } });
});

app.put('/api/users/:username', authenticate, requireAdmin, (req, res) => {
  const { username } = req.params;
  const { password, name, role } = req.body || {};
  const users = readJSON(USERS_FILE, {});
  if (!users[username]) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (password) {
    if (password.length < 3) return res.status(400).json({ error: 'Contraseña muy corta' });
    users[username].pass = hashPassword(password);
  }
  if (name) users[username].name = name;
  if (role) users[username].role = role;
  writeJSON(USERS_FILE, users);
  scheduleSync();
  res.json({ ok: true });
});

app.delete('/api/users/:username', authenticate, requireAdmin, (req, res) => {
  const { username } = req.params;
  if (username === 'admin') {
    return res.status(400).json({ error: 'No se puede eliminar el usuario admin principal' });
  }
  const users = readJSON(USERS_FILE, {});
  if (!users[username]) return res.status(404).json({ error: 'Usuario no encontrado' });
  delete users[username];
  writeJSON(USERS_FILE, users);
  const sessions = readJSON(SESSIONS_FILE, {});
  Object.keys(sessions).forEach(t => { if (sessions[t] === username) delete sessions[t]; });
  writeJSON(SESSIONS_FILE, sessions);
  scheduleSync();
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    ok: true, 
    ts: Date.now(),
    github: !!(GITHUB_TOKEN && GITHUB_REPO)
  });
});

// ============== SINCRONIZACIÓN PROGRAMADA ==============
function scheduleSync() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    syncToGitHub();
  }, 30000); // Espera 30 segundos antes de subir a GitHub
}

// ============== INICIAR SERVIDOR ==============
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Linkgo CRM corriendo en puerto ${PORT}`);
  console.log(`🔐 Usuario inicial: admin / 1234`);
  console.log(`📦 GitHub sync: ${(GITHUB_TOKEN && GITHUB_REPO) ? '✅ Activado' : '❌ No configurado'}`);
});
