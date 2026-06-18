const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'data.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// ============== UTILIDADES ==============
function readJSON(file, defaultValue = {}) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2));
      return defaultValue;
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error('Error leyendo ' + file, e);
    return defaultValue;
  }
}

function writeJSON(file, data) {
  // Escritura atómica para evitar corrupciones
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'linkgo_salt_2024_secure').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ============== INICIALIZAR ARCHIVOS ==============
readJSON(USERS_FILE, {
  admin: { pass: hashPassword('1234'), name: 'Administrador', role: 'admin', created: Date.now() }
});
readJSON(SESSIONS_FILE, {});
readJSON(DATA_FILE, { data: [], nid: 1, activity: [], asesores: [], metas: {}, cols: [], ts: 0 });

// ============== MIDDLEWARES ==============
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

// Caché deshabilitado para que no se quede con datos viejos
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
  res.json({
    token,
    user: { username, name: user.name, role: user.role }
  });
});

app.post('/api/auth/logout', authenticate, (req, res) => {
  const sessions = readJSON(SESSIONS_FILE, {});
  delete sessions[req.token];
  writeJSON(SESSIONS_FILE, sessions);
  res.json({ ok: true });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// ============== DATOS DEL CRM ==============
app.get('/api/data', authenticate, (req, res) => {
  const data = readJSON(DATA_FILE, {});
  // Nunca enviar contraseñas
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
  // Proteger: nunca permitir modificar usuarios por esta vía
  const clean = { ...data };
  delete clean.users;
  clean.ts = Date.now();
  writeJSON(DATA_FILE, clean);
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
  // Invalidar sesiones de ese usuario
  const sessions = readJSON(SESSIONS_FILE, {});
  Object.keys(sessions).forEach(t => { if (sessions[t] === username) delete sessions[t]; });
  writeJSON(SESSIONS_FILE, sessions);
  res.json({ ok: true });
});

// ============== HEALTH CHECK ==============
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ============== INICIAR SERVIDOR ==============
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Linkgo CRM corriendo en puerto ' + PORT);
  console.log('📱 Abre: http://localhost:' + PORT);
  console.log('🔐 Usuario inicial: admin / 1234');
});
