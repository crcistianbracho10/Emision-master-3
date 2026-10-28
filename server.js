const { spawn } = require('child_process');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

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
const port = process.env.PORT || 8080; // blitz.cloud lee el puerto declarado en el Dockerfile (EXPOSE 8080)

const DATASET_REPO_ID = process.env.DATASET_REPO_ID || "cristianbracho904/programacion-tv";
const DATASET_BRANCH = process.env.DATASET_BRANCH || "main";
const HF_TOKEN = process.env.HF_TOKEN || "";
// Salida RTMP (opcional): URL completa de ingesta, con la clave y los tokens. NUNCA va en el código (la imagen es pública),
// solo en las variables de entorno. Ejemplo: rtmp://live.opencaster.com/opencaster/NOMBRE?psk=...&tk=...
const RTMP_URL = (process.env.RTMP_URL || "").trim();
// El canal sale SOLO por RTMP (ya no se crean archivos HLS). El codificador manda la señal al puerto local 9999 y de ahí la toma el proceso RTMP.
const RTMP_PUENTE_PUERTO = 9999;

const GIST_FALLBACK_URL = "https://gist.githubusercontent.com/crcistianbracho10/6e4a07d268460ea807abf28f77c3880e/raw";
const FALLBACK_IMAGE = "https://www.dropbox.com/scl/fi/x9xpsosc6mlmn5rw8e2at/Copilot_20260224_002036.png?rlkey=340kgc42pa64ytajhzv0vl53b&st=qr7ly3ru&dl=1";
const BANNER_EVENTO_DEFECTO = "https://ibb.co/KpGf6Zxp";
const BANNER_RESPALDO_DEFECTO = "https://i.postimg.cc/v8vXL9BV/images-(1)-(1).png";
const ARCHIVO_ESTADO_PERSISTENTE = '/tmp/estado_episodios.json';
const ARCHIVO_CUENTA = '/tmp/cuenta_regresiva.txt';
const ARCHIVO_CINTILLO = '/tmp/cintillo.txt';
const HILOS = process.env.FFMPEG_THREADS || ''; // limita los hilos de ffmpeg (útil en servidores chicos)
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
    salida: "720p",
    ajusteHorario: true,
    toleranciaMinutos: 3
};

let datasetConfig = {
    vivo: [],
    programacion: [],
    himno: [
        { url: HIMNO_OFICIAL_URL, inicio: "06:00:00", fin: "06:04:30" }, 
        { url: HIMNO_OFICIAL_URL, inicio: "00:00:00", fin: "00:04:30" }, 
        { url: HIMNO_OFICIAL_URL, inicio: "18:00:00", fin: "18:04:30" }
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

// Secciones que se pueden editar desde el panel y su archivo en el dataset
const CLAVES_PANEL = {
    evento:              { archivo: 'evento.txt', tipo: 'lista' },
    ajustes:             { archivo: 'ajustes.txt', tipo: 'objeto' },
    programacion:        { archivo: 'programacion.txt', tipo: 'lista' },
    vivo:                { archivo: 'vivo.txt', tipo: 'lista' },
    publicidad:          { archivo: 'publicidad.txt', tipo: 'lista' },
    intros:              { archivo: 'intros.txt', tipo: 'lista' },
    clasificacion:       { archivo: 'clasificacion.txt', tipo: 'lista' },
    inicioProg:          { archivo: 'inicioprog.txt', tipo: 'lista' },
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
let ultimoHimnoReproducido = ""; // Control para evitar bucle infinito del himno
let ultimoInicioProg = "";       // Evita repetir "A continuación" dentro del mismo programa
let ultimoEventoPublicidad = ""; // Publicidad completa solo una vez antes de cada evento

// Estado del control manual (panel)
let procesoActual = null;          // proceso ffmpeg en emisión
let itemEnAire = null;             // video en emisión
let bloqueEnAire = { tipo: '', cola: [], indice: 0 };
let interrumpirBloque = false;     // el panel pidió recalcular qué va al aire
let reinicioSolicitado = false;    // el panel pidió repetir el video actual
let colaManual = [];               // videos insertados a mano
let eventoForzado = null;          // evento iniciado a mano
const eventosFinalizados = new Set(); // eventos finalizados a mano
let pruebaBanner = { inicio: 0, hasta: 0, segundos: 3600 }; // prueba del banner
let programaForzado = null;        // índice (en programacion) del programa iniciado a mano
const lentos = new Map();          // videos que fueron demasiado lentos: url -> momento (se saltan 1 hora)
let revision = { estado: 'ninguna', clave: '', total: 0, hechos: 0, filas: [] }; // revisión de formato de videos
let salud = { speed: null, fps: null, t: 0, ultimoAviso: 0 }; // velocidad de codificación del servidor
let slotCompletado = "";          // programa cuyo horario ya no admite más episodios (se rellena hasta que termine)

function cargarEstadoPersistente() {
    try {
        if (fs.existsSync(ARCHIVO_ESTADO_PERSISTENTE)) {
            const data = fs.readFileSync(ARCHIVO_ESTADO_PERSISTENTE, 'utf8');
            indicesProgramas = JSON.parse(data);
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
// Imágenes del evento (banner y personaje)
// ---------------------------------------------------------------
let imagenesEvento = {
    banner: { url: "", ruta: null },
    personaje: { url: "", ruta: null }
};

function detectarExtension(buf) {
    if (buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';
    if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
    if (buf.slice(0, 3).toString() === 'GIF') return 'gif';
    return null;
}

// Descarga una imagen. Si el enlace es una página HTML (ej. ibb.co/xxxx) busca la imagen real (og:image).
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
    const options = {
        timeZone: 'America/Caracas',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    };
    const formatter = new Intl.DateTimeFormat('en-GB', options);
    const parts = formatter.formatToParts(new Date());
    const getPart = (type) => parts.find(p => p.type === type).value;
    const h = getPart('hour');
    const m = getPart('minute');
    const s = getPart('second');
    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    const horaStr = `${h}:${m}`;
    const horaCompletaStr = `${h}:${m}:${s}`;
    const fechaVE = new Date(`${year}-${month}-${day}T${h}:${m}:${s}`);
    return { horaStr, horaCompletaStr, fechaVE, h: parseInt(h), m: parseInt(m) };
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
    const h = partes[0] || 0;
    const m = partes[1] || 0;
    const s = partes[2] || 0;
    return h * 3600 + m * 60 + s;
}

function estaEnHorario(inicio, fin, horaActualStr) {
    const secInicio = convertirSegundos(inicio);
    const secFin = convertirSegundos(fin);
    const secActual = convertirSegundos(horaActualStr);
    if (secInicio <= secFin) {
        return secActual >= secInicio && secActual < secFin;
    } else {
        return secActual >= secInicio || secActual < secFin;
    }
}

app.get('/', (req, res) => {
    res.send('Canal C transmitiendo por RTMP.');
});

app.get('/api/estado', (req, res) => {
    res.json(estadoActualTransmision);
});

// ---------------------------------------------------------------
// Dataset (Hugging Face) + cambios hechos desde el panel
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

// Guarda el archivo en el dataset de Hugging Face (requiere HF_TOKEN con permiso de escritura)
async function guardarEnHuggingFace(archivo, datos) {
    if (!HF_TOKEN) return false;
    try {
        const contenido = JSON.stringify(datos, null, 2);
        const cuerpo = [
            JSON.stringify({ key: 'header', value: { summary: `Panel: actualiza ${archivo}` } }),
            JSON.stringify({ key: 'file', value: { content: Buffer.from(contenido, 'utf8').toString('base64'), path: archivo, encoding: 'base64' } })
        ].join('\n');
        await axios.post(
            `https://huggingface.co/api/datasets/${DATASET_REPO_ID}/commit/${DATASET_BRANCH}`,
            cuerpo,
            { headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/x-ndjson' }, timeout: 30000 }
        );
        return true;
    } catch (e) {
        console.log(`⚠️ [PANEL] No se pudo guardar ${archivo} en Hugging Face: ${e.response ? e.response.status : e.message}`);
        return false;
    }
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
            } else {
                aplicarConfig(clave, ov.datos); // cambio del panel aún pendiente de reflejarse en HF
            }
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

setInterval(sincronizarDataset, 45000);

// ---------------------------------------------------------------
// Salida RTMP: manda la misma señal del canal a un servidor externo (sin recodificar)
// ---------------------------------------------------------------
let procesoRtmp = null;
let reintentoRtmp = null;

function ocultarClaveRtmp(texto) {
    // Nunca se escribe la clave en el registro (el panel y los logs pueden verse)
    return RTMP_URL ? String(texto).split(RTMP_URL).join('rtmp://***') : String(texto);
}

function iniciarRTMP() {
    if (!RTMP_URL) return;
    if (reintentoRtmp) { clearTimeout(reintentoRtmp); reintentoRtmp = null; }
    if (procesoRtmp) {
        try { procesoRtmp.removeAllListeners('close'); procesoRtmp.kill('SIGKILL'); } catch (e) {}
    }
    console.log('📡 [RTMP] Conectando salida RTMP...');
    const proc = spawn('ffmpeg', [
        '-fflags', '+nobuffer+genpts',
        '-i', `udp://127.0.0.1:${RTMP_PUENTE_PUERTO}?buffer_size=8000000&fifo_size=500000&overrun_nonfatal=1`,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-f', 'flv',
        RTMP_URL
    ]);
    procesoRtmp = proc;
    let conectado = false;
    proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (!msg) return;
        if (!conectado && msg.includes('frame=')) {
            conectado = true;
            console.log('✅ [RTMP] Transmitiendo al servidor RTMP.');
        }
        if (/decode_slice_header|non-existing PPS|Last message repeated|co located POCs|mmco|reference picture missing|Packet corrupt|no frame/i.test(msg)) return;
        if (/error|failed|refused|timed out|denied|unauthorized|Input\/output/i.test(msg) && !msg.includes('frame=')) {
            console.log(`[RTMP ERROR]: ${ocultarClaveRtmp(msg).slice(0, 300)}`);
        }
    });
    proc.on('close', (code, signal) => {
        console.log(`⚠️ [RTMP] La salida RTMP se cerró (código ${code}, señal ${signal}). Reintentando en 5s...`);
        reintentoRtmp = setTimeout(iniciarRTMP, 5000);
    });
}


function corregirUrl(url) {
    if (!url) return FALLBACK_IMAGE;
    if (url.includes("dropbox.com")) {
        return url.replace(/www\.dropbox\.com/, "dl.dropboxusercontent.com")
                  .replace(/\?dl=0/, "").replace(/\?dl=1/, "");
    }
    // Videos de tu dataset (repositorio privado): ffmpeg los lee por el servidor, que usa el token
    const prefijoHF = `https://huggingface.co/datasets/${DATASET_REPO_ID}/`;
    if (url.startsWith(prefijoHF)) {
        const m = url.slice(prefijoHF.length).match(/^(?:resolve|blob|raw)\/[^/]+\/([^?#]+)/);
        if (m) return `http://127.0.0.1:${port}/_hf/${m[1]}`;
    }
    return url;
}

// ---------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------
const eventosAdvertidos = new Set();

function verificarEstadoEvento() {
    const ahoraVE = obtenerTiempoVenezuela().fechaVE;
    const aj = datasetConfig.ajustes || AJUSTES_DEFECTO;
    const horasAntes = Number(aj.horasAntes) > 0 ? Number(aj.horasAntes) : 12;
    const hhmm = (h) => String(h).split(':').slice(0, 2).join(':');
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    // Evento iniciado a mano desde el panel: se mantiene hasta que se finalice
    if (eventoForzado) return { tipo: 'en_curso', evento: eventoForzado.ev, forzado: true };

    let enCurso = null;
    let proximo = null;

    for (let ev of datasetConfig.evento) {
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

        const idInst = `${ev.nombre}|${fmt(inicioEv)}|${hhmm(ev.horaInicio)}`;
        if (eventosFinalizados.has(idInst)) continue; // finalizado a mano desde el panel
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
                const tiempoRestanteStr = `Faltan ${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}:${String(segundos).padStart(2, '0')}`;
                proximo = { tipo: 'proximo', evento: ev, tiempoRestante: tiempoRestanteStr, diffMs };
            }
        }
    }
    if (enCurso || proximo) return enCurso || proximo;

    // Prueba de banner pedida desde el panel (cuenta regresiva simulada)
    if (pruebaBanner.hasta > Date.now()) {
        const rest = Math.max(0, pruebaBanner.segundos * 1000 - (Date.now() - pruebaBanner.inicio));
        const pad = (n) => String(n).padStart(2, '0');
        const nombre = (datasetConfig.evento[0] && datasetConfig.evento[0].nombre) || 'Evento Especial';
        return {
            tipo: 'proximo',
            evento: { nombre },
            tiempoRestante: `Faltan ${pad(Math.floor(rest / 3600000))}:${pad(Math.floor((rest % 3600000) / 60000))}:${pad(Math.floor((rest % 60000) / 1000))}`,
            prueba: true
        };
    }
    return null;
}

// Cada segundo actualiza el archivo que ffmpeg lee para dibujar la cuenta regresiva
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

// ---------------------------------------------------------------
// Helpers de publicidad, "a continuación" y cierre seguro
// ---------------------------------------------------------------

// Devuelve TODAS las URLs de publicidad.txt (no solo la primera)
function getTodaPublicidad() {
    return (datasetConfig.publicidad || [])
        .filter(p => p && (p.video || p.url))
        .map(p => corregirUrl(p.video || p.url));
}

// Busca en inicioprog.txt el video "A continuación" del programa
// Formato: [{ "programa": "Nombre exacto del programa", "video": "https://..." }]
function getVideoInicioProg(nombrePrograma) {
    const lista = datasetConfig.inicioProg;
    if (!Array.isArray(lista)) return "";
    const buscado = (nombrePrograma || "").toLowerCase().trim();
    const item = lista.find(x => ((x.programa || x.nombre || "").toLowerCase().trim()) === buscado);
    return item ? corregirUrl(item.video || item.url) : "";
}

// Programas de hoy (según el día de Venezuela) con su estado, para el panel
function programacionDeHoy() {
    const { horaStr, horaCompletaStr } = obtenerTiempoVenezuela();
    const dia = diaSemanaVenezuela();
    const nombresDia = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const todos = datasetConfig.programacion || [];
    const lista = todos
        .map((p, i) => ({ i, nombre: p.nombre, inicio: p.inicio, fin: p.fin, dias: p.dias || [] }))
        .filter(p => p.dias.includes(dia))
        .sort((a, b) => convertirSegundos(a.inicio) - convertirSegundos(b.inicio));
    const ahoraSeg = convertirSegundos(horaCompletaStr);
    lista.forEach(p => {
        const ini = convertirSegundos(p.inicio);
        p.estado = estaEnHorario(p.inicio, p.fin, horaStr) ? 'ahora' : (ini > ahoraSeg ? 'proximo' : 'terminado');
        p.faltanMin = ini > ahoraSeg ? Math.ceil((ini - ahoraSeg) / 60) : null;
        delete p.dias;
    });
    return { dia: nombresDia[dia], total: todos.length, lista };
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
    if (!item.corteSuave) return false;
    if (item.forzado) return false; // programa iniciado a mano desde el panel: corre completo
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

    // 1. Verificación del Himno Nacional (con control de reproducción única por bloque diario)
    if (datasetConfig.himno && datasetConfig.himno.length > 0) {
        for (let hItem of datasetConfig.himno) {
            let idHimnoUnico = `${fechaHoyStr}-${hItem.inicio}`;
            if (estaEnHorario(hItem.inicio, hItem.fin, horaCompletaStr)) {
                if (ultimoHimnoReproducido !== idHimnoUnico) {
                    estadoActualTransmision.tituloActual = "Himno Nacional";
                    estadoActualTransmision.programaActual = "Transmisión Oficial";
                    estadoActualTransmision.aContinuacion = "Programación Regular";
                    return {
                        tipo: 'himno',
                        idUnico: idHimnoUnico,
                        horaFinBloque: hItem.fin,
                        corteEstricto: true,
                        secuencia: [{ url: corregirUrl(hItem.url), logo: true, logoDer: false, desc: "Himno Nacional" }]
                    };
                }
            }
        }
    }

    // 2. Verificación de transmisiones en vivo (vivo.txt)
    if (programaForzado === null && datasetConfig.vivo && datasetConfig.vivo.length > 0) {
        for (let vivoItem of datasetConfig.vivo) {
            if (vivoItem.dias.includes(diaSemana) && estaEnHorario(vivoItem.inicio, vivoItem.fin, horaCompletaStr)) {
                estadoActualTransmision.tituloActual = `Retransmisión: ${vivoItem.nombre}`;
                estadoActualTransmision.programaActual = vivoItem.nombre;
                estadoActualTransmision.aContinuacion = "Programación Regular";
                return {
                    tipo: 'vivo',
                    horaFinBloque: vivoItem.fin,
                    corteEstricto: true,
                    secuencia: [{ url: corregirUrl(vivoItem.url), logo: !vivoItem.sinLogo, logoDer: vivoItem.logoPosicion === 'derecha', permiteBanner: true, desc: `Retransmisión en Vivo: ${vivoItem.nombre}` }]
                };
            }
        }
    }

    const estadoEv = verificarEstadoEvento();
    if (programaForzado === null && estadoEv && estadoEv.tipo === 'en_curso') {
        let ev = estadoEv.evento;
        estadoActualTransmision.tituloActual = ev.nombre;
        estadoActualTransmision.programaActual = "Evento en Vivo";
        estadoActualTransmision.aContinuacion = "Programación Regular";

        let secuenciaEvento = [];

        // Antes del evento se reproduce TODA la publicidad (una sola vez por evento)
        const idEvento = `${ev.fechaInicio}-${ev.horaInicio}-${ev.nombre}`;
        if (ultimoEventoPublicidad !== idEvento) {
            const anuncios = getTodaPublicidad();
            anuncios.forEach((u, n) => {
                secuenciaEvento.push({ url: u, logo: false, desc: `Publicidad antes del evento (${n + 1}/${anuncios.length})` });
            });
            ultimoEventoPublicidad = idEvento;
        }

        secuenciaEvento.push({ url: corregirUrl(ev.fuente), logo: true, logoDer: ev.logoPosicion === 'derecha', desc: `Evento: ${ev.nombre}` });

        return {
            tipo: 'evento',
            secuencia: secuenciaEvento
        };
    }

    // Si ya no hay programa en horario (o es otro distinto), se libera la marca de "programa completado"
    if (slotCompletado) {
        const aun = datasetConfig.programacion.some(p => p.dias.includes(diaSemana) && estaEnHorario(p.inicio, p.fin, horaStr) && `${p.nombre}|${p.inicio}` === slotCompletado);
        if (!aun) slotCompletado = "";
    }

    for (let i = 0; i < datasetConfig.programacion.length; i++) {
        let prog = datasetConfig.programacion[i];
        const esForzado = (programaForzado !== null && i === programaForzado);
        if (programaForzado !== null ? esForzado : (prog.dias.includes(diaSemana) && estaEnHorario(prog.inicio, prog.fin, horaStr) && slotCompletado !== `${prog.nombre}|${prog.inicio}`)) {
            if (esForzado) { programaForzado = null; slotCompletado = ""; }
            let siguienteProg = datasetConfig.programacion[i + 1] ? datasetConfig.programacion[i + 1].nombre : "Transmisión Estelar / Gist";
            estadoActualTransmision.tituloActual = prog.nombre;
            estadoActualTransmision.programaActual = prog.nombre;
            estadoActualTransmision.aContinuacion = siguienteProg;

            let intro1 = datasetConfig.intros.length > 0 ? corregirUrl(datasetConfig.intros[0].video) : "";
            let intro2 = datasetConfig.intros.length > 1 ? corregirUrl(datasetConfig.intros[1].video) : intro1;
            let videoClasificacion = getVideoClasificacionPorHora(horaStr);
            const anuncios = getTodaPublicidad();

            let listaPrograma = datasetConfig[claveListaDePrograma(prog)];

            let claveProg = `${prog.nombre}-${prog.inicio}`;
            if (indicesProgramas[claveProg] === undefined) {
                indicesProgramas[claveProg] = 0;
            }
            let indiceVideoActual = indicesProgramas[claveProg];

            // Agrega TODOS los anuncios a la secuencia
            const agregarPublicidad = (arr, etiqueta) => {
                anuncios.forEach((u, n) => {
                    arr.push({ url: u, logo: false, desc: `${etiqueta} (${n + 1}/${anuncios.length})` });
                });
            };

            let secuenciaBloque = [];

            // 1) "A continuación: [programa]" (inicioprog.txt) — solo al comenzar el programa
            const claveInicio = `${fechaHoyStr}-${claveProg}`;
            if (ultimoInicioProg !== claveInicio) {
                const videoInicioProg = getVideoInicioProg(prog.nombre);
                if (videoInicioProg) {
                    secuenciaBloque.push({ url: videoInicioProg, logo: false, desc: `A continuación: ${prog.nombre}` });
                } else {
                    console.log(`ℹ️ [A CONTINUACIÓN] "${prog.nombre}" no tiene video asignado (se agrega en el panel, pestaña "Agregar video").`);
                }
                ultimoInicioProg = claveInicio;
            }

            // 2) Intro 1 > toda la publicidad > Intro 2 > clasificación
            if (intro1) secuenciaBloque.push({ url: intro1, logo: false, desc: "Intro Canal (1)" });
            agregarPublicidad(secuenciaBloque, "Espacio Publicitario");
            if (intro2) secuenciaBloque.push({ url: intro2, logo: false, desc: "Intro Canal (2)" });
            if (videoClasificacion) secuenciaBloque.push({ url: videoClasificacion, logo: false, desc: "Clasificación Horaria" });

            if (listaPrograma && listaPrograma.length > 0) {
                if (indiceVideoActual >= listaPrograma.length) {
                    indiceVideoActual = 0;
                }
                const total = listaPrograma.length;
                const indice1 = indiceVideoActual;
                const indice2 = (indiceVideoActual + 1) % total;

                let videoObj1 = listaPrograma[indice1];
                secuenciaBloque.push({
                    url: corregirUrl(videoObj1.video || videoObj1.url),
                    logo: true,
                    logoDer: false,
                    permiteBanner: true, // aquí sí se muestra la cuenta regresiva del evento
                    desc: `${prog.nombre} (Parte 1 - ${indice1 + 1}/${total})`,
                    alTerminar: () => { indicesProgramas[claveProg] = (indice1 + 1) % total; guardarEstadoPersistente(); }
                });

                const inicioGrupo = secuenciaBloque.length; // desde aquí: intro + publicidad + Parte 2 (se evalúa si cabe en el horario)
                if (intro1) secuenciaBloque.push({ url: intro1, logo: false, desc: "Intro Intermedia (1)" });
                agregarPublicidad(secuenciaBloque, "Espacio Publicitario Intermedio");
                if (intro2) secuenciaBloque.push({ url: intro2, logo: false, desc: "Intro Intermedia (2)" });

                let videoObj2 = listaPrograma[indice2];
                secuenciaBloque.push({
                    url: corregirUrl(videoObj2.video || videoObj2.url),
                    logo: true,
                    logoDer: false,
                    permiteBanner: true,
                    desc: `${prog.nombre} (Parte 2 - ${indice2 + 1}/${total})`,
                    alTerminar: () => { indicesProgramas[claveProg] = (indice2 + 1) % total; guardarEstadoPersistente(); }
                });
                secuenciaBloque.slice(inicioGrupo).forEach(x => { x.grupo = 'parte2'; });
                secuenciaBloque[inicioGrupo].inicioGrupo = true;
            }

            return {
                tipo: 'programa_secuencia',
                forzado: esForzado,
                horaInicioBloque: prog.inicio,
                horaFinBloque: prog.fin,
                corteSuave: true, // NO corta videos a la fuerza: termina el video actual y cambia
                claveSlot: `${prog.nombre}|${prog.inicio}`,
                secuencia: secuenciaBloque
            };
        }
    }

    if (datasetConfig.playlistGist.length > 0) {
        if (indiceGistActual >= datasetConfig.playlistGist.length) indiceGistActual = 0;
        let itemGist = datasetConfig.playlistGist[indiceGistActual];
        indiceGistActual++;
        estadoActualTransmision.tituloActual = itemGist.title || "Canal C Playlist";
        estadoActualTransmision.programaActual = "Bloque Rotativo Gist";
        estadoActualTransmision.aContinuacion = "Programación en Espera";
        return {
            tipo: 'gist',
            claveSlot: slotCompletado || null,
            secuencia: [{ url: corregirUrl(itemGist.video || itemGist.url), logo: true, logoDer: false, permiteBanner: true, desc: "Gist Respaldo" }]
        };
    }

    estadoActualTransmision.tituloActual = "Señal de Ajuste";
    estadoActualTransmision.programaActual = "Mantenimiento";
    estadoActualTransmision.aContinuacion = "Ninguna";
    return {
        tipo: 'fallback',
        secuencia: [{ url: FALLBACK_IMAGE, logo: true, logoDer: false, desc: "Imagen de Salvación" }]
    };
}

function getVideoClasificacionPorHora(horaStr) {
    const clasifs = datasetConfig.clasificacion;
    if (!clasifs || clasifs.length === 0) return "";
    for (let c of clasifs) {
        if (estaEnHorario(c.inicio, c.fin, horaStr)) return corregirUrl(c.video);
    }
    return corregirUrl(clasifs[0].video);
}

// Convierte un valor del panel a número, con valor por defecto
function numAjuste(v, defecto) {
    if (v === '' || v === null || v === undefined || isNaN(Number(v))) return defecto;
    return Number(v);
}

function ajusteHorarioActivo() {
    return (datasetConfig.ajustes || AJUSTES_DEFECTO).ajusteHorario !== false;
}

// Programa que debería estar al aire ahora según programacion.txt (sin efectos secundarios)
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

// Duración de un video en segundos (con ffprobe). Devuelve null si no se puede medir (ej. en vivo).
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

// ¿Cabe este grupo de videos (intro + publicidad + Parte 2) antes de que termine el horario del programa?
async function grupoCabeEnHorario(grupo, bloque) {
    if (!ajusteHorarioActivo()) return true;
    const tolerancia = numAjuste((datasetConfig.ajustes || AJUSTES_DEFECTO).toleranciaMinutos, 3) * 60;
    const duraciones = await Promise.all(grupo.map(v => obtenerDuracion(v.url)));
    if (duraciones.some(d => !d)) return true; // si algún video no se puede medir, no se bloquea
    const total = duraciones.reduce((a, b) => a + b, 0);
    const { horaCompletaStr } = obtenerTiempoVenezuela();
    let restante = convertirSegundos(bloque.horaFinBloque) - convertirSegundos(horaCompletaStr);
    if (restante < 0) restante += 86400; // el programa cruza la medianoche
    return total <= restante + tolerancia;
}

function matarProcesoActual() {
    if (!procesoActual) return false;
    try { procesoActual.kill('SIGKILL'); } catch (e) {}
    return true;
}

// Interrumpe el bloque actual y obliga a recalcular qué va al aire
function forzarRecalculo() {
    interrumpirBloque = true;
    matarProcesoActual();
}

async function motorCanalC() {
    if (!fs.existsSync('Canal_C.png')) {
        console.log("❌ [LOG CRÍTICO] Falta el archivo 'Canal_C.png' en la raíz del proyecto.");
    }
    if (RTMP_URL) iniciarRTMP();
    else console.log('⚠️ [RTMP] Falta la variable de entorno RTMP_URL: el canal no tiene ninguna salida. Defínela y reinicia.');
    await sincronizarDataset();
    while (true) {
        interrumpirBloque = false;

        let itemActual;
        if (colaManual.length > 0) {
            // Video insertado a mano desde el panel
            const m = colaManual.shift();
            estadoActualTransmision.tituloActual = m.desc;
            estadoActualTransmision.programaActual = "Inserto manual";
            estadoActualTransmision.aContinuacion = "Programación Regular";
            itemActual = { tipo: 'manual', secuencia: [m] };
        } else {
            itemActual = obtenerElementoActualEnEmision();
        }

        // Si es himno, registramos que ya se reprodujo para este bloque exacto
        if (itemActual.tipo === 'himno' && itemActual.idUnico) {
            ultimoHimnoReproducido = itemActual.idUnico;
        }

        let listaElementos = itemActual.secuencia || [];
        let horaFinBloqueStr = itemActual.horaFinBloque || null;

        for (let i = 0; i < listaElementos.length; i++) {
            let video = listaElementos[i];

            // El panel pidió cambiar de bloque (evento manual, inserto, etc.)
            if (interrumpirBloque) {
                interrumpirBloque = false;
                console.log(`⏭️ [CONTROL] Bloque interrumpido desde el panel.`);
                break;
            }
            if (!video.url) continue;

            // Si el horario del programa terminó (o llega un evento) se omite el resto de la secuencia.
            // Solo se evalúa ENTRE videos: el video actual siempre termina.
            if (i > 0 && bloqueVencido(itemActual)) {
                console.log(`⏭️ [HORARIO] El bloque terminó. Se omite el resto de la secuencia.`);
                break;
            }

            if (itemActual.tipo === 'programa_secuencia') {
                // Mientras suena la Parte 1 se miden los videos de la Parte 2 (así no hay pausa después)
                // (de a una y solo cuando ya suena la Parte 1, para no competir con la codificación)
                if (video.alTerminar && !video.grupo && !video.sondeado) {
                    video.sondeado = true;
                    (async () => { for (const x of listaElementos.filter(y => y.grupo)) { await obtenerDuracion(x.url); } })();
                }
                // Si intro + publicidad + Parte 2 no caben antes de que termine el horario, no se empiezan:
                // el siguiente programa arranca a su hora y no se corta nada a la mitad.
                if (video.inicioGrupo && !itemActual.forzado) {
                    const grupo = listaElementos.filter(x => x.grupo === video.grupo);
                    if (!(await grupoCabeEnHorario(grupo, itemActual))) {
                        console.log(`⏱️ [HORARIO] La Parte 2 no cabe antes de las ${itemActual.horaFinBloque}. Se omite para que el siguiente programa empiece a su hora.`);
                        slotCompletado = itemActual.claveSlot;
                        break;
                    }
                }
            }

            // Videos que fueron demasiado lentos para emitirse en tiempo real: se saltan durante 1 hora
            if (!video.alTerminar && (itemActual.tipo === 'programa_secuencia' || itemActual.tipo === 'gist')) {
                const tLento = lentos.get(corregirUrl(video.url));
                if (tLento && Date.now() - tLento < 3600000) {
                    console.log(`⏭️ [SEÑAL] Se omite "${video.desc}" (iba demasiado lento; revísalo en el panel).`);
                    continue;
                }
            }

            itemEnAire = video;
            bloqueEnAire = { tipo: itemActual.tipo || '', cola: listaElementos.map(v => v.desc), indice: i };

            let xPos = video.logoDer ? "main_w-overlay_w-200" : "200";
            const urlFinal = corregirUrl(video.url);

            // Modo de codificación (Ajustes → modoCodificacion): calidad = más CPU, ligero = menos CPU
            const modoC = (datasetConfig.ajustes || AJUSTES_DEFECTO).modoCodificacion || 'equilibrado';
            const scaleFlags = modoC === 'calidad' ? 'lanczos' : (modoC === 'ligero' ? 'fast_bilinear' : 'bilinear');
            const presetX264 = modoC === 'ligero' ? 'superfast' : 'veryfast';
            // Salida 720p: la composición (logo, banner, barra) se hace en 1080p y al final se reduce; gasta menos CPU y menos datos
            const salida720 = ((datasetConfig.ajustes || AJUSTES_DEFECTO).salida || '1080p') === '720p';
            const bitrateV = salida720 ? '1200k' : '1500k';
            const maxrateV = salida720 ? '1500k' : '1800k';
            const bufsizeV = salida720 ? '2400k' : '3000k';
            console.log(`\n📺 AIRE: ${video.desc}`);

            let ffmpegArgs = [
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-timeout', '20000000',
                '-fflags', '+genpts+ignidx+discardcorrupt',
                '-err_detect', 'ignore_err',
                '-user_agent', UA_NAVEGADOR,
                ...(HILOS ? ['-threads', HILOS] : []),
                '-re',
                '-i', urlFinal,
                '-i', 'Canal_C.png'
            ];

            let filterComplex = video.logo ? 
                `[0:v]fps=24,scale=1920:1080:flags=${scaleFlags},setsar=1[bg];[1:v]scale=250:250[logo];[bg][logo]overlay=${xPos}:90[v1];` : 
                `[0:v]fps=24,scale=1920:1080:flags=${scaleFlags},setsar=1[v1];`;

            let etiqueta = 'v1';

            // Barra de noticias (azul, abajo): sube deslizando y el texto corre de derecha a izquierda.
            // Va DEBAJO del banner del evento (el banner queda encima y no se mueve).
            const ajN = datasetConfig.ajustes || AJUSTES_DEFECTO;
            if (video.permiteBanner && ajN.cintilloActivo && String(ajN.cintilloTexto || '').trim() !== '') {
                const velN = Math.max(40, numAjuste(ajN.cintilloVelocidad, 140));
                const colorN = /^[0-9a-fA-F]{6}$/.test(String(ajN.cintilloColor || '')) ? ajN.cintilloColor : '0a50c8';
                const fuenteN = FONT_FILE ? `fontfile=${FONT_FILE}:` : '';
                filterComplex += `color=c=0x${colorN}:s=1920x70:r=24[barra];` +
                                 `[${etiqueta}][barra]overlay=x=0:y='main_h-overlay_h*clip(t-1,0,1)':shortest=1[vn];` +
                                 `[vn]drawtext=${fuenteN}textfile=${ARCHIVO_CINTILLO}:reload=1:expansion=none:enable='gte(t,2)':x='w-mod((t-2)*${velN},w+tw)':y=main_h-56:fontsize=38:fontcolor=white[vk];`;
                etiqueta = 'vk';
            }

            // Cuenta regresiva del evento: solo en programación (episodios, retransmisiones y gist),
            // nunca en publicidad, intros ni clasificación.
            const estEv = video.permiteBanner ? verificarEstadoEvento() : null;
            if (estEv && estEv.tipo === 'proximo') {
                const aj = datasetConfig.ajustes || AJUSTES_DEFECTO;
                const S = Math.max(0, numAjuste(aj.segundosAparecer, 10));       // segundos tras iniciar el video
                const p = `clip(t-${S},0,1)`;                                    // Permanece fijo tras aparecer (no se oculta)
                const desliza = (x0) => `'${x0}-900*(1-${p})'`;                  // animación de entrada desde la izquierda

                const rutaBanner = imagenesEvento.banner.ruta && fs.existsSync(imagenesEvento.banner.ruta) ? imagenesEvento.banner.ruta : null;
                const rutaPj = imagenesEvento.personaje.ruta && fs.existsSync(imagenesEvento.personaje.ruta) ? imagenesEvento.personaje.ruta : null;
                
                const xCard = rutaPj ? 330 : 50;
                let idx = 2;

                if (rutaBanner) {
                    ffmpegArgs.push('-i', rutaBanner);
                    // Banner más ancho (600) y bajado en Y
                    filterComplex += `[${idx}:v]scale=600:-2[bnr];[${etiqueta}][bnr]overlay=x=${desliza(xCard)}:y=main_h-overlay_h-20[vb];`;
                    etiqueta = 'vb';
                    idx++;
                }
                if (rutaPj) {
                    ffmpegArgs.push('-i', rutaPj);
                    filterComplex += `[${idx}:v]scale=-2:360[pj];[${etiqueta}][pj]overlay=x=${desliza(30)}:y=main_h-overlay_h-50[vp];`;
                    etiqueta = 'vp';
                    idx++;
                }
                const fuente = FONT_FILE ? `fontfile=${FONT_FILE}:` : '';
                // Texto de la cuenta regresiva movido un poco más hacia la derecha (xCard + 50)
                filterComplex += `[${etiqueta}]drawtext=${fuente}textfile=${ARCHIVO_CUENTA}:reload=1:expansion=none:x=${desliza(xCard + 50)}:y=main_h-175:fontsize=42:fontcolor=white:box=1:boxcolor=black@0.0:boxborderw=19[vt];`;
                etiqueta = 'vt';
            }

            filterComplex += `[${etiqueta}]${salida720 ? 'scale=1280:720:flags=fast_bilinear,' : ''}format=yuv420p[v];[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a]`;

            ffmpegArgs.push('-filter_complex', filterComplex, '-map', '[v]', '-map', '[a]');
            ffmpegArgs.push(
                '-c:v', 'libx264', '-preset', presetX264, '-tune', 'zerolatency',
                ...(HILOS ? ['-threads', HILOS] : []),
                '-b:v', bitrateV, '-maxrate', maxrateV, '-bufsize', bufsizeV, '-g', '48',
                '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
                '-f', 'mpegts', 'udp://127.0.0.1:9999?pkt_size=1316'
            );

            await new Promise((resolve) => {
                const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
                procesoActual = ffmpegProc;
                let ultimoFrame = Date.now();
                const inicioProcTs = Date.now();
                let lentoDesde = 0, omitidoPorLento = false;
                const puedeOmitirPorLento = !video.alTerminar && (itemActual.tipo === 'programa_secuencia' || itemActual.tipo === 'gist');
                let duracionActual = 0, tiempoActual = 0, cortePorHorario = false;

                const verificadorHoraFin = setInterval(() => {
                    if (itemActual.tipo === 'evento') {
                        // El evento termina cuando su horario acaba o cuando se finaliza desde el panel
                        const e = verificarEstadoEvento();
                        if (!(e && e.tipo === 'en_curso')) {
                            console.log(`⏰ [EVENTO] El evento terminó. Cortando transmisión.`);
                            ffmpegProc.kill('SIGKILL');
                        }
                    } else if (horaFinBloqueStr && itemActual.corteEstricto) {
                        // Corte a la fuerza SOLO para himno y vivo (horario estricto).
                        // Los programas NO se cortan a mitad de video.
                        const { horaStr, horaCompletaStr } = obtenerTiempoVenezuela();
                        if (horaCompletaStr >= horaFinBloqueStr || horaStr >= horaFinBloqueStr) {
                            console.log(`⏰ [LOG HORARIO] Límite alcanzado (${horaFinBloqueStr}). Cortando transmisión actual.`);
                            ffmpegProc.kill('SIGKILL');
                        }
                    } else if ((itemActual.tipo === 'programa_secuencia' || itemActual.tipo === 'gist') && ajusteHorarioActivo() && !itemActual.forzado) {
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

                ffmpegProc.stderr.on('data', (data) => {
                    const msg = data.toString().trim();
                    if (msg.includes("frame=")) {
                        ultimoFrame = Date.now();
                        // Salud de la señal: velocidad de codificación (menos de 1x = el servidor no da abasto)
                        const sp = msg.match(/speed=\s*([\d.]+)x/g);
                        const fp = msg.match(/fps=\s*([\d.]+)/g);
                        if (sp) {
                            const v = parseFloat(sp[sp.length - 1].replace(/[^\d.]/g, ''));
                            if (!isNaN(v)) {
                                salud.speed = v; salud.t = Date.now();
                                if (v < 0.9 && Date.now() - inicioProcTs > 15000 && Date.now() - salud.ultimoAviso > 30000) {
                                    salud.ultimoAviso = Date.now();
                                    const carga = os.loadavg()[0].toFixed(1), nuc = os.cpus().length;
                                    console.log(`⚠️ [SEÑAL] "${video.desc}" va a ${v}x (menos de 1x = se congela). Carga del servidor: ${carga} de ${nuc} núcleos. ` +
                                        (os.loadavg()[0] < nuc * 0.7 ? 'El servidor no está saturado: el problema es ese video o su hosting (revísalo en el panel).' : 'El servidor está saturado: prueba modoCodificacion = ligero y salida = 720p.'));
                                }
                                // Lentitud sostenida en un video que no es episodio: se corta y se salta por 1 hora
                                if (v < 0.5 && Date.now() - inicioProcTs > 10000) {
                                    if (!lentoDesde) lentoDesde = Date.now();
                                    else if (Date.now() - lentoDesde > 15000 && puedeOmitirPorLento && !omitidoPorLento) {
                                        omitidoPorLento = true;
                                        lentos.set(urlFinal, Date.now());
                                        console.log(`⛔ [SEÑAL] "${video.desc}" va a ${v}x desde hace más de 15 s: se omite y no se usará por 1 hora. Revisa ese video (resolución, fps, códec o hosting lento).`);
                                        try { ffmpegProc.kill('SIGKILL'); } catch (e) {}
                                    }
                                } else if (v >= 0.5) { lentoDesde = 0; }
                            }
                        }
                        if (fp) salud.fps = parseFloat(fp[fp.length - 1].replace(/[^\d.]/g, ''));
                    }
                    // Duración total y avance del video (para el ajuste de horario)
                    if (!duracionActual) {
                        const d = msg.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
                        if (d) duracionActual = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
                    }
                    const tm = msg.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
                    if (tm) {
                        const u = tm[tm.length - 1].match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
                        tiempoActual = Number(u[1]) * 3600 + Number(u[2]) * 60 + Number(u[3]);
                    }
                });

                const watchdogCongelamiento = setInterval(() => {
                    if (Date.now() - ultimoFrame > 25000) {
                        console.log(`⚠️ [WATCHDOG] El video "${video.desc}" se congeló. Forzando reinicio del proceso.`);
                        ffmpegProc.kill('SIGKILL');
                    }
                }, 5000);

                ffmpegProc.on('close', (code) => {
                    console.log(`ℹ️ [CIERRE] Finalizó el archivo: ${video.desc} (Código: ${code})`);
                    clearInterval(verificadorHoraFin);
                    clearInterval(watchdogCongelamiento);
                    if (procesoActual === ffmpegProc) procesoActual = null;
                    // Si se reinicia el video a mano, no cuenta como terminado (no avanza el episodio)
                    // Si se reinició a mano o se cortó por horario, el episodio no cuenta como emitido
                    if (!reinicioSolicitado && !cortePorHorario && typeof video.alTerminar === 'function') video.alTerminar();
                    resolve();
                });
            });

            if (reinicioSolicitado) {
                reinicioSolicitado = false;
                i--; // repite el mismo video desde el inicio
            }
        }
        await new Promise(r => setTimeout(r, 500));
    }
}

// Proxy interno: permite que ffmpeg lea videos de tu dataset privado usando el token.
// Solo acepta conexiones locales (del propio servidor), nadie de afuera puede usarlo.
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

// Acepta un enlace completo (http...) o una ruta dentro de tu dataset (ej. videos/capitulo1.mp4)
function normalizarEnlace(u) {
    if (typeof u !== 'string') return '';
    u = u.trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return ''; // otro protocolo (ftp, etc.)
    return `https://huggingface.co/datasets/${DATASET_REPO_ID}/resolve/${DATASET_BRANCH}/${u.replace(/^\/+/, '').replace(/ /g, '%20')}`;
}

// Guarda en Hugging Face (si hay token) y deja copia local temporal
async function persistirClave(clave) {
    const info = CLAVES_PANEL[clave];
    const datos = datasetConfig[clave];
    const hfOk = await guardarEnHuggingFace(info.archivo, datos);
    guardarOverride(clave, datos, hfOk);
    return hfOk;
}

const probarEnlaceVelocidad = async (enlace) => {
    const destino = corregirUrl(enlace);
    const inicio = Date.now();
    try {
        const r = await axios.get(destino, {
            headers: { Range: 'bytes=0-1048575', 'User-Agent': UA_NAVEGADOR },
            responseType: 'stream', validateStatus: () => true, timeout: 15000, maxRedirects: 5
        });
        const tipo = r.headers['content-type'] || '';
        const cr = r.headers['content-range'] || '';
        const total = cr.includes('/') ? Number(cr.split('/')[1]) : Number(r.headers['content-length'] || 0);
        const bueno = r.status === 200 || r.status === 206;
        let bytes = 0;
        if (bueno) {
            await new Promise((resolve) => {
                const corte = setTimeout(() => { try { r.data.destroy(); } catch (e) {} resolve(); }, 8000);
                const fin = () => { clearTimeout(corte); resolve(); };
                r.data.on('data', (c) => { bytes += c.length; if (bytes >= 1048576) { try { r.data.destroy(); } catch (e) {} fin(); } });
                r.data.on('end', fin); r.data.on('error', fin); r.data.on('close', fin);
            });
        } else {
            try { r.data.destroy(); } catch (e) {}
        }
        const seg = Math.max(0.05, (Date.now() - inicio) / 1000);
        const mbps = bytes >= 524288 ? Math.round((bytes * 8 / seg / 1e6) * 10) / 10 : null; // solo si hay muestra suficiente
        return { ok: bueno, status: r.status, tipo, tamanoMB: total ? Math.round(total / 1048576) : null, mbps, deTuDataset: destino !== enlace && destino.indexOf('/_hf/') > -1 };
    } catch (e) {
        return { ok: false, status: 0, error: e.message };
    }
};

// ---- Revisión de formato de videos (para encontrar el que se pone lento) ----
function ffprobeInfo(u) {
    return new Promise((resolve) => {
        const http = /^https?:/i.test(u);
        const args = ['-n', '19', 'ffprobe', '-v', 'error', ...(http ? ['-user_agent', UA_NAVEGADOR, '-timeout', '15000000'] : []),
            '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,bit_rate,pix_fmt:format=duration,size,bit_rate',
            '-of', 'json', u];
        let out = '', p;
        try { p = spawn('nice', args); } catch (e) { return resolve(null); }
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 25000);
        p.stdout.on('data', d => { out += d; });
        p.on('error', () => { clearTimeout(t); resolve(null); });
        p.on('close', () => { clearTimeout(t); try { resolve(JSON.parse(out)); } catch (e) { resolve(null); } });
    });
}

// ¿El índice (moov) del MP4 está al principio? (true = “fast start”, false = al final, null = no se pudo saber)
async function detectarFaststart(destino) {
    try {
        const r = await axios.get(destino, { headers: { Range: 'bytes=0-4095', 'User-Agent': UA_NAVEGADOR }, responseType: 'arraybuffer', timeout: 15000, validateStatus: () => true });
        const buf = Buffer.from(r.data);
        if (buf.length < 16 || buf.toString('latin1', 4, 8) !== 'ftyp') return null;
        let off = 0;
        while (off + 8 <= buf.length) {
            let size = buf.readUInt32BE(off);
            const tipo = buf.toString('latin1', off + 4, off + 8);
            if (tipo === 'moov') return true;
            if (tipo === 'mdat') return false;
            if (size === 1 && off + 16 <= buf.length) size = Number(buf.readBigUInt64BE(off + 8));
            if (size < 8) break;
            off += size;
        }
    } catch (e) {}
    return null;
}

async function analizarVideo(enlace) {
    const destino = corregirUrl(enlace);
    const info = await ffprobeInfo(destino);
    if (!info || !info.streams || !info.streams[0]) return { ok: false, resumen: 'No se pudo leer el video (enlace caído o formato raro)', avisos: [] };
    const v = info.streams[0], f = info.format || {};
    const [a, b] = String(v.avg_frame_rate || '0/1').split('/').map(Number);
    const fps = b ? Math.round((a / b) * 10) / 10 : 0;
    const mbps = Math.round((Number(v.bit_rate || f.bit_rate || 0) / 1e6) * 10) / 10;
    const dur = Number(f.duration || 0);
    const avisos = [];
    if ((v.width || 0) * (v.height || 0) > 1920 * 1088) avisos.push('Resolución mayor a 1080p: pesa demasiado para codificar. Exporta a 1920x1080.');
    if (fps > 30.5) avisos.push(`${fps} fps: exporta a 24 o 30 fps.`);
    if (v.codec_name && v.codec_name !== 'h264') avisos.push(`Códec ${v.codec_name}: se decodifica mucho más lento que H.264. Exporta en H.264.`);
    if (mbps > 12) avisos.push(`Bitrate muy alto (${mbps} Mbps): bájalo a 4–8 Mbps.`);
    const fast = await detectarFaststart(destino);
    if (fast === false) avisos.push('El índice del MP4 está al final (sin “fast start”): tarda en arrancar y se traba por red. Exporta con “Optimizar para web / Fast Start”.');
    return { ok: true, resumen: `${v.codec_name} ${v.width}x${v.height} · ${fps} fps${mbps ? ' · ' + mbps + ' Mbps' : ''}${dur ? ' · ' + Math.round(dur) + ' s' : ''}`, avisos };
}

const DESTINOS_VIDEO = {
    magazine: 'episodio', secretosProsperidad: 'episodio', cartasTaron: 'episodio',
    publicidad: 'simple', clasificacion: 'clasif', inicioProg: 'inicio'
};

app.listen(port, () => {
    console.log(`🚀 Servidor de Canal C corriendo en el puerto ${port}`);
    motorCanalC();
});
