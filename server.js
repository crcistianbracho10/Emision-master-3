const { spawn } = require('child_process');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 8080);

const DATASET_REPO_ID = process.env.DATASET_REPO_ID || 'cristianbracho904/programacion-tv';
const DATASET_BRANCH = process.env.DATASET_BRANCH || 'main';
const HF_TOKEN = process.env.HF_TOKEN || '';
const RTMP_URL = (process.env.RTMP_URL || '').trim();
const RTMP_PUENTE_PUERTO = 9999;

const GIST_FALLBACK_URL =
  'https://gist.githubusercontent.com/crcistianbracho10/6e4a07d268460ea807abf28f77c3880e/raw';

const FALLBACK_IMAGE =
  'https://www.dropbox.com/scl/fi/x9xpsosc6mlmn5rw8e2at/Copilot_20260224_002036.png?rlkey=340kgc42pa64ytajhzv0vl53b&st=qr7ly3ru&dl=1';

const HIMNO_OFICIAL_URL = 'https://files.catbox.moe/zvee4n.mp4';
const ARCHIVO_ESTADO_PERSISTENTE = '/tmp/estado_episodios.json';
const DIR_OVERRIDES = '/tmp/overrides';

const PERFIL = {
  nombre: '720p Ahorro',
  ancho: 1280,
  alto: 720,
  bitrateVideo: Math.max(300, Number.parseInt(process.env.BITRATE_VIDEO, 10) || 700),
  preset: 'ultrafast'
};

const BITRATE_AUDIO = Math.max(32, Number.parseInt(process.env.BITRATE_AUDIO, 10) || 64);
const FPS_SALIDA = 24;
const GOP_SEGUNDOS = 2;
const HILOS = Math.max(1, Number.parseInt(process.env.FFMPEG_THREADS, 10) || 2);

const LOGO_URL = (process.env.LOGO_URL || '').trim();
const LOGO_TAMANO = Math.max(30, Number.parseInt(process.env.LOGO_TAMANO, 10) || 180);
const LOGO_X = Math.max(0, Number.parseInt(process.env.LOGO_X, 10) || 120);
const LOGO_Y = Math.max(0, Number.parseInt(process.env.LOGO_Y, 10) || 50);

const HIMNO_VENTANA_MIN = 10;
const MAX_ESPERA_FRAME_MS = 30000;
const DIR_OVERRIDES_PATH = DIR_OVERRIDES;

fs.mkdirSync(DIR_OVERRIDES_PATH, { recursive: true });

const logBuffer = [];
const consoleLogOriginal = console.log.bind(console);
console.log = (...args) => {
  consoleLogOriginal(...args);
  const hora = new Date().toLocaleTimeString('en-GB', {
    timeZone: 'America/Caracas',
    hour12: false
  });
  logBuffer.push(`${hora} ${args.map(a => String(a)).join(' ')}`);
  if (logBuffer.length > 200) logBuffer.shift();
};

const estadoActualTransmision = {
  tituloActual: 'Iniciando señal...',
  programaActual: 'Canal C',
  aContinuacion: 'Cargando programación...',
  horaVenezuela: '--:--:--',
  estado: 'Iniciando'
};

let datasetConfig = {
  vivo: [],
  programacion: [],
  himno: [
    { url: HIMNO_OFICIAL_URL, inicio: '00:00:00' },
    { url: HIMNO_OFICIAL_URL, inicio: '06:00:00' },
    { url: HIMNO_OFICIAL_URL, inicio: '18:00:00' }
  ],
  intros: [],
  publicidad: [],
  clasificacion: [],
  evento: [],
  magazine: [],
  secretosProsperidad: [],
  cartasTaron: [],
  playlistGist: []
};

const CLAVES_DATASET = {
  programacion: 'programacion.txt',
  vivo: 'vivo.txt',
  publicidad: 'publicidad.txt',
  intros: 'intros.txt',
  clasificacion: 'clasificacion.txt',
  evento: 'evento.txt',
  magazine: 'programas/magazine.txt',
  secretosProsperidad: 'programas/secretos-de-prosperidad.txt',
  cartasTaron: 'programas/cartas-taron.txt'
};

let indicesProgramas = {};
let indiceGistActual = 0;
let ultimoHimnoReproducido = '';
let procesoActual = null;
let procesoRtmp = null;
let logoPath = null;
let sincronizando = false;
let apagando = false;

function cargarEstadoPersistente() {
  try {
    if (fs.existsSync(ARCHIVO_ESTADO_PERSISTENTE)) {
      indicesProgramas = JSON.parse(fs.readFileSync(ARCHIVO_ESTADO_PERSISTENTE, 'utf8'));
    }
  } catch {
    indicesProgramas = {};
  }
}

function guardarEstadoPersistente() {
  try {
    fs.writeFileSync(ARCHIVO_ESTADO_PERSISTENTE, JSON.stringify(indicesProgramas, null, 2));
  } catch (e) {
    console.error('[ESTADO] No se pudo guardar el avance:', e.message);
  }
}

cargarEstadoPersistente();

function obtenerTiempoVenezuela() {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Caracas',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const valor = tipo => partes.find(p => p.type === tipo)?.value || '00';
  const h = valor('hour');
  const m = valor('minute');
  const s = valor('second');

  return {
    horaStr: `${h}:${m}`,
    horaCompletaStr: `${h}:${m}:${s}`,
    fechaStr: `${valor('year')}-${valor('month')}-${valor('day')}`,
    h: Number(h),
    m: Number(m)
  };
}

function diaSemanaVenezuela() {
  const dia = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Caracas',
    weekday: 'short'
  }).format(new Date());

  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[dia];
}

function convertirSegundos(horaStr) {
  if (!horaStr) return 0;
  const p = horaStr.split(':').map(Number);
  return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
}

function sumarSegundosHora(horaStr, segundos) {
  const t = (convertirSegundos(horaStr) + segundos) % 86400;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

function estaEnHorario(inicio, fin, horaActual) {
  const a = convertirSegundos(inicio);
  const b = convertirSegundos(fin);
  const c = convertirSegundos(horaActual);
  return a <= b ? c >= a && c < b : c >= a || c < b;
}

function segundosHasta(horaFin) {
  const ahora = obtenerTiempoVenezuela();
  let diferencia = convertirSegundos(horaFin) - convertirSegundos(ahora.horaCompletaStr);
  if (diferencia < 0) diferencia += 86400;
  return Math.max(1, diferencia);
}

// Endpoints mínimos para comprobar que el contenedor está activo.
// No se sirve una página de reproducción.
app.get('/', (_req, res) => res.status(200).send('Canal C del Zulia - Servicio de transmisión activo.'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, estado: estadoActualTransmision }));
app.get('/api/estado', (_req, res) => res.json(estadoActualTransmision));
app.get('/api/logs', (_req, res) => res.type('text/plain').send(logBuffer.join('\n')));

async function descargarArchivoDataset(nombreArchivo) {
  try {
    const url = `https://huggingface.co/datasets/${DATASET_REPO_ID}/raw/${DATASET_BRANCH}/${nombreArchivo}`;
    const headers = HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {};
    const respuesta = await axios.get(url, { headers, timeout: 12000 });
    return typeof respuesta.data === 'string' ? JSON.parse(respuesta.data) : respuesta.data;
  } catch (e) {
    console.error(`[DATASET] No se pudo descargar ${nombreArchivo}: ${e.message}`);
    return null;
  }
}

async function sincronizarDataset() {
  if (sincronizando) return;
  sincronizando = true;

  try {
    let actualizados = 0;

    for (const [clave, archivo] of Object.entries(CLAVES_DATASET)) {
      const remoto = await descargarArchivoDataset(archivo);
      if (Array.isArray(remoto)) {
        datasetConfig[clave] = remoto;
        actualizados++;
      }
    }

    try {
      const respuesta = await axios.get(GIST_FALLBACK_URL, { timeout: 12000 });
      const contenido = Array.isArray(respuesta.data)
        ? respuesta.data
        : JSON.parse(respuesta.data);
      if (Array.isArray(contenido)) datasetConfig.playlistGist = contenido;
    } catch (e) {
      console.error(`[GIST] No se pudo actualizar la lista de respaldo: ${e.message}`);
    }

    console.log(`[DATASET] Sincronización terminada: ${actualizados}/${Object.keys(CLAVES_DATASET).length} listas.`);
  } finally {
    sincronizando = false;
  }
}

function buscarLogoLocal() {
  const carpetas = [...new Set([process.cwd(), __dirname, '/app', '/tmp'])];

  for (const carpeta of carpetas) {
    try {
      const nombre = fs.readdirSync(carpeta).find(f => f.toLowerCase() === 'canal_c.png');
      if (nombre) return path.join(carpeta, nombre);
    } catch {}
  }

  return null;
}

async function prepararLogo() {
  logoPath = null;

  if (LOGO_URL) {
    try {
      const respuesta = await axios.get(LOGO_URL, {
        responseType: 'arraybuffer',
        timeout: 25000
      });
      const destino = '/tmp/Canal_C_logo.png';
      fs.writeFileSync(destino, Buffer.from(respuesta.data));
      logoPath = destino;
      console.log('[LOGO] Logotipo descargado correctamente.');
    } catch (e) {
      console.error(`[LOGO] Falló la descarga del logotipo: ${e.message}`);
    }
  }

  if (!logoPath) logoPath = buscarLogoLocal();

  if (!logoPath || !fs.existsSync(logoPath)) {
    throw new Error('No se encontró Canal_C.png ni se pudo descargar LOGO_URL. Se detiene la emisión para no salir sin logotipo.');
  }

  console.log(`[LOGO] Logotipo listo: ${logoPath}`);
}

function corregirUrl(url) {
  if (!url) return FALLBACK_IMAGE;

  if (url.includes('dropbox.com')) {
    return url
      .replace(/www\.dropbox\.com/, 'dl.dropboxusercontent.com')
      .replace(/\?dl=[01]/, '');
  }

  const prefijoHF = `https://huggingface.co/datasets/${DATASET_REPO_ID}/`;
  if (url.startsWith(prefijoHF)) {
    const coincidencia = url.slice(prefijoHF.length).match(/^(?:resolve|blob|raw)\/[^/]+\/([^?#]+)/);
    if (coincidencia) return `http://127.0.0.1:${port}/_hf/${coincidencia[1]}`;
  }

  return url;
}

function claveListaDePrograma(programa) {
  const archivo = programa?.archivo ? programa.archivo.toLowerCase() : '';
  if (archivo.includes('magazine')) return 'magazine';
  if (archivo.includes('secretos') || archivo.includes('prosperidad')) return 'secretosProsperidad';
  return 'cartasTaron';
}

function obtenerElementoActualEnEmision() {
  const tiempo = obtenerTiempoVenezuela();
  const hora = tiempo.horaStr;
  const completa = tiempo.horaCompletaStr;
  const dia = diaSemanaVenezuela();

  estadoActualTransmision.horaVenezuela = completa;

  // 1. Himno Nacional: una reproducción por cada horario configurado.
  for (const himno of datasetConfig.himno || []) {
    const inicio = himno.inicio || '00:00:00';
    const fin = himno.fin || sumarSegundosHora(inicio, HIMNO_VENTANA_MIN * 60);
    const id = `${tiempo.fechaStr}-${inicio}`;

    if (estaEnHorario(inicio, fin, completa) && ultimoHimnoReproducido !== id) {
      ultimoHimnoReproducido = id;
      estadoActualTransmision.tituloActual = 'Himno Nacional de Venezuela';
      estadoActualTransmision.programaActual = 'Transmisión Oficial';
      estadoActualTransmision.aContinuacion = 'Programación regular';

      return {
        tipo: 'himno',
        secuencia: [{ url: corregirUrl(himno.url || HIMNO_OFICIAL_URL), desc: 'Himno Nacional' }]
      };
    }
  }

  // 2. Retransmisiones en vivo.
  for (const vivo of datasetConfig.vivo || []) {
    if (
      Array.isArray(vivo.dias) &&
      vivo.dias.includes(dia) &&
      estaEnHorario(vivo.inicio, vivo.fin, hora)
    ) {
      estadoActualTransmision.tituloActual = vivo.nombre || 'Retransmisión en vivo';
      estadoActualTransmision.programaActual = 'Retransmisión en Vivo';
      estadoActualTransmision.aContinuacion = 'Programación regular';

      return {
        tipo: 'vivo',
        secuencia: [{
          url: corregirUrl(vivo.url || vivo.video),
          desc: vivo.nombre || 'Retransmisión en vivo',
          maxDuration: segundosHasta(vivo.fin)
        }]
      };
    }
  }

  // 3. Programación regular.
  for (const programa of datasetConfig.programacion || []) {
    if (
      Array.isArray(programa.dias) &&
      programa.dias.includes(dia) &&
      estaEnHorario(programa.inicio, programa.fin, hora)
    ) {
      const claveLista = claveListaDePrograma(programa);
      const lista = datasetConfig[claveLista] || [];
      const claveAvance = `${programa.nombre || 'Programa'}-${programa.inicio || ''}`;

      if (lista.length > 0) {
        let indice = Number(indicesProgramas[claveAvance] || 0);
        if (indice >= lista.length) indice = 0;

        const elemento = lista[indice];
        estadoActualTransmision.tituloActual = programa.nombre || 'Programación';
        estadoActualTransmision.programaActual = programa.nombre || 'Canal C';
        estadoActualTransmision.aContinuacion = 'Siguiente contenido del programa';

        return {
          tipo: 'programa',
          secuencia: [{
            url: corregirUrl(elemento.video || elemento.url),
            desc: `${programa.nombre || 'Programa'} (${indice + 1}/${lista.length})`,
            alTerminar: () => {
              indicesProgramas[claveAvance] = (indice + 1) % lista.length;
              guardarEstadoPersistente();
            }
          }]
        };
      }
    }
  }

  // 4. Gist de respaldo rotativo.
  if (datasetConfig.playlistGist.length > 0) {
    if (indiceGistActual >= datasetConfig.playlistGist.length) indiceGistActual = 0;
    const elemento = datasetConfig.playlistGist[indiceGistActual++];
    estadoActualTransmision.tituloActual = elemento.title || 'Canal C - Respaldo';
    estadoActualTransmision.programaActual = 'Programación de respaldo';
    estadoActualTransmision.aContinuacion = 'Lista de respaldo';

    return {
      tipo: 'gist',
      secuencia: [{
        url: corregirUrl(elemento.video || elemento.url),
        desc: elemento.title || 'Vídeo de respaldo'
      }]
    };
  }

  estadoActualTransmision.tituloActual = 'Señal de ajuste';
  estadoActualTransmision.programaActual = 'Mantenimiento';
  estadoActualTransmision.aContinuacion = 'Esperando programación';

  return {
    tipo: 'fallback',
    secuencia: [{ url: FALLBACK_IMAGE, desc: 'Imagen de ajuste' }]
  };
}

// Proxy local para archivos del Dataset de Hugging Face.
// Solo acepta peticiones originadas dentro del propio contenedor.
app.use('/_hf', async (req, res) => {
  const ip = req.socket?.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
    return res.status(403).end();
  }

  const ruta = decodeURIComponent((req.path || '').replace(/^\/+/, ''));
  const url = `https://huggingface.co/datasets/${DATASET_REPO_ID}/resolve/${DATASET_BRANCH}/${ruta}`;

  try {
    const headers = HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {};
    const respuesta = await axios.get(url, {
      headers,
      responseType: 'stream',
      timeout: 20000
    });
    respuesta.data.pipe(res);
    respuesta.data.on('error', () => res.destroy());
  } catch (e) {
    console.error(`[HF PROXY] Error al obtener ${ruta}: ${e.message}`);
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  }
});

function iniciarRTMP() {
  if (!RTMP_URL || apagando) return;

  console.log('[RTMP] Iniciando salida RTMP mediante puente local.');

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+genpts',
    '-i', `udp://127.0.0.1:${RTMP_PUENTE_PUERTO}?fifo_size=1000000&overrun_nonfatal=1`,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-flvflags', 'no_duration_filesize',
    '-f', 'flv',
    RTMP_URL
  ];

  procesoRtmp = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  procesoRtmp.stderr.on('data', dato => {
    const mensaje = dato.toString().trim();
    if (mensaje) console.error(`[RTMP] ${mensaje}`);
  });

  procesoRtmp.on('error', error => {
    console.error(`[RTMP] No se pudo iniciar FFmpeg: ${error.message}`);
  });

  procesoRtmp.on('close', codigo => {
    procesoRtmp = null;
    if (!apagando) {
      console.error(`[RTMP] El proceso terminó (${codigo}). Reintentando en 5 segundos.`);
      setTimeout(iniciarRTMP, 5000);
    }
  });
}

function crearArgumentosEmision(video) {
  const url = corregirUrl(video.url);
  const posicionLogoX = LOGO_X;

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats_period', '2',
    '-threads', String(HILOS),
    '-filter_complex_threads', '1',
    '-re',
    '-i', url,
    '-loop', '1',
    '-i', logoPath
  ];

  const filtros =
    `[0:v:0]fps=${FPS_SALIDA},scale=${PERFIL.ancho}:${PERFIL.alto}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${PERFIL.ancho}:${PERFIL.alto}:(ow-iw)/2:(oh-ih)/2,setsar=1[base];` +
    `[1:v:0]scale=${LOGO_TAMANO}:${LOGO_TAMANO}:force_original_aspect_ratio=decrease[logo];` +
    `[base][logo]overlay=${posicionLogoX}:${LOGO_Y}:format=auto:shortest=1,format=yuv420p[v]`;

  args.push(
    '-filter_complex', filtros,
    '-map', '[v]',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', PERFIL.preset,
    '-tune', 'zerolatency',
    '-threads', String(HILOS),
    '-pix_fmt', 'yuv420p',
    '-r', String(FPS_SALIDA),
    '-b:v', `${PERFIL.bitrateVideo}k`,
    '-maxrate', `${Math.round(PERFIL.bitrateVideo * 1.25)}k`,
    '-bufsize', `${PERFIL.bitrateVideo * 2}k`,
    '-g', String(FPS_SALIDA * GOP_SEGUNDOS),
    '-keyint_min', String(FPS_SALIDA * GOP_SEGUNDOS),
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', `${BITRATE_AUDIO}k`,
    '-ac', '2',
    '-ar', '44100',
    '-max_muxing_queue_size', '1024'
  );

  if (video.maxDuration && Number(video.maxDuration) > 0) {
    args.push('-t', String(Math.floor(Number(video.maxDuration))));
  }

  args.push(
    '-f', 'mpegts',
    `udp://127.0.0.1:${RTMP_PUENTE_PUERTO}?pkt_size=1316`
  );

  return args;
}

async function emitirElemento(video) {
  if (!video.url) {
    console.error(`[EMISIÓN] Elemento sin URL: ${video.desc || 'sin título'}`);
    return;
  }

  console.log(`[AL AIRE] ${video.desc || 'Contenido'} | Perfil ${PERFIL.nombre}`);
  estadoActualTransmision.estado = 'Transmitiendo';

  const args = crearArgumentosEmision(video);

  await new Promise(resolve => {
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    procesoActual = ffmpeg;
    let ultimoFrame = Date.now();
    let finalizado = false;

    const terminar = () => {
      if (finalizado) return;
      finalizado = true;
      clearInterval(vigilante);
      if (procesoActual === ffmpeg) procesoActual = null;

      if (typeof video.alTerminar === 'function') {
        try { video.alTerminar(); } catch (e) {
          console.error(`[PROGRAMACIÓN] Error al avanzar lista: ${e.message}`);
        }
      }
      resolve();
    };

    ffmpeg.stderr.on('data', dato => {
      const mensaje = dato.toString();
      if (mensaje.includes('frame=')) ultimoFrame = Date.now();
      if (/error|invalid|failed|not found/i.test(mensaje)) {
        console.error(`[FFMPEG ${video.desc || ''}] ${mensaje.trim()}`);
      }
    });

    ffmpeg.on('error', error => {
      console.error(`[FFMPEG] No se pudo iniciar: ${error.message}`);
      terminar();
    });

    const vigilante = setInterval(() => {
      if (Date.now() - ultimoFrame > MAX_ESPERA_FRAME_MS) {
        console.error(`[VIGILANTE] Sin nuevos frames durante ${MAX_ESPERA_FRAME_MS / 1000}s. Se reiniciará el elemento.`);
        try { ffmpeg.kill('SIGKILL'); } catch {}
      }
    }, 5000);

    ffmpeg.on('close', codigo => {
      console.log(`[FFMPEG] Elemento finalizado. Código: ${codigo}`);
      terminar();
    });
  });
}

async function motorCanalC() {
  try {
    if (!RTMP_URL) throw new Error('Falta configurar la variable RTMP_URL.');
    await prepararLogo();
    await sincronizarDataset();
    iniciarRTMP();

    console.log(`[CANAL C] Perfil activo: ${PERFIL.nombre}, ${PERFIL.bitrateVideo} kbps, ${FPS_SALIDA} FPS, ${HILOS} hilos.`);

    while (!apagando) {
      const elemento = obtenerElementoActualEnEmision();
      const secuencia = elemento.secuencia || [];

      for (const video of secuencia) {
        if (apagando) break;
        await emitirElemento(video);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (secuencia.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  } catch (e) {
    console.error(`[CANAL C] No se inició la transmisión: ${e.message}`);
    estadoActualTransmision.estado = 'Error de configuración';
  }
}

const servidor = app.listen(port, () => {
  console.log(`[SERVIDOR] Canal C del Zulia activo en puerto ${port}.`);
  motorCanalC();
});

async function apagar() {
  if (apagando) return;
  apagando = true;
  console.log('[CANAL C] Cerrando procesos...');
  try { if (procesoActual) procesoActual.kill('SIGTERM'); } catch {}
  try { if (procesoRtmp) procesoRtmp.kill('SIGTERM'); } catch {}
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);

sincronizarDataset().catch(e => console.error(`[DATASET] ${e.message}`));
setInterval(() => {
  sincronizarDataset().catch(e => console.error(`[DATASET] ${e.message}`));
}, 45000);
