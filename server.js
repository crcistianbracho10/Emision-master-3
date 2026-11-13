const { spawn } = require('child_process');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

// Registro en memoria (se muestra en el panel)
const logBuffer = [];
const _consoleLog = console.log.bind(console);
console.log = (...args) => {
    _consoleLog(...args);
    const hora = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Caracas', hour12: false });
    logBuffer.push(hora + ' ' + args.map(a => String(a)).join(' '));
    if (logBuffer.length > 200) logBuffer.shift();
};

const app = express();
const port = process.env.PORT || 8080;

const DATASET_REPO_ID = process.env.DATASET_REPO_ID || "cristianbracho904/programacion-tv";
const DATASET_BRANCH = process.env.DATASET_BRANCH || "main";
const HF_TOKEN = process.env.HF_TOKEN || "";
const RTMP_URL = (process.env.RTMP_URL || "").trim();
const RTMP_PUENTE_PUERTO = 9999;

const GIST_FALLBACK_URL = "https://gist.githubusercontent.com/crcistianbracho10/6e4a07d268460ea807abf28f77c3880e/raw";
const FALLBACK_IMAGE = "https://www.dropbox.com/scl/fi/x9xpsosc6mlmn5rw8e2at/Copilot_20260224_002036.png?rlkey=340kgc42pa64ytajhzv0vl53b&st=qr7ly3ru&dl=1";
const BANNER_EVENTO_DEFECTO = "https://ibb.co/KpGf6Zxp";
const BANNER_RESPALDO_DEFECTO = "https://i.postimg.cc/v8vXL9BV/images-(1)-(1).png";
const ARCHIVO_ESTADO_PERSISTENTE = '/tmp/estado_episodios.json';
const ARCHIVO_CUENTA = '/tmp/cuenta_regresiva.txt';
const ARCHIVO_CINTILLO = '/tmp/cintillo.txt';
const HILOS = process.env.FFMPEG_THREADS || String(Math.max(1, Math.round(nucleosDisponibles())));

const BITRATE_AUDIO = Math.max(32, parseInt(process.env.BITRATE_AUDIO, 10) || 96);
const FPS_SALIDA = Math.min(30, Math.max(10, parseInt(process.env.FPS_SALIDA, 10) || 24));
const SEGUNDOS_CUADRO_CLAVE = 1.5;
const LOGO_TAMANO = Math.max(40, parseInt(process.env.LOGO_TAMANO, 10) || 245);
const LOGO_X = 170;
const LOGO_Y = 75;
const HIMNO_VENTANA_MIN = 10;
const UA_NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DIR_OVERRIDES = '/tmp/overrides';
const FONT_FILE = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
].find(p => fs.existsSync(p)) || null;

const HIMNO_OFICIAL_URL = "https://files.catbox.moe/zvee4n.mp4";

if (!fs.existsSync(DIR_OVERRIDES)) {
    fs.mkdirSync(DIR_OVERRIDES, { recursive: true });
}

app.use(express.json({ limit: '5mb' }));

const AJUSTES_DEFECTO = {
    bannerUrl: BANNER_EVENTO_DEFECTO,
    bannerRespaldoUrl: BANNER_RESPALDO_DEFECTO,
    personajeUrl: "",
    segundosAparecer: 10,
    segundosVisible: 30,
    horasAntes: 12,
    cintilloActivo: false,
    cintilloTexto: "",
    cintilloVelocidad: 140,
    cintilloColor: "0a50c8",
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

const CLAVES_PANEL = {
    evento:              { archivo: 'evento.txt', tipo: 'lista' },
    ajustes:             { archivo: 'ajustes.txt', tipo: 'objeto' },
    programacion:        { archivo: 'programacion.txt', tipo: 'lista' },
    vivo:                { archivo: 'vivo.txt', tipo: 'lista' },
    publicidad:          { archivo: 'publicidad.txt', tipo: 'lista' },
    intros:              { archivo: 'intros.txt', tipo: 'lista' },
    clasificacion:       { archivo: 'clasificacion.txt', tipo: 'lista' },
    inicioProg:          { archivo: 'next.txt', tipo: 'lista' },
    magazine:            { archivo: 'programas/magazine.txt', tipo: 'lista' },
    secretosProsperidad: { archivo: 'programas/secretos-de-prosperidad.txt', tipo: 'lista' },
    cartasTaron:         { archivo: 'programas/cartas-taron.txt', tipo: 'lista' }
};

let estadoActualTransmision = {
    tituloActual: "Iniciando señal...",
    programaActual: "Canal C",
    aContinuacion: "Cargando programación...",
    eventoActivo: null,
    tiempoRestanteEvento: "",
    horaVenezuela: "--:--:--"
};

let indicesProgramas = {};
let ultimoHimnoReproducido = "";
let ultimoInicioProg = "";
let ultimoEventoPublicidad = "";

let procesoActual = null;
let itemEnAire = null;
let bloqueEnAire = { tipo: '', cola: [], indice: 0 };
let interrumpirBloque = false;
let reinicioSolicitado = false;
let colaManual = [];
let eventoForzado = null;
const eventosFinalizados = new Set();
let pruebaBanner = { inicio: 0, hasta: 0, segundos: 3600 };
let programaForzado = null;
const lentos = new Map();
let salud = { speed: null, fps: null, t: 0, ultimoAviso: 0 };
let slotCompletado = "";

function cargarEstadoPersistente() {
    try {
        if (fs.existsSync(ARCHIVO_ESTADO_PERSISTENTE)) {
            indicesProgramas = JSON.parse(fs.readFileSync(ARCHIVO_ESTADO_PERSISTENTE, 'utf8'));
        }
    } catch (e) { indicesProgramas = {}; }
}

function guardarEstadoPersistente() {
    try { fs.writeFileSync(ARCHIVO_ESTADO_PERSISTENTE, JSON.stringify(indicesProgramas, null, 2)); } catch (e) {}
}

cargarEstadoPersistente();

let imagenesEvento = { banner: { url: "", ruta: null }, personaje: { url: "", ruta: null } };

function detectarExtension(buf) {
    if (buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';
    if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
    if (buf.slice(0, 3).toString() === 'GIF') return 'gif';
    return null;
}

async function descargarImagen(url, nombreBase) {
    try {
        let objetivo = url;
        for (let intento = 0; intento < 2; intento++) {
            const r = await axios.get(objetivo, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const buf = Buffer.from(r.data);
            const ext = detectarExtension(buf);
            if (ext) {
                const ruta = `/tmp/${nombreBase}.${ext}`;
                fs.writeFileSync(ruta, buf);
                return ruta;
            }
            const html = buf.toString('utf8');
            const m = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                      html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
            if (!m) return null;
            objetivo = m[1].replace(/&amp;/g, '&');
        }
    } catch (e) {}
    return null;
}

async function actualizarImagenesEvento() {
    const aj = datasetConfig.ajustes || AJUSTES_DEFECTO;
    const claveBanner = `${aj.bannerUrl || ""}|${aj.bannerRespaldoUrl || ""}`;
    if (imagenesEvento.banner.url !== claveBanner || (!imagenesEvento.banner.ruta && claveBanner !== "|")) {
        let ruta = aj.bannerUrl ? await descargarImagen(aj.bannerUrl, 'evento_banner') : null;
        if (!ruta && aj.bannerRespaldoUrl) ruta = await descargarImagen(aj.bannerRespaldoUrl, 'evento_banner');
        imagenesEvento.banner = { url: claveBanner, ruta };
    }
    const clavePj = aj.personajeUrl || "";
    if (imagenesEvento.personaje.url !== clavePj || (!imagenesEvento.personaje.ruta && clavePj !== "")) {
        const ruta = clavePj ? await descargarImagen(clavePj, 'evento_personaje') : null;
        imagenesEvento.personaje = { url: clavePj, ruta };
    }
}

function escribirArchivoAtomico(ruta, texto) {
    try {
        fs.writeFileSync(ruta + '.tmp', texto);
        fs.renameSync(ruta + '.tmp', ruta);
    } catch (e) {}
}
function escribirCuenta(texto) { escribirArchivoAtomico(ARCHIVO_CUENTA, texto); }
function escribirCintillo(texto) { escribirArchivoAtomico(ARCHIVO_CINTILLO, (texto && String(texto).trim()) ? String(texto) : ' '); }
escribirCuenta(' ');
escribirCintillo(' ');

function obtenerTiempoVenezuela() {
    const options = { timeZone: 'America/Caracas', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit' };
    const formatter = new Intl.DateTimeFormat('en-GB', options);
    const parts = formatter.formatToParts(new Date());
    const getPart = (type) => parts.find(p => p.type === type).value;
    const h = getPart('hour'), m = getPart('minute'), s = getPart('second'), year = getPart('year'), month = getPart('month'), day = getPart('day');
    const horaStr = `${h}:${m}`, horaCompletaStr = `${h}:${m}:${s}`;
    const fechaVE = new Date(`${year}-${month}-${day}T${h}:${m}:${s}`);
    return { horaStr, horaCompletaStr, fechaVE, h: parseInt(h), m: parseInt(m) };
}

function diaSemanaVenezuela() {
    const d = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Caracas', weekday: 'short' }).format(new Date());
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[d];
}
function fechaVenezuelaStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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
    const secInicio = convertirSegundos(inicio), secFin = convertirSegundos(fin), secActual = convertirSegundos(horaActualStr);
    return secInicio <= secFin ? (secActual >= secInicio && secActual < secFin) : (secActual >= secInicio || secActual < secFin);
}

app.get('/', (req, res) => { res.send('Canal C transmitiendo por RTMP.'); });
app.get('/api/estado', (req, res) => { res.json(estadoActualTransmision); });

async function descargarArchivoDataset(nombreArchivo) {
    try {
        const url = `https://huggingface.co/datasets/${DATASET_REPO_ID}/raw/${DATASET_BRANCH}/${nombreArchivo}`;
        const headers = HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {};
        const response = await axios.get(url, { headers, timeout: 10000 });
        return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    } catch (e) { return null; }
}

function aplicarConfig(clave, valor) {
    const info = CLAVES_PANEL[clave];
    if (!info || valor === null || valor === undefined) return;
    if (info.tipo === 'lista') {
        if (Array.isArray(valor)) datasetConfig[clave] = valor;
    } else if (typeof valor === 'object' && !Array.isArray(valor)) {
        datasetConfig[clave] = Object.assign({}, AJUSTES_DEFECTO, valor);
        if (clave === 'ajustes') escribirCintillo(datasetConfig.ajustes.cintilloTexto);
    }
}

function leerOverride(clave) {
    try {
        const f = `${DIR_OVERRIDES}/${clave}.json`;
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {}
    return null;
}
function guardarOverride(clave, datos, hfOk) {
    try { fs.writeFileSync(`${DIR_OVERRIDES}/${clave}.json`, JSON.stringify({ t: Date.now(), hfOk, datos })); } catch (e) {}
}
function borrarOverride(clave) {
    try { fs.unlinkSync(`${DIR_OVERRIDES}/${clave}.json`); } catch (e) {}
}

async function guardarEnHuggingFace(archivo, datos) {
    if (!HF_TOKEN) return false;
    try {
        const contenido = JSON.stringify(datos, null, 2);
        const cuerpo = [
            JSON.stringify({ key: 'header', value: { summary: `Panel: actualiza ${archivo}` } }),
            JSON.stringify({ key: 'file', value: { content: Buffer.from(contenido, 'utf8').toString('base64'), path: archivo, encoding: 'base64' } })
        ].join('\n');
        await axios.post(`https://huggingface.co/api/datasets/${DATASET_REPO_ID}/commit/${DATASET_BRANCH}`, cuerpo, {
            headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/x-ndjson' }, timeout: 30000
        });
        return true;
    } catch (e) { return false; }
}

async function sincronizarDataset() {
    for (const [clave, info] of Object.entries(CLAVES_PANEL)) {
        const remoto = await descargarArchivoDataset(info.archivo);
        const ov = leerOverride(clave);
        if (ov) {
            const igual = remoto && JSON.stringify(remoto) === JSON.stringify(ov.datos);
            if (igual || (ov.hfOk && Date.now() - ov.t > 120000)) {
                borrarOverride(clave);
                if (remoto) aplicarConfig(clave, remoto);
            } else { aplicarConfig(clave, ov.datos); }
            continue;
        }
        if (remoto) aplicarConfig(clave, remoto);
    }
    try {
        const gistRes = await axios.get(GIST_FALLBACK_URL);
        datasetConfig.playlistGist = Array.isArray(gistRes.data) ? gistRes.data : JSON.parse(gistRes.data);
    } catch (e) {}
    await actualizarImagenesEvento();
}

setInterval(sincronizarDataset, 60000);

let procesoRtmp = null;
let reintentoRtmp = null;

function ocultarClaveRtmp(texto) {
    return RTMP_URL ? String(texto).split(RTMP_URL).join('rtmp://***') : String(texto);
}

function iniciarRTMP() {
    if (!RTMP_URL) return;
    if (reintentoRtmp) { clearTimeout(reintentoRtmp); reintentoRtmp = null; }
    if (procesoRtmp) { try { procesoRtmp.removeAllListeners('close'); procesoRtmp.kill('SIGKILL'); } catch (e) {} }
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
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
        reintentoRtmp = setTimeout(iniciarRTMP, 5000);
    });
}

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
    return corregirUrl(u);
}

function tipoImagen(buf) {
    if (buf.length > 12) {
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
        if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
    }
    return null;
}

async function prepararLogo() {
    LOGO_PATH = null;
    if (LOGO_URL) {
        const directo = enlaceDirectoLogo(LOGO_URL);
        try {
            const r = await axios.get(directo, { responseType: 'arraybuffer', timeout: 25000, headers: { 'User-Agent': UA_NAVEGADOR } });
            const buf = Buffer.from(r.data);
            const tipo = tipoImagen(buf);
            if (tipo) {
                LOGO_PATH = `/tmp/logo_descargado.${tipo}`;
                fs.writeFileSync(LOGO_PATH, buf);
            }
        } catch (e) {}
    }
    if (!LOGO_PATH) LOGO_PATH = buscarLogoLocal();
}

function leerNumero(ruta) {
    try { return fs.readFileSync(ruta, 'utf8').trim(); } catch (e) { return null; }
}

function cpuUsadaSegundos() {
    const v2 = leerNumero('/sys/fs/cgroup/cpu.stat');
    if (v2) {
        const m = v2.match(/usage_usec\s+(\d+)/);
        if (m) return Number(m[1]) / 1e6;
    }
    return null;
}

function nucleosDisponibles() {
    const v2 = leerNumero('/sys/fs/cgroup/cpu.max');
    if (v2) {
        const [cuota, periodo] = v2.split(/\s+/);
        if (cuota && cuota !== 'max' && Number(periodo) > 0) return Number(cuota) / Number(periodo);
    }
    return os.cpus().length;
}

function corregirUrl(url) {
    if (!url) return FALLBACK_IMAGE;
    if (url.includes("dropbox.com")) {
        return url.replace(/www\.dropbox\.com/, "dl.dropboxusercontent.com").replace(/\?dl=0/, "").replace(/\?dl=1/, "");
    }
    const prefijoHF = `https://huggingface.co/datasets/${DATASET_REPO_ID}/`;
    if (url.startsWith(prefijoHF)) {
        const m = url.slice(prefijoHF.length).match(/^(?:resolve|blob|raw)\/[^/]+\/([^?#]+)/);
        if (m) return `http://127.0.0.1:${port}/_hf/${m[1]}`;
    }
    return url;
}

function verificarEstadoEvento() {
    const ahoraVE = obtenerTiempoVenezuela().fechaVE;
    const aj = datasetConfig.ajustes || AJUSTES_DEFECTO;
    const horasAntes = Number(aj.horasAntes) > 0 ? Number(aj.horasAntes) : 12;
    const hhmm = (h) => String(h).split(':').slice(0, 2).join(':');
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    if (eventoForzado) return { tipo: 'en_curso', evento: eventoForzado.ev, forzado: true };

    let enCurso = null, proximo = null;
    for (let ev of datasetConfig.evento) {
        if (!ev || !ev.fechaInicio || !ev.horaInicio || !ev.horaFin) continue;
        let inicioEv = new Date(`${ev.fechaInicio}T${hhmm(ev.horaInicio)}:00`);
        let finEv = new Date(`${ev.fechaFin || ev.fechaInicio}T${hhmm(ev.horaFin)}:00`);
        if (isNaN(inicioEv) || isNaN(finEv) || finEv <= inicioEv) continue;

        if (ev.repetir) {
            const duracion = finEv - inicioEv;
            const base = new Date(`${fmt(ahoraVE)}T${hhmm(ev.horaInicio)}:00`);
            const cand = [-1, 0, 1].map(d => {
                const i = new Date(base.getTime() + d * 86400000);
                return { i, f: new Date(i.getTime() + duracion) };
            }).find(c => ahoraVE <= c.f);
            if (cand) { inicioEv = cand.i; finEv = cand.f; }
        }

        const idInst = `${ev.nombre}|${fmt(inicioEv)}|${hhmm(ev.horaInicio)}`;
        if (eventosFinalizados.has(idInst)) continue;
        const diffMs = inicioEv - ahoraVE;
        if (ahoraVE >= inicioEv && ahoraVE <= finEv) {
            enCurso = { tipo: 'en_curso', evento: ev, idInst };
            break;
        }
        if (diffMs > 0 && diffMs <= horasAntes * 3600000) {
            if (!proximo || diffMs < proximo.diffMs) {
                const horas = Math.floor(diffMs / (1000 * 60 * 60));
                const minutos = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                const segundos = Math.floor((diffMs % (1000 * 60)) / 1000);
                proximo = { tipo: 'proximo', evento: ev, tiempoRestante: `Faltan ${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}:${String(segundos).padStart(2, '0')}`, diffMs };
            }
        }
    }
    return enCurso || proximo;
}

setInterval(() => {
    const est = verificarEstadoEvento();
    if (est && est.tipo === 'proximo') {
        escribirCuenta(`${est.evento.nombre}\n${est.tiempoRestante}`);
        estadoActualTransmision.eventoActivo = est.evento.nombre;
        estadoActualTransmision.tiempoRestanteEvento = est.tiempoRestante;
    } else {
        estadoActualTransmision.eventoActivo = (est && est.tipo === 'en_curso') ? est.evento.nombre : null;
        estadoActualTransmision.tiempoRestanteEvento = "";
    }
}, 1000);

function getTodaPublicidad() {
    return (datasetConfig.publicidad || []).filter(p => p && (p.video || p.url)).map(p => corregirUrl(p.video || p.url));
}

function getVideoInicioProg(nombrePrograma) {
    const lista = datasetConfig.inicioProg;
    if (!Array.isArray(lista)) return "";
    const buscado = (nombrePrograma || "").toLowerCase().trim();
    const item = lista.find(x => ((x.programa || x.nombre || "").toLowerCase().trim()) === buscado);
    return item ? corregirUrl(item.video || item.url) : "";
}

function claveListaDePrograma(prog) {
    const n = prog && prog.archivo ? prog.archivo.toLowerCase() : "";
    if (n.includes("magazine")) return 'magazine';
    if (n.includes("secretos") || n.includes("prosperidad")) return 'secretosProsperidad';
    if (n.includes("cartas") || n.includes("taron")) return 'cartasTaron';
    return datasetConfig.magazine.length > 0 ? 'magazine' : 'cartasTaron';
}

function bloqueVencido(item) {
    if (!item.corteSuave || item.forzado) return false;
    const { horaCompletaStr } = obtenerTiempoVenezuela();
    if (!estaEnHorario(item.horaInicioBloque, item.horaFinBloque, horaCompletaStr)) return true;
    const ev = verificarEstadoEvento();
    return !!(ev && ev.tipo === 'en_curso');
}

let indiceGistActual = 0;

function obtenerElementoActualEnEmision() {
    const { horaStr, horaCompletaStr } = obtenerTiempoVenezuela();
    estadoActualTransmision.horaVenezuela = horaCompletaStr;
    const diaSemana = diaSemanaVenezuela();
    const fechaHoyStr = fechaVenezuelaStr();

    if (datasetConfig.himno && datasetConfig.himno.length > 0) {
        for (let hItem of datasetConfig.himno) {
            let idHimnoUnico = `${fechaHoyStr}-${hItem.inicio}`;
            const finVentana = hItem.fin || sumarSegundosHora(hItem.inicio, HIMNO_VENTANA_MIN * 60);
            if (estaEnHorario(hItem.inicio, finVentana, horaCompletaStr)) {
                if (ultimoHimnoReproducido !== idHimnoUnico) {
                    return { tipo: 'himno', idUnico: idHimnoUnico, secuencia: [{ url: corregirUrl(hItem.url), logo: false, desc: "Himno Nacional" }] };
                }
            }
        }
    }

    if (programaForzado === null && datasetConfig.vivo && datasetConfig.vivo.length > 0) {
        for (let vivoItem of datasetConfig.vivo) {
            if (vivoItem.dias.includes(diaSemana) && estaEnHorario(vivoItem.inicio, vivoItem.fin, horaCompletaStr)) {
                return { tipo: 'vivo', horaFinBloque: vivoItem.fin, corteEstricto: true, secuencia: [{ url: corregirUrl(vivoItem.url), logo: false, desc: `Retransmisión en Vivo` }] };
            }
        }
    }

    const estadoEv = verificarEstadoEvento();
    if (programaForzado === null && estadoEv && estadoEv.tipo === 'en_curso') {
        let ev = estadoEv.evento;
        return { tipo: 'evento', secuencia: [{ url: corregirUrl(ev.fuente), logo: false, desc: `Evento: ${ev.nombre}` }] };
    }

    if (slotCompletado) {
        const aun = datasetConfig.programacion.some(p => p.dias.includes(diaSemana) && estaEnHorario(p.inicio, p.fin, horaStr) && `${p.nombre}|${p.inicio}` === slotCompletado);
        if (!aun) slotCompletado = "";
    }

    for (let i = 0; i < datasetConfig.programacion.length; i++) {
        let prog = datasetConfig.programacion[i];
        const esForzado = (programaForzado !== null && i === programaForzado);
        if (programaForzado !== null ? esForzado : (prog.dias.includes(diaSemana) && estaEnHorario(prog.inicio, prog.fin, horaStr) && slotCompletado !== `${prog.nombre}|${prog.inicio}`)) {
            if (esForzado) { programaForzado = null; slotCompletado = ""; }
            let listaPrograma = datasetConfig[claveListaDePrograma(prog)];
            let claveProg = `${prog.nombre}-${prog.inicio}`;
            if (indicesProgramas[claveProg] === undefined) indicesProgramas[claveProg] = 0;
            let indiceVideoActual = indicesProgramas[claveProg];

            let secuenciaBloque = [];
            if (listaPrograma && listaPrograma.length > 0) {
                if (indiceVideoActual >= listaPrograma.length) indiceVideoActual = 0;
                let videoObj1 = listaPrograma[indiceVideoActual];
                secuenciaBloque.push({
                    url: corregirUrl(videoObj1.video || videoObj1.url),
                    logo: false, // Desactivado por defecto para ahorrar CPU
                    desc: `${prog.nombre} (Parte ${indiceVideoActual + 1})`,
                    alTerminar: () => { indicesProgramas[claveProg] = (indiceVideoActual + 1) % listaPrograma.length; guardarEstadoPersistente(); }
                });
            }

            return {
                tipo: 'programa_secuencia',
                forzado: esForzado,
                horaInicioBloque: prog.inicio,
                horaFinBloque: prog.fin,
                corteSuave: true,
                claveSlot: `${prog.nombre}|${prog.inicio}`,
                secuencia: secuenciaBloque
            };
        }
    }

    if (datasetConfig.playlistGist.length > 0) {
        if (indiceGistActual >= datasetConfig.playlistGist.length) indiceGistActual = 0;
        let itemGist = datasetConfig.playlistGist[indiceGistActual];
        indiceGistActual++;
        return { tipo: 'gist', secuencia: [{ url: corregirUrl(itemGist.video || itemGist.url), logo: false, desc: "Gist Respaldo" }] };
    }

    return { tipo: 'fallback', secuencia: [{ url: FALLBACK_IMAGE, logo: false, desc: "Imagen de Salvación" }] };
}

function ajusteHorarioActivo() {
    return (datasetConfig.ajustes || AJUSTES_DEFECTO).ajusteHorario !== false;
}

function programaProgramadoAhora() {
    const { horaStr } = obtenerTiempoVenezuela();
    const diaSemana = diaSemanaVenezuela();
    for (const prog of datasetConfig.programacion) {
        if (prog.dias.includes(diaSemana) && estaEnHorario(prog.inicio, prog.fin, horaStr)) {
            return { prog, clave: `${prog.nombre}|${prog.inicio}` };
        }
    }
    return null;
}

async function motorCanalC() {
    await prepararLogo();
    if (RTMP_URL) iniciarRTMP();
    await sincronizarDataset();
    while (true) {
        interrumpirBloque = false;
        let itemActual = colaManual.length > 0 ? { tipo: 'manual', secuencia: [colaManual.shift()] } : obtenerElementoActualEnEmision();

        if (itemActual.tipo === 'himno' && itemActual.idUnico) ultimoHimnoReproducido = itemActual.idUnico;

        let listaElementos = itemActual.secuencia || [];
        for (let i = 0; i < listaElementos.length; i++) {
            let video = listaElementos[i];
            if (interrumpirBloque) { interrumpirBloque = false; break; }
            if (!video.url) continue;
            if (i > 0 && bloqueVencido(itemActual)) break;

            itemEnAire = video;
            bloqueEnAire = { tipo: itemActual.tipo || '', cola: listaElementos.map(v => v.desc), indice: i };

            const urlFinal = corregirUrl(video.url);

            // MÁXIMO RENDIMIENTO: Usamos copy directo si no hay filtros requeridos. 
            // Si el video requiere procesamiento pero queremos CERO congelamientos, se usa -preset ultrafast y ajuste de PTS de audio/video.
            let ffmpegArgs = [
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '2',
                '-timeout', '10000000',
                '-fflags', '+genpts+ignidx+discardcorrupt',
                '-err_detect', 'ignore_err',
                '-user_agent', UA_NAVEGADOR,
                '-probesize', '1M',
                '-analyzeduration', '1000000',
                ...(HILOS ? ['-threads', HILOS] : []),
                '-thread_queue_size', '1024',
                '-re',
                '-i', urlFinal
            ];

            // Forzamos el mapeo inteligente y corrección de sincronización de audio (-async / aresample)
            // para evitar que el video se congele y el audio corra por delante debido a la saturación del CPU.
            console.log(`\n📺 AIRE (MODO LIGERO ANTI-CONGELAMIENTO): ${video.desc}`);
            
            ffmpegArgs.push(
                '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
                '-pix_fmt', 'yuv420p',
                '-g', String(Math.round(FPS_SALIDA * SEGUNDOS_CUADRO_CLAVE)),
                '-keyint_min', String(Math.round(FPS_SALIDA * SEGUNDOS_CUADRO_CLAVE)),
                '-sc_threshold', '0',
                // Forzamos tasa de bits manejable para evitar saturación de CPU
                '-b:v', '800k', '-maxrate', '1200k', '-bufsize', '1600k',
                // Corrección estricta de sincronización de audio para evitar desfases
                '-c:a', 'aac', '-b:a', `${BITRATE_AUDIO}k`, '-ac', '2',
                '-af', 'aresample=async=1:min_hard_comp=0.100:first_pts=0',
                '-max_muxing_queue_size', '1024',
                '-muxdelay', '0', '-flush_packets', '1',
                '-f', 'mpegts', 'udp://127.0.0.1:9999?pkt_size=1316'
            );

            await new Promise((resolve) => {
                const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
                procesoActual = ffmpegProc;
                let ultimoFrame = Date.now();

                const watchdogCongelamiento = setInterval(() => {
                    if (Date.now() - ultimoFrame > 12000) {
                        try { ffmpegProc.kill('SIGKILL'); } catch (e) {}
                    }
                }, 4000);

                ffmpegProc.stderr.on('data', (data) => {
                    const msg = data.toString();
                    if (msg.includes("frame=")) ultimoFrame = Date.now();
                });

                ffmpegProc.on('close', () => {
                    clearInterval(watchdogCongelamiento);
                    if (procesoActual === ffmpegProc) procesoActual = null;
                    if (!reinicioSolicitado && typeof video.alTerminar === 'function') video.alTerminar();
                    resolve();
                });
            });

            if (reinicioSolicitado) {
                reinicioSolicitado = false;
                i--;
            }
        }
        await new Promise(r => setTimeout(r, 500));
    }
}

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
