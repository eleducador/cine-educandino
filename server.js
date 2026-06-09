// ══════════════════════════════════════════════
//  AL CINE CON PAPÁ — Servidor Backend
//  Express + WebSocket · Red Local y Render (con MongoDB)
// ══════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// ── Database Schema ───────────────────────────
const stateSchema = new mongoose.Schema({
  id: { type: String, default: 'main' },
  password: { type: String, default: 'educador2024' },
  config: { type: Object, default: {} },
  boletos: { type: Object, default: {} },
  scans: { type: Array, default: [] }
}, { minimize: false, strict: false });

const State = mongoose.model('State', stateSchema);

// ── Default state ──────────────────────────────
const DEFAULT_STATE = {
  password: 'educador2024',
  config: {
    precioPadre: 15000,
    precioHijo: 8000,
    moneda: 'COP',
    salas: [
      { id: 'sala1', nombre: 'Sala 1', color: '#f5c518', filas: 8, columnas: 10 },
      { id: 'sala2', nombre: 'Sala 2', color: '#ff6b6b', filas: 8, columnas: 10 },
      { id: 'sala3', nombre: 'Sala 3', color: '#82aaff', filas: 8, columnas: 10 }
    ],
    peliculas: [
      { id: 'p1', titulo: 'El León Rey', sala: 'sala1', hora: '10:00' },
      { id: 'p2', titulo: 'Rápidos y Furiosos X', sala: 'sala2', hora: '10:30' },
      { id: 'p3', titulo: 'Spider-Man: Sin Camino a Casa', sala: 'sala3', hora: '11:00' }
    ]
  },
  boletos: {},
  scans: []
};

// ── Connect to MongoDB ────────────────────────
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Conectado a MongoDB'))
    .catch(err => console.error('❌ Error conectando a MongoDB:', err.message));
} else {
  console.log('⚠️ ADVERTENCIA: No se ha configurado MONGODB_URI.');
  console.log('   Si estás probando localmente, los datos se reiniciarán al cerrar el servidor.');
  // Emulate local memory if no URI is provided (just for testing)
  let localMemoryDB = JSON.parse(JSON.stringify(DEFAULT_STATE));
}

// ── DB helpers ────────────────────────────────
async function loadDB() {
  if (!MONGODB_URI) return global.localMemoryDB || JSON.parse(JSON.stringify(DEFAULT_STATE));

  try {
    let stateDoc = await State.findOne({ id: 'main' });
    if (!stateDoc) {
      stateDoc = new State({ id: 'main', ...DEFAULT_STATE });
      await stateDoc.save();
    }
    const doc = stateDoc.toObject();
    return doc;
  } catch (e) {
    console.error('Error loading DB:', e.message);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

async function saveDB(stateObj) {
  if (!MONGODB_URI) {
    global.localMemoryDB = JSON.parse(JSON.stringify(stateObj));
    return;
  }

  try {
    let doc = await State.findOne({ id: 'main' });
    if (!doc) {
      doc = new State({ id: 'main', ...stateObj });
    } else {
      doc.password = stateObj.password;
      doc.config = stateObj.config;
      doc.boletos = stateObj.boletos;
      doc.scans = stateObj.scans;
      
      // Force Mongoose to recognize changes in nested objects
      doc.markModified('config');
      doc.markModified('boletos');
      doc.markModified('scans');
    }
    await doc.save();
  } catch (e) {
    console.error('Error saving DB:', e.message);
  }
}

// ── WebSocket broadcast ───────────────────────
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  });
}

wss.on('connection', async (ws) => {
  console.log('📱 Cliente conectado via WebSocket');
  const state = await loadDB();
  ws.send(JSON.stringify({ event: 'init', data: state }));

  ws.on('close', () => console.log('📱 Cliente desconectado'));
  ws.on('error', () => {});
});

// ── Middleware ────────────────────────────────
app.use(express.json());
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Bypass-Tunnel-Reminder');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Helpers ───────────────────────────────────
function generarId() {
  return 'B' + Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).slice(2, 5).toUpperCase();
}

function filaLabel(idx) {
  return String.fromCharCode(65 + idx);
}

function seatLabel(asiento) {
  if (!asiento) return '';
  return `Fila ${filaLabel(asiento.fila)} · Asiento ${asiento.col + 1}`;
}

function getSoldSeats(state, salaId) {
  const sold = new Set();
  Object.values(state.boletos).forEach(b => {
    if (b.sala === salaId && b.asiento) {
      sold.add(`${b.asiento.fila}-${b.asiento.col}`);
    }
  });
  return sold;
}

function getNextAvailableSeat(state, salaId) {
  const sala = state.config.salas.find(s => s.id === salaId);
  if (!sala) return null;
  const sold = getSoldSeats(state, salaId);
  for (let f = 0; f < sala.filas; f++) {
    for (let c = 0; c < sala.columnas; c++) {
      if (!sold.has(`${f}-${c}`)) return { fila: f, col: c };
    }
  }
  return null;
}

function getStats(state) {
  const boletos = Object.values(state.boletos);
  const result = {
    total: boletos.length,
    reservados: boletos.filter(b => b.estado === 'reservado').length,
    padres: boletos.filter(b => b.tipo === 'padre' && b.estado !== 'reservado').length,
    hijos: boletos.filter(b => b.tipo === 'hijo' && b.estado !== 'reservado').length,
    escaneados: boletos.filter(b => b.escaneado).length,
    escaneadosPadres: boletos.filter(b => b.tipo === 'padre' && b.escaneado).length,
    escaneadosHijos: boletos.filter(b => b.tipo === 'hijo' && b.escaneado).length,
    ingresoPadres: 0, ingresoHijos: 0, ingresoTotal: 0,
    salas: {}
  };
  result.ingresoPadres = result.padres * state.config.precioPadre;
  result.ingresoHijos = result.hijos * state.config.precioHijo;
  result.ingresoTotal = result.ingresoPadres + result.ingresoHijos;

  state.config.salas.forEach(sala => {
    const sb = boletos.filter(b => b.sala === sala.id);
    result.salas[sala.id] = {
      nombre: sala.nombre,
      total: sb.length,
      reservados: sb.filter(b => b.estado === 'reservado').length,
      padres: sb.filter(b => b.tipo === 'padre' && b.estado !== 'reservado').length,
      hijos: sb.filter(b => b.tipo === 'hijo' && b.estado !== 'reservado').length,
      escaneados: sb.filter(b => b.escaneado).length,
      escaneadosPadres: sb.filter(b => b.tipo === 'padre' && b.escaneado).length,
      escaneadosHijos: sb.filter(b => b.tipo === 'hijo' && b.escaneado).length,
      ingreso: sb.filter(b => b.tipo === 'padre' && b.estado !== 'reservado').length * state.config.precioPadre +
               sb.filter(b => b.tipo === 'hijo' && b.estado !== 'reservado').length * state.config.precioHijo
    };
  });
  return result;
}

// ── API Routes ────────────────────────────────

app.get('/api/state', async (req, res) => {
  const state = await loadDB();
  res.json(state);
});

app.get('/api/stats', async (req, res) => {
  const state = await loadDB();
  res.json(getStats(state));
});

app.post('/api/boletos', async (req, res) => {
  const { tipo, salaId, peliculaId, asiento, cantidad, estado } = req.body;
  if (!tipo || !salaId || !peliculaId) {
    return res.status(400).json({ error: 'Faltan campos: tipo, salaId, peliculaId' });
  }

  const state = await loadDB();
  const count = Math.min(cantidad || 1, 100);
  const created = [];
  const estadoBoleto = estado || 'pagado';

  for (let i = 0; i < count; i++) {
    const id = generarId();
    let seat = asiento || null;
    if (!seat && count === 1) {
      seat = getNextAvailableSeat(state, salaId);
    } else if (count > 1) {
      seat = getNextAvailableSeat(state, salaId);
    }
    state.boletos[id] = {
      id, tipo, sala: salaId, pelicula: peliculaId,
      asiento: seat,
      estado: estadoBoleto,
      vendido: true, escaneado: false,
      creadoAt: new Date().toISOString(),
      escaneadoAt: null, escaneadoEn: null
    };
    created.push(state.boletos[id]);
  }

  await saveDB(state);
  broadcast('update', { type: 'boleto_created', boletos: created, stats: getStats(state) });
  res.json({ ok: true, boletos: created });
});

app.post('/api/scan', async (req, res) => {
  const { qrPayload, salaScanId } = req.body;
  if (!qrPayload) return res.status(400).json({ error: 'qrPayload requerido' });

  let boletoId = null;
  try {
    const obj = JSON.parse(qrPayload);
    if (obj.app === 'alcinepapa' && obj.id) boletoId = obj.id;
  } catch {
    if (/^B[A-Z0-9]+$/.test(qrPayload.trim())) boletoId = qrPayload.trim();
  }

  if (!boletoId) {
    return res.json({ ok: false, tipo: 'invalid', msg: 'QR no reconocido', detail: 'Este código no pertenece al sistema.' });
  }

  const state = await loadDB();
  const b = state.boletos[boletoId];

  if (!b) {
    return res.json({ ok: false, tipo: 'invalid', msg: 'Boleto no encontrado', detail: 'El código QR no existe en la base de datos.' });
  }

  if (b.escaneado) {
    const when = new Date(b.escaneadoAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    const salaName = (state.config.salas.find(s => s.id === b.escaneadoEn) || {}).nombre || b.escaneadoEn;
    return res.json({ ok: false, tipo: 'warn', msg: '¡Boleto ya usado!', detail: `Ingresó a las ${when} por ${salaName}` });
  }

  if (salaScanId && b.sala !== salaScanId) {
    const salaName = (state.config.salas.find(s => s.id === b.sala) || {}).nombre || b.sala;
    return res.json({ ok: false, tipo: 'invalid', msg: 'Sala incorrecta', detail: `Este boleto es para ${salaName}` });
  }

  const now = new Date().toISOString();
  state.boletos[boletoId].escaneado = true;
  state.boletos[boletoId].escaneadoAt = now;
  state.boletos[boletoId].escaneadoEn = salaScanId || b.sala;
  const scanEntry = {
    boletoId, tipo: b.tipo, sala: state.boletos[boletoId].escaneadoEn,
    pelicula: b.pelicula, asiento: b.asiento, at: now
  };
  state.scans.push(scanEntry);
  await saveDB(state);

  const tipoLabel = b.tipo === 'padre' ? '👨 Padre' : '👧 Hijo/a';
  const pel = state.config.peliculas.find(p => p.id === b.pelicula);
  const salaUsada = state.config.salas.find(s => s.id === (salaScanId || b.sala));
  const asientoStr = b.asiento ? ` · ${seatLabel(b.asiento)}` : '';

  broadcast('update', { type: 'scan', scan: scanEntry, stats: getStats(state) });

  res.json({
    ok: true, tipo: 'valid',
    msg: `¡Bienvenido! ${tipoLabel}`,
    detail: `${pel ? pel.titulo : ''} · ${salaUsada ? salaUsada.nombre : ''}${asientoStr}`,
    boleto: state.boletos[boletoId], pelicula: pel
  });
});

app.put('/api/config', async (req, res) => {
  const { password, config } = req.body;
  const state = await loadDB();
  if (password !== undefined) state.password = password;
  if (config !== undefined) state.config = { ...state.config, ...config };
  await saveDB(state);
  broadcast('update', { type: 'config', config: state.config });
  res.json({ ok: true });
});

app.post('/api/auth', async (req, res) => {
  const { password } = req.body;
  const state = await loadDB();
  res.json({ ok: password === state.password });
});

app.delete('/api/reset', async (req, res) => {
  const state = await loadDB();
  state.boletos = {};
  state.scans = [];
  await saveDB(state);
  broadcast('update', { type: 'reset' });
  res.json({ ok: true });
});

app.get('/api/boletos/:id', async (req, res) => {
  const state = await loadDB();
  const b = state.boletos[req.params.id];
  if (!b) return res.status(404).json({ error: 'No encontrado' });
  res.json(b);
});

app.delete('/api/boletos/:id', async (req, res) => {
  const state = await loadDB();
  const b = state.boletos[req.params.id];
  if (!b) return res.status(404).json({ error: 'No encontrado' });
  
  delete state.boletos[req.params.id];
  await saveDB(state);
  
  broadcast('update', { type: 'boleto_deleted', id: req.params.id, stats: getStats(state) });
  res.json({ ok: true });
});

app.put('/api/boletos/:id/pagar', async (req, res) => {
  const state = await loadDB();
  const b = state.boletos[req.params.id];
  if (!b) return res.status(404).json({ error: 'No encontrado' });
  
  b.estado = 'pagado';
  await saveDB(state);
  
  broadcast('update', { type: 'boleto_updated', boleto: b, stats: getStats(state) });
  res.json({ ok: true, boleto: b });
});

// ── Start ─────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
    if (localIP !== 'localhost') break;
  }

  console.log('\n🎬 ═══════════════════════════════════════');
  console.log('   AL CINE CON PAPÁ — Servidor iniciado');
  console.log('═════════════════════════════════════════');
  console.log(`\n   🖥️  En este PC:     http://localhost:${PORT}`);
  console.log(`   📱  Otros disp.:   http://${localIP}:${PORT}`);
  console.log('\n═════════════════════════════════════════\n');
});
