const { spawn } = require('child_process');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Registro con hora de Venezuela (sin guardar nada en memoria)
const _consoleLog = console.log.bind(console);
console.log = (...args) => {
    const hora = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Caracas', hour12: false });
    _consoleLog(hora + ' ' + args.map(a => String(a)).join(' '));
};

const app = express();
const port = process.env.PORT || 8080; // blitz.cloud lee el puerto declarado en el Dockerfile (EXPOSE 8080)

const DATASET_REPO_ID = process.env.DATASET_REPO_ID || "cristianbracho904/programacion-tv";
const DATASET_BRANCH = process.env.DATASET_BRANCH || "main";
const HF_TOKEN = process.env.HF_TOKEN || "";
// Salida RTMP: URL completa de ingesta (con clave y tokens). SOLO en variables de entorno, nunca en el código.
const RTMP_URL = (process.env.RTMP_URL || "").trim();
const RTMP_PUENTE_PUERTO = 9999;

const GIST_FALLBACK_URL = "https://gist.githubusercontent.com/crcistianbracho10/6e4a07d268460ea807abf28f77c3880e/raw";
const FALLBACK_IMAGE = "https://www.dropbox.com/scl/fi/x9xpsosc6mlmn5rw8e2at/Copilot_20260224_002036.png?rlkey=340kgc42pa64ytajhzv0vl53b&st=qr7ly3ru&dl=1";
const ARCHIVO_ESTADO_PERSISTENTE = '/tmp/estado_episodios.json';

// Hilos de ffmpeg: tantos como núcleos REALES tiene el contenedor. Se puede forzar con FFMPEG_THREADS.
const HILOS = process.env.FFMPEG_THREADS || String(Math.max(1, Math.round(nucleosDisponibles())));

// ---------------------------------------------------------------
// Calidad de salida: SIEMPRE 720p (1280x720). Todo se compone directo en 720p (sin pasar por 1080p).
// ---------------------------------------------------------------
const PERFIL = { nombre: '720p', w: 1280, h: 720, kbps: 1000, preset: process.env.X264_PRESET || 'superfast' };
const BITRATE_VIDEO = Math.max(0, parseInt(process.env.BITRATE_VIDEO, 10) || 0); // kbps; 0 = el del perfil (1000)
const BITRATE_AUDIO = Math.max(32, parseInt(process.env.BITRATE_AUDIO, 10) || 96); // kbps
const FPS_SALIDA = Math.min(30, Math.max(10, parseInt(process.env.FPS_SALIDA, 10) || 24));
const SEGUNDOS_CUADRO_CLAVE = 1.5;
// Logo: el tamaño se cambia con LOGO_TAMANO (se mide como si el lienzo fuera 1080p; abajo se ajusta solo a 720p).
// La posición es FIJA.
const LOGO_TAMANO = Math.max(40, parseInt(process.env.LOGO_TAMANO, 10) || 245);
const LOGO_X = 170;
const LOGO_Y = 75;
const ESCALA_LOGO = PERFIL.h / 1080;
const LOGO_PX = Math.max(20, Math.round(LOGO_TAMANO * ESCALA_LOGO));
const LOGO_X_PX = Math.round(LOGO_X * ESCALA_LOGO);
const LOGO_Y_PX = Math.round(LOGO_Y * ESCALA_LOGO);

const HIMNO_VENTANA_MIN = 10; // minutos que tiene el himno para arrancar desde su hora de inicio
const UA_NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HIMNO_OFICIAL_URL = "https://files.catbox.moe/zvee4n.mp4";

const AJUSTES_DEFECTO = {
    modoCodificacion: "ligero",
    ajusteHorario: true,
    toleranciaMinutos: 3
};

let datasetConfig = {
    vivo: [],
    programacion: [],
    himno: [
        { url: HIMNO_OFICIAL_URL, inicio: "06:00:00" },
        { url: HIMNO_OFICIAL_URL, inicio: "00:00:00" },
        { url: HIMNO_OFICIAL_URL, inicio: "18:00:00" }
    ],
    intros: [],
    publicidad: [],
    clasificacion: [],
    evento: [],
    inicioProg: [],
    magazine: [],
    secretosProsperidad: [],
    cartasTaron: [],
    playlistGist: [],
    ajustes: Object.assign({}, AJUSTES_DEFECTO)
};

// Archivos del dataset que se leen
const CLAVES_DATASET = {
    evento:              { archivo: 'evento.txt', tipo: 'lista' },
    ajustes:             { archivo: 'ajustes.txt', tipo: 'objeto' },
    programacion:        { archivo: 'programacion.txt', tipo: 'lista' },
    vivo:                { archivo: 'vivo.txt', tipo: 'lista' },
    publicidad:          { archivo: 'publicidad.txt', tipo: 'lista' },
    intros:              { archivo: 'intros.txt', tipo: 'lista' },
    clasificacion:       { archivo: 'clasificacion.txt', tipo: 'lista' },
    inicioProg:          { archivo: 'next.txt', tipo: 'lista' }, // [{ "programa": "Nombre exacto", "video": "https://..." }]
    magazine:            { archivo: 'programas/magazine.txt', tipo: 'lista' },
    secretosProsperidad: { archivo: 'programas/secretos-de-prosperidad.txt', tipo: 'lista' },
    cartasTaron:         { archivo: 'programas/cartas-taron.txt', tipo: 'lista' }
};

let estadoActualTransmision = {
    tituloActual: "Iniciando señal...",
    programaActual: "Canal C",
    aContinuacion: "Cargando programación..."
};

let indicesProgramas = {};
let ultimoHimnoReproducido = "";  // el himno suena una sola vez por bloque diario
let ultimoInicioProg = "";        // "A continuación" solo al empezar cada programa
let ultimoInicioVivo = "";        // intro + publicidad + clasificación solo al empezar cada retransmisión
let ultimoEventoPublicidad = "";  // publicidad solo una vez antes de cada evento
let slotCompletado = "";          // programa cuyo horario ya no admite más episodios

function cargarEstadoPersistente() {
    try {
        if (fs.existsSync(ARCHIVO_ESTADO_PERSISTENTE)) {
            indicesProgramas = JSON.parse(fs.readFileSync(ARCHIVO_ESTADO_PERSISTENTE, 'utf8'));
        }
    } catch (e) {
        indicesProgramas = {};
    }
}

function guardarEstadoPersistente() {
    try {
        fs.writeFileSync(ARCHIVO_ESTADO_PERSISTENTE, JSON.stringify(indicesProgramas, null, 2));
    } catch (e) {}
}

cargarEstadoPersistente();

// ---------------------------------------------------------------
// Hora de Venezuela
// ---------------------------------------------------------------
function obtenerTiempoVenezuela() {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Caracas', hour12: false,
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = formatter.formatToParts(new Date());
    const getPart = (type) => parts.find(p => p.type === type).value;
    const h = getPart('hour'), m = getPart('minute'), s = getPart('second');
    const fechaVE = new Date(`${getPart('year')}-${getPart('month')}-${getPart('day')}T${h}:${m}:${s}`);
    return { horaStr: `${h}:${m}`, horaCompletaStr: `${h}:${m}:${s}`, fechaVE };
}

function diaSemanaVenezuela() {
    const d = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Caracas', weekday: 'short' }).format(new Date());
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[d];
}
function fechaVenezuelaStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); // YYYY-MM-DD
}

function convertirSegundos(horaStr) {
    if (!horaStr) return 0;
    const partes = horaStr.split(':').map(Number);
    return (partes[0] || 0) * 3600 + (partes[1] || 0) * 60 + (partes[2] || 0);
}

function sumarSegundosHora(horaStr, seg) {
    const t = (convertirSegundos(horaStr) + seg) % 86400;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

function estaEnHorario(inicio, fin, horaActualStr) {
    const secInicio = convertirSegundos(inicio);
    const secFin = convertirSegundos(fin);
    const secActual = convertirSegundos(horaActualStr);
    if (secInicio <= secFin) return secActual >= secInicio && secActual < secFin;
    return secActual >= secInicio || secActual < secFin;
}

app.get('/', (req, res) => {
    res.send('Canal C transmitiendo por RTMP.');
});

app.get('/api/estado', (req, res) => {
    res.json(estadoActualTransmision);
});

// ---------------------------------------------------------------
// Dataset (Hugging Face)
// ---------------------------------------------------------------
async function descargarArchivoDataset(nombreArchivo) {
    try {
        const url = `https://huggingface.co/datasets/${DATASET_REPO_ID}/raw/${DATASET_BRANCH}/${nombreArchivo}`;
        const headers = HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {};
        const response = await axios.get(url, { headers, timeout: 10000 });
        return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    } catch (e) {
        return null;
    }
}

function aplicarConfig(clave, valor) {
    const info = CLAVES_DATASET[clave];
    if (!info || valor === null || valor === undefined) return;
    if (info.tipo === 'lista') {
        if (Array.isArray(valor)) datasetConfig[clave] = valor;
    } else if (typeof valor === 'object' && !Array.isArray(valor)) {
        datasetConfig[clave] = Object.assign({}, AJUSTES_DEFECTO, valor);
    }
}

async function sincronizarDataset() {
    for (const [clave, info] of Object.entries(CLAVES_DATASET)) {
        const remoto = await descargarArchivoDataset(info.archivo);
        if (remoto) aplicarConfig(clave, remoto);
    }
    try {
        const gistRes = await axios.get(GIST_FALLBACK_URL, { timeout: 10000 });
        datasetConfig.playlistGist = Array.isArray(gistRes.data) ? gistRes.data : JSON.parse(gistRes.data);
    } catch (e) {}
}

setInterval(sincronizarDataset, 90000);

// ---------------------------------------------------------------
// Salida RTMP: toma la señal local (UDP 9999) y la manda al servidor RTMP sin recodificar
// ---------------------------------------------------------------
let procesoRtmp = null;
let reintentoRtmp = null;

function ocultarClaveRtmp(texto) {
    return RTMP_URL ? String(texto).split(RTMP_URL).join('rtmp://***') : String(texto);
}

function iniciarRTMP() {
    if (!RTMP_URL) return;
    if (reintentoRtmp) { clearTimeout(reintentoRtmp); reintentoRtmp = null; }
    if (procesoRtmp) {
        try { procesoRtmp.removeAllListeners('close'); procesoRtmp.kill('SIGKILL'); } catch (e) {}
    }
    let hostRtmp = '';
    try { hostRtmp = new URL(RTMP_URL).host; } catch (e) { hostRtmp = '(RTMP_URL no es una URL válida)'; }
    console.log(`📡 [RTMP] Conectando salida RTMP a ${hostRtmp} ...`);
    const proc = spawn('ffmpeg', [
        '-fflags', '+nobuffer+genpts',
        '-probesize', '500000',
        '-analyzeduration', '500000',
        '-i', `udp://127.0.0.1:${RTMP_PUENTE_PUERTO}?buffer_size=8000000&fifo_size=500000&overrun_nonfatal=1`,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-flush_packets', '1',
        '-f', 'flv',
        RTMP_URL
    ]);
    procesoRtmp = proc;
    let conectado = false;
    let yaPublicando = false;
    let lineasMostradas = 0;
    let ultimoEstado = 0;
    const avisoSinSenal = setTimeout(() => {
        if (!conectado) console.log('⏳ [RTMP] Pasaron 40s y no llegan datos de video al RTMP: o el codificador aún no arranca o el servidor RTMP no respondió.');
    }, 40000);
    proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (!msg) return;
        if (/Already publishing/i.test(msg)) yaPublicando = true;
        if (msg.includes('frame=')) {
            if (!conectado) {
                conectado = true;
                console.log('✅ [RTMP] Transmitiendo al servidor RTMP.');
            }
            if (Date.now() - ultimoEstado > 60000) {
                ultimoEstado = Date.now();
                console.log(`📊 [RTMP] ${msg.split('\n').pop().replace(/\s+/g, ' ').slice(0, 160)}`);
            }
            return;
        }
        if (/decode_slice_header|non-existing PPS|Last message repeated|co located POCs|mmco|reference picture missing|Packet corrupt|no frame/i.test(msg)) return;
        if (lineasMostradas < 40 || /error|failed|refused|timed out|denied|unauthorized|Input\/output|invalid|not found|Connection/i.test(msg)) {
            lineasMostradas++;
            console.log(`[RTMP] ${ocultarClaveRtmp(msg).slice(0, 300)}`);
        }
    });
    proc.on('close', (code, signal) => {
        clearTimeout(avisoSinSenal);
        if (yaPublicando) {
            console.log('⛔ [RTMP] "Already publishing": ya hay OTRA transmisión usando esta misma clave (otra copia de esta app, un despliegue anterior encendido u otro programa). Reintento en 20s.');
            reintentoRtmp = setTimeout(iniciarRTMP, 20000);
        } else {
            console.log(`⚠️ [RTMP] La salida RTMP se cerró (código ${code}, señal ${signal}). Reintentando en 5s...`);
            reintentoRtmp = setTimeout(iniciarRTMP, 5000);
        }
    });
}

// ---------------------------------------------------------------
// Logo del canal: se busca Canal_C.png en el servidor o se baja de LOGO_URL
// ---------------------------------------------------------------
const LOGO_URL = (process.env.LOGO_URL || '').trim();
let LOGO_PATH = null;

function buscarLogoLocal() {
    const carpetas = [...new Set([process.cwd(), __dirname, '/app', '/tmp'])];
    for (const dir of carpetas) {
        try {
            const nombre = fs.readdirSync(dir).find(f => f.toLowerCase() === 'canal_c.png');
            if (nombre) return path.join(dir, nombre);
        } catch (e) {}
    }
    return null;
}

// Convierte enlaces "de página" (GitHub, Google Drive, Dropbox, Imgur...) en enlaces directos a la imagen
function enlaceDirectoLogo(u) {
    u = String(u || '').trim();
    if (!u) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    let m;
    if ((m = u.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+?)(?:\?.*)?$/i))) {
        return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
    }
    if ((m = u.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i)) || (m = u.match(/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([^&#]+)/i))) {
        return `https://drive.google.com/uc?export=download&id=${m[1]}`;
    }
    if (/dropbox\.com/i.test(u)) {
        return u.replace(/www\.dropbox\.com/i, 'dl.dropboxusercontent.com').replace(/[?&]dl=[01]/i, '');
    }
    if ((m = u.match(/^https?:\/\/(?:www\.)?imgur\.com\/(?!a\/|gallery\/)([A-Za-z0-9]+)\/?$/i))) {
        return `https://i.imgur.com/${m[1]}.png`;
    }
    return corregirUrl(u);
}

// Detecta el tipo de imagen por sus primeros bytes
function tipoImagen(buf) {
    if (buf.length > 12) {
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
        if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
        if (buf.slice(0, 4).toString() === 'GIF8') return 'gif';
        if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
    }
    return null;
}

async function prepararLogo() {
    LOGO_PATH = null;
    if (LOGO_URL) {
        const directo = enlaceDirectoLogo(LOGO_URL);
        try {
            const r = await axios.get(directo, {
                responseType: 'arraybuffer', timeout: 25000, maxContentLength: 15 * 1024 * 1024,
                headers: { 'User-Agent': UA_NAVEGADOR }, maxRedirects: 5
            });
            const buf = Buffer.from(r.data);
            const tipo = tipoImagen(buf);
            if (!tipo) throw new Error('el enlace no devuelve una imagen (png, jpg, gif o webp). Usa un enlace directo a la imagen.');
            LOGO_PATH = `/tmp/logo_descargado.${tipo}`;
            fs.writeFileSync(LOGO_PATH, buf);
            console.log(`🖼️ [LOGO] Logo descargado desde LOGO_URL (${tipo}, ${buf.length} bytes).`);
        } catch (e) {
            console.log(`❌ [LOGO] No se pudo usar LOGO_URL: ${e.response ? 'HTTP ' + e.response.status : e.message}`);
        }
    }
    if (!LOGO_PATH) LOGO_PATH = buscarLogoLocal();
    if (LOGO_PATH) {
        console.log(`🖼️ [LOGO] Logo en uso: ${LOGO_PATH} (${fs.statSync(LOGO_PATH).size} bytes) | ${LOGO_PX}px en ${PERFIL.nombre}`);
    } else {
        console.log(`❌ [LOGO] No hay logo: el canal sale sin logo. Define LOGO_URL con el enlace a tu logo o sube Canal_C.png junto al código.`);
    }
}

// ---------------------------------------------------------------
// Monitor de CPU y RAM del contenedor (cgroup)
// ---------------------------------------------------------------
function leerNumero(ruta) {
    try { return fs.readFileSync(ruta, 'utf8').trim(); } catch (e) { return null; }
}

function cpuUsadaSegundos() {
    const v2 = leerNumero('/sys/fs/cgroup/cpu.stat');
    if (v2) {
        const m = v2.match(/usage_usec\s+(\d+)/);
        if (m) return Number(m[1]) / 1e6;
    }
    const v1 = leerNumero('/sys/fs/cgroup/cpuacct/cpuacct.usage');
    if (v1 && !isNaN(Number(v1))) return Number(v1) / 1e9;
    return null;
}

function nucleosDisponibles() {
    const v2 = leerNumero('/sys/fs/cgroup/cpu.max');
    if (v2) {
        const [cuota, periodo] = v2.split(/\s+/);
        if (cuota && cuota !== 'max' && Number(periodo) > 0) return Number(cuota) / Number(periodo);
    }
    const q = leerNumero('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), pe = leerNumero('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
    if (q && pe && Number(q) > 0 && Number(pe) > 0) return Number(q) / Number(pe);
    return os.cpus().length;
}

function memoriaContenedorMB() {
    const uso = leerNumero('/sys/fs/cgroup/memory.current') || leerNumero('/sys/fs/cgroup/memory/memory.usage_in_bytes');
    const lim = leerNumero('/sys/fs/cgroup/memory.max') || leerNumero('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    const usoMB = uso && !isNaN(Number(uso)) ? Number(uso) / 1048576 : (os.totalmem() - os.freemem()) / 1048576;
    let limMB = lim && !isNaN(Number(lim)) ? Number(lim) / 1048576 : null;
    if (limMB && limMB > os.totalmem() / 1048576 * 1.5) limMB = null;
    return { usoMB, limMB };
}

const SEGUNDOS_LOG_CPU = Math.max(5, Number(process.env.CPU_LOG_SEGUNDOS) || 60);
let cpuAnterior = { t: Date.now(), seg: cpuUsadaSegundos() };
setInterval(() => {
    const ahora = Date.now();
    const seg = cpuUsadaSegundos();
    const nuc = nucleosDisponibles();
    let txtCpu;
    if (seg !== null && cpuAnterior.seg !== null) {
        const nucleosUsados = (seg - cpuAnterior.seg) / ((ahora - cpuAnterior.t) / 1000);
        txtCpu = `CPU: ${Math.round((nucleosUsados / nuc) * 100)}% (${nucleosUsados.toFixed(2)} de ${Math.round(nuc * 100) / 100} núcleos)`;
    } else {
        txtCpu = `CPU (carga 1 min): ${os.loadavg()[0].toFixed(2)} de ${os.cpus().length} núcleos`;
    }
    cpuAnterior = { t: ahora, seg };
    const { usoMB, limMB } = memoriaContenedorMB();
    console.log(`🖥️ [CPU] ${txtCpu} | RAM: ${Math.round(usoMB)} MB${limMB ? ' de ' + Math.round(limMB) + ' MB' : ''}`);
}, SEGUNDOS_LOG_CPU * 1000);

function corregirUrl(url) {
    if (!url) return FALLBACK_IMAGE;
    if (url.includes("dropbox.com")) {
        return url.replace(/www\.dropbox\.com/, "dl.dropboxusercontent.com")
                  .replace(/\?dl=0/, "").replace(/\?dl=1/, "");
    }
    // Videos de tu dataset privado: ffmpeg los lee por el servidor, que usa el token
    const prefijoHF = `https://huggingface.co/datasets/${DATASET_REPO_ID}/`;
    if (url.startsWith(prefijoHF)) {
        const m = url.slice(prefijoHF.length).match(/^(?:resolve|blob|raw)\/[^/]+\/([^?#]+)/);
        if (m) return `http://127.0.0.1:${port}/_hf/${m[1]}`;
    }
    return url;
}

// ---------------------------------------------------------------
// Eventos (sin banner ni cuenta regresiva: solo se emiten cuando están en curso)
// ---------------------------------------------------------------
const eventosAdvertidos = new Set();

function verificarEventoEnCurso() {
    const ahoraVE = obtenerTiempoVenezuela().fechaVE;
    const hhmm = (h) => String(h).split(':').slice(0, 2).join(':');
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    for (const ev of datasetConfig.evento) {
        if (!ev || !ev.fechaInicio || !ev.horaInicio || !ev.horaFin) continue;
        let inicioEv = new Date(`${ev.fechaInicio}T${hhmm(ev.horaInicio)}:00`);
        let finEv = new Date(`${ev.fechaFin || ev.fechaInicio}T${hhmm(ev.horaFin)}:00`);

        if (isNaN(inicioEv) || isNaN(finEv) || finEv <= inicioEv) {
            if (!eventosAdvertidos.has(ev.nombre)) {
                eventosAdvertidos.add(ev.nombre);
                console.log(`⚠️ [EVENTO] "${ev.nombre}" tiene fechas inválidas (el fin debe ser posterior al inicio). Se ignora.`);
            }
            continue;
        }

        // repetir = true -> el evento se repite todos los días con el mismo horario
        if (ev.repetir) {
            const duracion = finEv - inicioEv;
            const base = new Date(`${fmt(ahoraVE)}T${hhmm(ev.horaInicio)}:00`);
            const cand = [-1, 0, 1].map(d => {
                const i = new Date(base.getTime() + d * 86400000);
                return { i, f: new Date(i.getTime() + duracion) };
            }).find(c => ahoraVE <= c.f);
            if (cand) { inicioEv = cand.i; finEv = cand.f; }
        }

        if (ahoraVE >= inicioEv && ahoraVE <= finEv) return ev;
    }
    return null;
}

// ---------------------------------------------------------------
// Helpers de secuencia
// ---------------------------------------------------------------
function getTodaPublicidad() {
    return (datasetConfig.publicidad || [])
        .filter(p => p && (p.video || p.url))
        .map(p => corregirUrl(p.video || p.url));
}

// next.txt: [{ "programa": "Nombre exacto", "video": "https://..." }]
function getVideoInicioProg(nombrePrograma) {
    const lista = datasetConfig.inicioProg;
    if (!Array.isArray(lista)) return "";
    const buscado = (nombrePrograma || "").toLowerCase().trim();
    const item = lista.find(x => ((x.programa || x.nombre || "").toLowerCase().trim()) === buscado);
    return item ? corregirUrl(item.video || item.url) : "";
}

function getVideoClasificacionPorHora(horaStr) {
    const clasifs = datasetConfig.clasificacion;
    if (!clasifs || clasifs.length === 0) return "";
    for (const c of clasifs) {
        if (estaEnHorario(c.inicio, c.fin, horaStr)) return corregirUrl(c.video);
    }
    return corregirUrl(clasifs[0].video);
}

function getIntros() {
    const i1 = datasetConfig.intros.length > 0 ? corregirUrl(datasetConfig.intros[0].video) : "";
    const i2 = datasetConfig.intros.length > 1 ? corregirUrl(datasetConfig.intros[1].video) : i1;
    return { intro1: i1, intro2: i2 };
}

// Entrada de un programa o retransmisión:
// A continuación (si hay) > Intro 1 > Publicidad > Intro 2 > Clasificación
function armarPreambulo(horaStr, urlContinuacion, descContinuacion) {
    const seq = [];
    const { intro1, intro2 } = getIntros();
    const anuncios = getTodaPublicidad();
    const clasif = getVideoClasificacionPorHora(horaStr);
    if (urlContinuacion) seq.push({ url: urlContinuacion, logo: false, desc: descContinuacion });
    if (intro1) seq.push({ url: intro1, logo: false, desc: "Intro Canal (1)" });
    anuncios.forEach((u, n) => seq.push({ url: u, logo: false, desc: `Espacio Publicitario (${n + 1}/${anuncios.length})` }));
    if (intro2) seq.push({ url: intro2, logo: false, desc: "Intro Canal (2)" });
    if (clasif) seq.push({ url: clasif, logo: false, desc: "Clasificación Horaria" });
    return seq;
}

// Qué lista de episodios usa cada programa (según el campo "archivo" de programacion.txt)
function claveListaDePrograma(prog) {
    const n = prog && prog.archivo ? prog.archivo.toLowerCase() : "";
    if (n.includes("magazine")) return 'magazine';
    if (n.includes("secretos") || n.includes("prosperidad")) return 'secretosProsperidad';
    if (n.includes("cartas") || n.includes("taron")) return 'cartasTaron';
    return datasetConfig.magazine.length > 0 ? 'magazine' : 'cartasTaron';
}

// Decide si hay que saltar el resto de la secuencia (solo ENTRE videos, nunca a mitad de uno)
function bloqueVencido(item) {
    const { horaCompletaStr } = obtenerTiempoVenezuela();
    if (item.tipo === 'vivo') return !estaEnHorario(item.horaInicioBloque, item.horaFinBloque, horaCompletaStr);
    if (!item.corteSuave) return false;
    if (!estaEnHorario(item.horaInicioBloque, item.horaFinBloque, horaCompletaStr)) return true;
    return !!verificarEventoEnCurso();
}

let indiceGistActual = 0;

function obtenerElementoActualEnEmision() {
    const { horaStr, horaCompletaStr } = obtenerTiempoVenezuela();
    const diaSemana = diaSemanaVenezuela();
    const fechaHoyStr = fechaVenezuelaStr();

    // 1. Himno Nacional: solo cuando empieza su hora, una vez, y siempre completo (sin corte)
    for (const hItem of datasetConfig.himno || []) {
        const idHimnoUnico = `${fechaHoyStr}-${hItem.inicio}`;
        const finVentana = hItem.fin || sumarSegundosHora(hItem.inicio, HIMNO_VENTANA_MIN * 60);
        if (estaEnHorario(hItem.inicio, finVentana, horaCompletaStr) && ultimoHimnoReproducido !== idHimnoUnico) {
            estadoActualTransmision.tituloActual = "Himno Nacional";
            estadoActualTransmision.programaActual = "Transmisión Oficial";
            estadoActualTransmision.aContinuacion = "Programación Regular";
            return {
                tipo: 'himno',
                idUnico: idHimnoUnico,
                secuencia: [{ url: corregirUrl(hItem.url), logo: true, desc: "Himno Nacional" }]
            };
        }
    }

    // 2. Retransmisión en vivo (vivo.txt): al empezar lleva A continuación > Intro > Publicidad > Intro > Clasificación, igual que un programa
    for (const vivoItem of datasetConfig.vivo || []) {
        if ((vivoItem.dias || []).includes(diaSemana) && estaEnHorario(vivoItem.inicio, vivoItem.fin, horaCompletaStr)) {
            estadoActualTransmision.tituloActual = `Retransmisión: ${vivoItem.nombre}`;
            estadoActualTransmision.programaActual = vivoItem.nombre;
            estadoActualTransmision.aContinuacion = "Programación Regular";

            let secuencia = [];
            const claveInicioVivo = `${fechaHoyStr}-${vivoItem.nombre}-${vivoItem.inicio}`;
            if (ultimoInicioVivo !== claveInicioVivo) {
                secuencia = armarPreambulo(horaStr, getVideoInicioProg(vivoItem.nombre), `A continuación: ${vivoItem.nombre}`);
                ultimoInicioVivo = claveInicioVivo;
            }
            secuencia.push({
                url: corregirUrl(vivoItem.url),
                logo: !vivoItem.sinLogo,
                desc: `Retransmisión en Vivo: ${vivoItem.nombre}`
            });
            return {
                tipo: 'vivo',
                horaInicioBloque: vivoItem.inicio,
                horaFinBloque: vivoItem.fin,
                corteEstricto: true,
                secuencia
            };
        }
    }

    // 3. Eventos (sin banner de cuenta regresiva)
    const ev = verificarEventoEnCurso();
    if (ev) {
        estadoActualTransmision.tituloActual = ev.nombre;
        estadoActualTransmision.programaActual = "Evento en Vivo";
        estadoActualTransmision.aContinuacion = "Programación Regular";

        const secuenciaEvento = [];
        // Antes del evento se reproduce TODA la publicidad (una sola vez por evento)
        const idEvento = `${ev.fechaInicio}-${ev.horaInicio}-${ev.nombre}`;
        if (ultimoEventoPublicidad !== idEvento) {
            const anuncios = getTodaPublicidad();
            anuncios.forEach((u, n) => {
                secuenciaEvento.push({ url: u, logo: false, desc: `Publicidad antes del evento (${n + 1}/${anuncios.length})` });
            });
            ultimoEventoPublicidad = idEvento;
        }
        secuenciaEvento.push({ url: corregirUrl(ev.fuente), logo: true, desc: `Evento: ${ev.nombre}` });
        return { tipo: 'evento', secuencia: secuenciaEvento };
    }

    // Si ya no hay programa en horario, se libera la marca de "programa completado"
    if (slotCompletado) {
        const aun = datasetConfig.programacion.some(p => (p.dias || []).includes(diaSemana) && estaEnHorario(p.inicio, p.fin, horaStr) && `${p.nombre}|${p.inicio}` === slotCompletado);
        if (!aun) slotCompletado = "";
    }

    // 4. Programación regular
    for (let i = 0; i < datasetConfig.programacion.length; i++) {
        const prog = datasetConfig.programacion[i];
        if (!((prog.dias || []).includes(diaSemana) && estaEnHorario(prog.inicio, prog.fin, horaStr) && slotCompletado !== `${prog.nombre}|${prog.inicio}`)) continue;

        const siguienteProg = datasetConfig.programacion[i + 1] ? datasetConfig.programacion[i + 1].nombre : "Transmisión Estelar / Gist";
        estadoActualTransmision.tituloActual = prog.nombre;
        estadoActualTransmision.programaActual = prog.nombre;
        estadoActualTransmision.aContinuacion = siguienteProg;

        const listaPrograma = datasetConfig[claveListaDePrograma(prog)];
        const claveProg = `${prog.nombre}-${prog.inicio}`;
        if (indicesProgramas[claveProg] === undefined) indicesProgramas[claveProg] = 0;
        let indiceVideoActual = indicesProgramas[claveProg];

        // "A continuación" (next.txt) solo al comenzar el programa
        let urlContinuacion = "";
        const claveInicio = `${fechaHoyStr}-${claveProg}`;
        if (ultimoInicioProg !== claveInicio) {
            urlContinuacion = getVideoInicioProg(prog.nombre);
            if (!urlContinuacion) {
                console.log(`ℹ️ [A CONTINUACIÓN] "${prog.nombre}" no tiene video asignado en next.txt.`);
            }
            ultimoInicioProg = claveInicio;
        }

        const secuenciaBloque = armarPreambulo(horaStr, urlContinuacion, `A continuación: ${prog.nombre}`);

        if (listaPrograma && listaPrograma.length > 0) {
            if (indiceVideoActual >= listaPrograma.length) indiceVideoActual = 0;
            const total = listaPrograma.length;
            const indice1 = indiceVideoActual;
            const indice2 = (indiceVideoActual + 1) % total;

            const videoObj1 = listaPrograma[indice1];
            secuenciaBloque.push({
                url: corregirUrl(videoObj1.video || videoObj1.url),
                logo: true,
                desc: `${prog.nombre} (Parte 1 - ${indice1 + 1}/${total})`,
                alTerminar: () => { indicesProgramas[claveProg] = (indice1 + 1) % total; guardarEstadoPersistente(); }
            });

            // Desde aquí: intro + publicidad + Parte 2 (solo se emite si cabe en el horario)
            const inicioGrupo = secuenciaBloque.length;
            const { intro1, intro2 } = getIntros();
            const anuncios = getTodaPublicidad();
            if (intro1) secuenciaBloque.push({ url: intro1, logo: false, desc: "Intro Intermedia (1)" });
            anuncios.forEach((u, n) => secuenciaBloque.push({ url: u, logo: false, desc: `Espacio Publicitario Intermedio (${n + 1}/${anuncios.length})` }));
            if (intro2) secuenciaBloque.push({ url: intro2, logo: false, desc: "Intro Intermedia (2)" });

            const videoObj2 = listaPrograma[indice2];
            secuenciaBloque.push({
                url: corregirUrl(videoObj2.video || videoObj2.url),
                logo: true,
                desc: `${prog.nombre} (Parte 2 - ${indice2 + 1}/${total})`,
                alTerminar: () => { indicesProgramas[claveProg] = (indice2 + 1) % total; guardarEstadoPersistente(); }
            });
            secuenciaBloque.slice(inicioGrupo).forEach(x => { x.grupo = 'parte2'; });
            secuenciaBloque[inicioGrupo].inicioGrupo = true;
        }

        return {
            tipo: 'programa_secuencia',
            horaInicioBloque: prog.inicio,
            horaFinBloque: prog.fin,
            corteSuave: true, // no corta videos a la fuerza: termina el video actual y cambia
            claveSlot: `${prog.nombre}|${prog.inicio}`,
            secuencia: secuenciaBloque
        };
    }

    // 5. Playlist de respaldo (Gist)
    if (datasetConfig.playlistGist.length > 0) {
        if (indiceGistActual >= datasetConfig.playlistGist.length) indiceGistActual = 0;
        const itemGist = datasetConfig.playlistGist[indiceGistActual];
        indiceGistActual++;
        estadoActualTransmision.tituloActual = itemGist.title || "Canal C Playlist";
        estadoActualTransmision.programaActual = "Bloque Rotativo Gist";
        estadoActualTransmision.aContinuacion = "Programación en Espera";
        return {
            tipo: 'gist',
            claveSlot: slotCompletado || null,
            secuencia: [{ url: corregirUrl(itemGist.video || itemGist.url), logo: true, desc: "Gist Respaldo" }]
        };
    }

    estadoActualTransmision.tituloActual = "Señal de Ajuste";
    estadoActualTransmision.programaActual = "Mantenimiento";
    estadoActualTransmision.aContinuacion = "Ninguna";
    return {
        tipo: 'fallback',
        secuencia: [{ url: FALLBACK_IMAGE, logo: true, desc: "Imagen de Salvación" }]
    };
}

function numAjuste(v, defecto) {
    if (v === '' || v === null || v === undefined || isNaN(Number(v))) return defecto;
    return Number(v);
}

function ajusteHorarioActivo() {
    return (datasetConfig.ajustes || AJUSTES_DEFECTO).ajusteHorario !== false;
}

// Programa que debería estar al aire ahora según programacion.txt
function programaProgramadoAhora() {
    const { horaStr } = obtenerTiempoVenezuela();
    const diaSemana = diaSemanaVenezuela();
    for (const prog of datasetConfig.programacion) {
        if ((prog.dias || []).includes(diaSemana) && estaEnHorario(prog.inicio, prog.fin, horaStr)) {
            return { prog, clave: `${prog.nombre}|${prog.inicio}` };
        }
    }
    return null;
}

// Duración de un video en segundos (ffprobe). null si no se puede medir (ej. en vivo).
const cacheDuraciones = new Map();
function obtenerDuracion(url) {
    const u = corregirUrl(url);
    if (cacheDuraciones.has(u)) return Promise.resolve(cacheDuraciones.get(u));
    return new Promise((resolve) => {
        let out = '';
        let p;
        try {
            p = spawn('nice', ['-n', '19', 'ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', '-timeout', '15000000', u]);
        } catch (e) { return resolve(null); }
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 20000);
        p.stdout.on('data', d => { out += d; });
        p.on('error', () => { clearTimeout(t); resolve(null); });
        p.on('close', () => {
            clearTimeout(t);
            const d = parseFloat(out);
            if (isFinite(d) && d > 0) { cacheDuraciones.set(u, d); resolve(d); } else resolve(null);
        });
    });
}

// ¿Cabe este grupo (intro + publicidad + Parte 2) antes de que termine el horario del programa?
async function grupoCabeEnHorario(grupo, bloque) {
    if (!ajusteHorarioActivo()) return true;
    const tolerancia = numAjuste((datasetConfig.ajustes || AJUSTES_DEFECTO).toleranciaMinutos, 3) * 60;
    const duraciones = await Promise.all(grupo.map(v => obtenerDuracion(v.url)));
    if (duraciones.some(d => !d)) return true;
    const total = duraciones.reduce((a, b) => a + b, 0);
    const { horaCompletaStr } = obtenerTiempoVenezuela();
    let restante = convertirSegundos(bloque.horaFinBloque) - convertirSegundos(horaCompletaStr);
    if (restante < 0) restante += 86400;
    return total <= restante + tolerancia;
}

// ---------------------------------------------------------------
// Motor de emisión
// ---------------------------------------------------------------
async function motorCanalC() {
    await prepararLogo();
    if (RTMP_URL) iniciarRTMP();
    else console.log('⚠️ [RTMP] Falta la variable de entorno RTMP_URL: el canal no tiene ninguna salida. Defínela y reinicia.');
    await sincronizarDataset();

    while (true) {
        const itemActual = obtenerElementoActualEnEmision();

        if (itemActual.tipo === 'himno' && itemActual.idUnico) {
            ultimoHimnoReproducido = itemActual.idUnico;
        }

        const listaElementos = itemActual.secuencia || [];

        for (let i = 0; i < listaElementos.length; i++) {
            const video = listaElementos[i];
            if (!video.url) continue;

            // Si el horario terminó (o llega un evento) se omite el resto. Solo se evalúa ENTRE videos.
            if (i > 0 && bloqueVencido(itemActual)) {
                console.log(`⏭️ [HORARIO] El bloque terminó. Se omite el resto de la secuencia.`);
                break;
            }

            if (itemActual.tipo === 'programa_secuencia') {
                // Mientras suena la Parte 1 se miden los videos de la Parte 2 (así no hay pausa después)
                if (video.alTerminar && !video.grupo && !video.sondeado) {
                    video.sondeado = true;
                    (async () => { for (const x of listaElementos.filter(y => y.grupo)) { await obtenerDuracion(x.url); } })();
                }
                // Si intro + publicidad + Parte 2 no caben antes del fin del horario, no se empiezan
                if (video.inicioGrupo) {
                    const grupo = listaElementos.filter(x => x.grupo === video.grupo);
                    if (!(await grupoCabeEnHorario(grupo, itemActual))) {
                        console.log(`⏱️ [HORARIO] La Parte 2 no cabe antes de las ${itemActual.horaFinBloque}. Se omite para que el siguiente programa empiece a su hora.`);
                        slotCompletado = itemActual.claveSlot;
                        break;
                    }
                }
            }

            const urlFinal = corregirUrl(video.url);
            const usaLogo = !!(video.logo && LOGO_PATH);

            const modoC = (datasetConfig.ajustes || AJUSTES_DEFECTO).modoCodificacion || 'ligero';
            const scaleFlags = modoC === 'calidad' ? 'lanczos' : (modoC === 'ligero' ? 'fast_bilinear' : 'bilinear');
            const sel = PERFIL;
            const kbpsV = BITRATE_VIDEO || sel.kbps;
            const bitrateV = `${kbpsV}k`;
            const maxrateV = `${Math.round(kbpsV * 1.5)}k`;
            const bufsizeV = `${Math.round(kbpsV * 3)}k`;
            const gop = String(Math.round(FPS_SALIDA * SEGUNDOS_CUADRO_CLAVE));

            console.log(`\n📺 AIRE: ${video.desc}`);
            console.log(`⚙️ [CALIDAD] ${sel.nombre} | ${sel.w}x${sel.h} | video ${kbpsV}k + audio ${BITRATE_AUDIO}k | ${FPS_SALIDA} fps | x264 ${sel.preset} | hilos ${HILOS} | logo ${usaLogo ? 'sí' : 'no'}`);

            const ffmpegArgs = [
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-timeout', '20000000',
                '-fflags', '+genpts+ignidx+discardcorrupt',
                '-err_detect', 'ignore_err',
                '-user_agent', UA_NAVEGADOR,
                '-probesize', '2M',
                '-analyzeduration', '2000000',
                '-threads', HILOS, '-filter_complex_threads', HILOS,
                '-thread_queue_size', '512',
                '-re',
                '-i', urlFinal
            ];
            // El logo solo entra como segunda entrada cuando el video lo lleva
            if (usaLogo) ffmpegArgs.push('-i', LOGO_PATH);

            const audioFiltro = `[0:a]aresample=async=1000:first_pts=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a]`;
            const filterComplex = usaLogo
                ? `[0:v]fps=${FPS_SALIDA},scale=${sel.w}:${sel.h}:flags=${scaleFlags},setsar=1[bg];` +
                  `[1:v]scale=${LOGO_PX}:${LOGO_PX}:force_original_aspect_ratio=decrease[logo];` +
                  `[bg][logo]overlay=${LOGO_X_PX}:${LOGO_Y_PX},format=yuv420p[v];${audioFiltro}`
                : `[0:v]fps=${FPS_SALIDA},scale=${sel.w}:${sel.h}:flags=${scaleFlags},setsar=1,format=yuv420p[v];${audioFiltro}`;

            ffmpegArgs.push('-filter_complex', filterComplex, '-map', '[v]', '-map', '[a]');
            ffmpegArgs.push(
                '-c:v', 'libx264', '-preset', sel.preset, '-tune', 'zerolatency',
                '-threads', HILOS,
                '-b:v', bitrateV, '-maxrate', maxrateV, '-bufsize', bufsizeV,
                '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
                '-c:a', 'aac', '-b:a', `${BITRATE_AUDIO}k`, '-ac', '2',
                '-max_muxing_queue_size', '1024',
                '-muxdelay', '0', '-flush_packets', '1',
                '-f', 'mpegts', `udp://127.0.0.1:${RTMP_PUENTE_PUERTO}?pkt_size=1316`
            );

            await new Promise((resolve) => {
                const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
                let ultimoFrame = Date.now();
                let duracionActual = 0, tiempoActual = 0, cortePorHorario = false;

                const verificadorHoraFin = setInterval(() => {
                    if (itemActual.tipo === 'evento') {
                        if (!verificarEventoEnCurso()) {
                            console.log(`⏰ [EVENTO] El evento terminó. Cortando transmisión.`);
                            ffmpegProc.kill('SIGKILL');
                        }
                    } else if (itemActual.corteEstricto) {
                        // Corte a la fuerza SOLO para la retransmisión (horario estricto)
                        const { horaCompletaStr } = obtenerTiempoVenezuela();
                        if (!estaEnHorario(itemActual.horaInicioBloque, itemActual.horaFinBloque, horaCompletaStr)) {
                            console.log(`⏰ [HORARIO] Límite alcanzado (${itemActual.horaFinBloque}). Cortando transmisión actual.`);
                            ffmpegProc.kill('SIGKILL');
                        }
                    } else if ((itemActual.tipo === 'programa_secuencia' || itemActual.tipo === 'gist') && ajusteHorarioActivo()) {
                        // Si ya le toca a otro programa y a este video le falta más que la tolerancia, se corta
                        const ahoraProg = programaProgramadoAhora();
                        if (ahoraProg && ahoraProg.clave !== itemActual.claveSlot) {
                            const tol = numAjuste((datasetConfig.ajustes || AJUSTES_DEFECTO).toleranciaMinutos, 3) * 60;
                            const restante = duracionActual > 0 ? (duracionActual - tiempoActual) : Infinity;
                            if (restante > tol) {
                                console.log(`⏰ [HORARIO] Ya toca "${ahoraProg.prog.nombre}" y a este video le falta ${isFinite(restante) ? Math.round(restante / 60) + ' min' : 'un tiempo desconocido'}. Se corta para empezar a la hora.`);
                                cortePorHorario = true;
                                ffmpegProc.kill('SIGKILL');
                            }
                        }
                    }
                }, 5000);

                const ultimasLineasFfmpeg = [];
                ffmpegProc.stderr.on('data', (data) => {
                    const msg = data.toString().trim();
                    if (msg.includes("frame=")) {
                        ultimoFrame = Date.now();
                        const tm = msg.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
                        if (tm) {
                            const u = tm[tm.length - 1].match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
                            tiempoActual = Number(u[1]) * 3600 + Number(u[2]) * 60 + Number(u[3]);
                        }
                        return;
                    }
                    for (const ln of msg.split('\n')) {
                        if (ln.trim()) { ultimasLineasFfmpeg.push(ln.trim().slice(0, 220)); if (ultimasLineasFfmpeg.length > 8) ultimasLineasFfmpeg.shift(); }
                    }
                    if (!duracionActual) {
                        const d = msg.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
                        if (d) duracionActual = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
                    }
                });

                const watchdogCongelamiento = setInterval(() => {
                    if (Date.now() - ultimoFrame > 15000) {
                        console.log(`⚠️ [WATCHDOG] El video "${video.desc}" se congeló. Forzando reinicio del proceso.`);
                        ffmpegProc.kill('SIGKILL');
                    }
                }, 5000);

                ffmpegProc.on('close', (code) => {
                    console.log(`ℹ️ [CIERRE] Finalizó: ${video.desc} (Código: ${code})`);
                    if (code !== 0 && code !== null) {
                        console.log(`❌ [FFMPEG] Error al emitir "${video.desc}". Últimas líneas de ffmpeg:\n   ` + ultimasLineasFfmpeg.join('\n   '));
                    }
                    clearInterval(verificadorHoraFin);
                    clearInterval(watchdogCongelamiento);
                    // Si se cortó por horario, el episodio no cuenta como emitido
                    if (!cortePorHorario && typeof video.alTerminar === 'function') video.alTerminar();
                    resolve();
                });
            });
        }
        await new Promise(r => setTimeout(r, 500));
    }
}

// Proxy interno: permite que ffmpeg lea videos de tu dataset privado usando el token.
// Solo acepta conexiones locales (del propio servidor).
app.use('/_hf', async (req, res) => {
    const ip = (req.socket && req.socket.remoteAddress) || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).end();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
    let ruta = '';
    try { ruta = decodeURIComponent((req.path || '').replace(/^\/+/, '')); } catch (e) { return res.status(400).end(); }
    if (!ruta || ruta.split('/').includes('..')) return res.status(400).end();
    const url = `https://huggingface.co/datasets/${DATASET_REPO_ID}/resolve/${DATASET_BRANCH}/${ruta.split('/').map(encodeURIComponent).join('/')}`;
    try {
        const headers = {};
        if (HF_TOKEN) headers.Authorization = `Bearer ${HF_TOKEN}`;
        if (req.headers.range) headers.Range = req.headers.range;
        const r = await axios.get(url, { headers, responseType: 'stream', validateStatus: () => true, maxRedirects: 5 });
        res.status(r.status);
        ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach(h => {
            if (r.headers[h]) res.set(h, r.headers[h]);
        });
        if (req.method === 'HEAD') { r.data.destroy(); return res.end(); }
        res.on('close', () => { try { r.data.destroy(); } catch (e) {} });
        r.data.pipe(res);
    } catch (e) {
        if (!res.headersSent) res.status(502).end();
    }
});

app.listen(port, () => {
    console.log(`🚀 Servidor de Canal C corriendo en el puerto ${port}`);
    motorCanalC();
});
