const { spawn } = require('child_process');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const os = require('os');

// Registro de actividad del servidor
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


// ---------------------------------------------------------------
// Monitor de recursos del servidor (actualización cada 2 segundos)
// ---------------------------------------------------------------
let muestraCpuAnterior = null;
let cpuProcesoAnterior = process.cpuUsage();
let tiempoProcesoAnterior = process.hrtime.bigint();
let recursosServidor = {
    actualizado: null,
    cpu: { usoPorcentaje: 0, nucleos: os.cpus().length, porNucleo: [] },
    memoria: { totalBytes: os.totalmem(), libreBytes: os.freemem(), usadaBytes: os.totalmem() - os.freemem(), usoPorcentaje: 0 },
    proceso: { cpuPorcentaje: 0, memoriaBytes: process.memoryUsage().rss, memoriaPorcentajeSistema: 0 },
    carga: os.loadavg()
};

function leerEstadisticasCpuLinux() {
    try {
        const lineas = fs.readFileSync('/proc/stat', 'utf8').split('\n');
        return lineas.filter(l => /^cpu\d*\s/.test(l)).map(linea => {
            const partes = linea.trim().split(/\s+/);
            const valores = partes.slice(1).map(Number);
            const idle = (valores[3] || 0) + (valores[4] || 0);
            const total = valores.reduce((a, b) => a + b, 0);
            return { id: partes[0], total, idle };
        });
    } catch (e) {
        return null;
    }
}

function calcularPorcentajeCpu(actual, anterior) {
    if (!anterior) return 0;
    const total = actual.total - anterior.total;
    const idle = actual.idle - anterior.idle;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
}

function actualizarRecursosServidor() {
    const ahoraCpu = leerEstadisticasCpuLinux();
    const cpus = os.cpus();
    let usoTotal = 0;
    let porNucleo = [];

    if (ahoraCpu && muestraCpuAnterior) {
        const anteriores = new Map(muestraCpuAnterior.map(x => [x.id, x]));
        const muestras = ahoraCpu.filter(x => x.id !== 'cpu');
        porNucleo = muestras.map((actual, i) => ({
            nucleo: i + 1,
            usoPorcentaje: Number(calcularPorcentajeCpu(actual, anteriores.get(actual.id)).toFixed(1))
        }));
        const totalActual = ahoraCpu.find(x => x.id === 'cpu');
        const totalAnterior = muestraCpuAnterior.find(x => x.id === 'cpu');
        usoTotal = Number(calcularPorcentajeCpu(totalActual, totalAnterior).toFixed(1));
    } else if (cpus.length) {
        porNucleo = cpus.map((_, i) => ({ nucleo: i + 1, usoPorcentaje: 0 }));
    }
    muestraCpuAnterior = ahoraCpu;

    const memoriaTotal = os.totalmem();
    const memoriaLibre = os.freemem();
    const memoriaUsada = memoriaTotal - memoriaLibre;
    const cpuProcesoActual = process.cpuUsage();
    const tiempoActual = process.hrtime.bigint();
    const deltaCpuMicro = (cpuProcesoActual.user - cpuProcesoAnterior.user) + (cpuProcesoActual.system - cpuProcesoAnterior.system);
    const deltaTiempoMicro = Number(tiempoActual - tiempoProcesoAnterior) / 1000;
    const cpuProceso = deltaTiempoMicro > 0 ? Math.max(0, (deltaCpuMicro / deltaTiempoMicro) * 100) : 0;
    const memoriaProceso = process.memoryUsage();

    recursosServidor = {
        actualizado: new Date().toISOString(),
        cpu: {
            usoPorcentaje: usoTotal,
            nucleos: cpus.length,
            modelo: cpus[0] ? cpus[0].model : 'No disponible',
            porNucleo
        },
        memoria: {
            totalBytes: memoriaTotal,
            libreBytes: memoriaLibre,
            usadaBytes: memoriaUsada,
            usoPorcentaje: memoriaTotal ? Number((memoriaUsada / memoriaTotal * 100).toFixed(1)) : 0
        },
        proceso: {
            cpuPorcentaje: Number(cpuProceso.toFixed(1)),
            memoriaBytes: memoriaProceso.rss,
            memoriaHeapBytes: memoriaProceso.heapUsed,
            memoriaPorcentajeSistema: memoriaTotal ? Number((memoriaProceso.rss / memoriaTotal * 100).toFixed(2)) : 0
        },
        carga: os.loadavg()
    };

    cpuProcesoAnterior = cpuProcesoActual;
    tiempoProcesoAnterior = tiempoActual;
}

// Primera muestra y refresco continuo cada 2 segundos.
actualizarRecursosServidor();
setInterval(actualizarRecursosServidor, 2000).unref();

const DATASET_REPO_ID = process.env.DATASET_REPO_ID || "cristianbracho904/programacion-tv";
const DATASET_BRANCH = process.env.DATASET_BRANCH || "main";
const HF_TOKEN = process.env.HF_TOKEN || "";
// Salida RTMP (opcional): URL completa de ingesta, con clave y tokens. Configúrala solo como variable de entorno.
const RTMP_URL = (process.env.RTMP_URL || "").trim();
// El canal sale SOLO por RTMP (ya no se crean archivos HLS). El codificador manda la señal al puerto local 9999 y de ahí la toma el proceso RTMP.
const RTMP_PUENTE_PUERTO = 9999;

const GIST_FALLBACK_URL = "https://gist.githubusercontent.com/crcistianbracho10/6e4a07d268460ea807abf28f77c3880e/raw";
const ARCHIVO_ESTADO_PERSISTENTE = '/tmp/estado_episodios.json';

const HIMNO_OFICIAL_URL = "https://files.catbox.moe/zvee4n.mp4";
// Valores necesarios para reproducir fuentes remotas y respetar la ventana del himno.
const HIMNO_VENTANA_MIN = 10;
const UA_NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const AJUSTES_DEFECTO = {
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

// Archivos de programación y listas que se descargan del dataset
const ARCHIVOS_DATASET = {
    evento:              { archivo: 'evento.txt', tipo: 'lista' },
    ajustes:             { archivo: 'ajustes.txt', tipo: 'objeto' },
    programacion:        { archivo: 'programacion.txt', tipo: 'lista' },
    vivo:                { archivo: 'vivo.txt', tipo: 'lista' },
    publicidad:          { archivo: 'publicidad.txt', tipo: 'lista' },
    intros:              { archivo: 'intros.txt', tipo: 'lista' },
    clasificacion:       { archivo: 'clasificacion.txt', tipo: 'lista' },
    inicioProg:          { archivo: 'next.txt', tipo: 'lista' }, // "A continuación": [{ "programa": "Nombre exacto", "video": "https://..." }]
    magazine:            { archivo: 'programas/magazine.txt', tipo: 'lista' },
    secretosProsperidad: { archivo: 'programas/secretos-de-prosperidad.txt', tipo: 'lista' },
    cartasTaron:         { archivo: 'programas/cartas-taron.txt', tipo: 'lista' }
};

let estadoActualTransmision = {
    tituloActual: "Iniciando señal...",
    programaActual: "Canal C",
    aContinuacion: "Cargando programación...",
    horaVenezuela: "--:--:--"
};

let indicesProgramas = {};
let ultimoHimnoReproducido = ""; // Control para evitar bucle infinito del himno
let ultimoInicioProg = "";       // Evita repetir "A continuación" dentro del mismo programa
let ultimoEventoPublicidad = ""; // Publicidad completa solo una vez antes de cada evento

const lentos = new Map();          // videos que fueron demasiado lentos: url -> momento (se saltan 1 hora)
let slotCompletado = "";          // programa cuyo horario ya no admite más episodios hasta el siguiente bloque

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

function sumarSegundosHora(horaStr, seg) {
    const t = (convertirSegundos(horaStr) + seg) % 86400;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
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


// Estadísticas del equipo y del proceso, actualizadas cada 2 segundos.
app.get('/api/recursos', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(recursosServidor);
});

// Diagnóstico público sin revelar credenciales: permite comprobar qué recibió Hugging Face.
app.get('/api/diagnostico-dataset', (req, res) => {
    res.json({
        repositorio: DATASET_REPO_ID,
        rama: DATASET_BRANCH,
        tokenConfigurado: Boolean(HF_TOKEN),
        ultimaSincronizacion: diagnosticoDataset.ultimaSincronizacion,
        sincronizacionEnCurso: sincronizacionDatasetEnCurso,
        archivos: diagnosticoDataset.archivos,
        programasEnHorario: Array.isArray(datasetConfig.programacion) ? datasetConfig.programacion.length : 0,
        listasDinamicas: Object.keys(listasProgramasPorArchivo),
        programaEnAire: estadoActualTransmision.programaActual,
        tituloEnAire: estadoActualTransmision.tituloActual
    });
});
app.get('/api/logs', (req, res) => res.json({ logs: logBuffer.slice(-100) }));

// ---------------------------------------------------------------
// Descarga y sincronización de programación desde Hugging Face
// ---------------------------------------------------------------
const listasProgramasPorArchivo = Object.create(null);
const diagnosticoDataset = { ultimaSincronizacion: null, archivos: {} };
let ultimaFirmaProgramacion = '';
let ultimoProgramaInformado = '';

async function descargarArchivoDataset(nombreArchivo) {
    const inicio = Date.now();
    try {
        const ruta = String(nombreArchivo || '').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
        const url = `https://huggingface.co/datasets/${DATASET_REPO_ID}/raw/${DATASET_BRANCH}/${ruta}?nocache=${Date.now()}`;
        const headers = {
            ...(HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {}),
            'Cache-Control': 'no-cache, no-store, max-age=0',
            'Pragma': 'no-cache'
        };
        const response = await axios.get(url, { headers, timeout: 12000, maxRedirects: 5, validateStatus: () => true });
        if (response.status < 200 || response.status >= 300) {
            diagnosticoDataset.archivos[nombreArchivo] = { ok: false, status: response.status, ms: Date.now() - inicio, error: response.status === 401 || response.status === 403 ? 'Token sin permiso, inválido o dataset privado sin acceso' : `HTTP ${response.status}` };
            console.log(`⚠️ [HF] ${nombreArchivo}: HTTP ${response.status}${response.status === 401 || response.status === 403 ? ' — revisa HF_TOKEN y permisos de lectura' : ''}`);
            return null;
        }
        const datos = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        diagnosticoDataset.archivos[nombreArchivo] = { ok: true, status: response.status, ms: Date.now() - inicio, elementos: Array.isArray(datos) ? datos.length : (datos && typeof datos === 'object' ? Object.keys(datos).length : 1) };
        return datos;
    } catch (e) {
        const status = e.response ? e.response.status : 0;
        diagnosticoDataset.archivos[nombreArchivo] = { ok: false, status, ms: Date.now() - inicio, error: e.message };
        console.log(`❌ [HF] Falló ${nombreArchivo}: ${status ? `HTTP ${status}` : e.code || e.message}${status === 401 || status === 403 ? ' — HF_TOKEN inválido o sin permiso de lectura' : ''}`);
        return null;
    }
}

function normalizarArchivoListaPrograma(valor) {
    if (typeof valor !== 'string' || !valor.trim()) return null;
    let ruta = valor.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (ruta.includes('..') || /^https?:\/\//i.test(ruta)) return null;
    if (!ruta.includes('/')) ruta = `programas/${ruta}`;
    if (!/\.[a-z0-9]+$/i.test(ruta)) ruta += '.txt';
    return ruta;
}

function aplicarConfig(clave, valor) {
    const info = ARCHIVOS_DATASET[clave];
    if (!info || valor === null || valor === undefined) return;
    if (info.tipo === 'lista') {
        if (Array.isArray(valor)) datasetConfig[clave] = valor;
    } else if (typeof valor === 'object' && !Array.isArray(valor)) {
        datasetConfig[clave] = Object.assign({}, AJUSTES_DEFECTO, valor);
    }
}





let sincronizacionDatasetEnCurso = false;

async function sincronizarDataset() {
    if (sincronizacionDatasetEnCurso) {
        console.log('ℹ️ [DATASET] Se omitió una consulta: la sincronización anterior todavía está trabajando.');
        return;
    }
    sincronizacionDatasetEnCurso = true;
    const inicioSync = Date.now();
    if (!HF_TOKEN) console.log('⚠️ [HF] HF_TOKEN no está configurado. Si el dataset es privado, Hugging Face rechazará las descargas. Usa un Access Token, no la contraseña de tu cuenta.');
    try {
        const entradas = Object.entries(ARCHIVOS_DATASET);
        const [remotos, playlistGistRemota] = await Promise.all([
            Promise.all(entradas.map(async ([clave, info]) => [clave, await descargarArchivoDataset(info.archivo)])),
            (async () => {
                try {
                    const sep = GIST_FALLBACK_URL.includes('?') ? '&' : '?';
                    const r = await axios.get(`${GIST_FALLBACK_URL}${sep}nocache=${Date.now()}`, { timeout: 12000, headers: { 'Cache-Control': 'no-cache' } });
                    return Array.isArray(r.data) ? r.data : JSON.parse(r.data);
                } catch (e) {
                    console.log(`⚠️ [GIST] No se pudo actualizar la lista: ${e.response ? `HTTP ${e.response.status}` : e.message}`);
                    return null;
                }
            })()
        ]);

        for (const [clave, remoto] of remotos) {
            if (remoto) aplicarConfig(clave, remoto);
        }

        // Descarga también cualquier lista de programa indicada en programacion.txt,
        // aunque sea un programa nuevo que no existía cuando se escribió este servidor.
        const archivosProgramas = [...new Set((datasetConfig.programacion || [])
            .map(p => normalizarArchivoListaPrograma(p && p.archivo)).filter(Boolean))];
        const dinamicos = await Promise.all(archivosProgramas.map(async ruta => [ruta, await descargarArchivoDataset(ruta)]));
        for (const [ruta, datos] of dinamicos) {
            if (Array.isArray(datos)) {
                listasProgramasPorArchivo[ruta] = datos;
            } else {
                console.log(`⚠️ [PROGRAMAS] No se pudo cargar la lista indicada por programacion.txt: ${ruta}`);
            }
        }

        if (playlistGistRemota) datasetConfig.playlistGist = playlistGistRemota;

        const disponibles = remotos.filter(([, datos]) => datos !== null).length;
        const firma = JSON.stringify(datasetConfig.programacion || []);
        if (firma !== ultimaFirmaProgramacion) {
            ultimaFirmaProgramacion = firma;
            console.log(`🗓️ [PROGRAMACIÓN] Dataset actualizado: ${(datasetConfig.programacion || []).length} espacios. Listas vinculadas: ${archivosProgramas.join(', ') || 'ninguna'}.`);
        }
        diagnosticoDataset.ultimaSincronizacion = new Date().toISOString();
        console.log(`🔄 [DATASET] Sincronización: ${disponibles}/${entradas.length} archivos base; ${dinamicos.filter(([, d]) => Array.isArray(d)).length}/${dinamicos.length} listas de programas; ${((Date.now() - inicioSync) / 1000).toFixed(1)}s.`);
    } catch (e) {
        console.log(`❌ [DATASET] Error general de sincronización: ${e.stack || e.message}`);
    } finally {
        sincronizacionDatasetEnCurso = false;
    }
}

// Primera lectura inmediata y luego actualización cada 40 segundos.
setTimeout(() => sincronizarDataset(), 1000);
setInterval(() => sincronizarDataset(), 40000);

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
        if (!conectado) console.log('⏳ [RTMP] Pasaron 40s y no llegan datos de video al RTMP: o el codificador aún no arranca (revisa los logs de arriba) o el servidor RTMP no respondió.');
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
        // Muestra lo primero que dice ffmpeg (entrada, salida, errores) para poder diagnosticar; la clave se oculta.
        if (lineasMostradas < 40 || /error|failed|refused|timed out|denied|unauthorized|Input\/output|invalid|not found|Connection/i.test(msg)) {
            lineasMostradas++;
            console.log(`[RTMP] ${ocultarClaveRtmp(msg).slice(0, 300)}`);
        }
    });
    proc.on('close', (code, signal) => {
        clearTimeout(avisoSinSenal);
        if (yaPublicando) {
            console.log('⛔ [RTMP] Opencaster dice "Already publishing": ya hay OTRA transmisión usando esta misma clave (otra copia de esta app, un despliegue anterior que sigue encendido, u otro programa/OBS). Apaga la otra o espera a que su sesión expire. Reintento en 20s.');
            reintentoRtmp = setTimeout(iniciarRTMP, 20000);
        } else {
            console.log(`⚠️ [RTMP] La salida RTMP se cerró (código ${code}, señal ${signal}). Reintentando en 5s...`);
            reintentoRtmp = setTimeout(iniciarRTMP, 5000);
        }
    });
}


function corregirUrl(url) {
    if (!url) return '';
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
    const hhmm = (h) => String(h).split(':').slice(0, 2).join(':');
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    for (const ev of (datasetConfig.evento || [])) {
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

        if (ev.repetir) {
            const duracion = finEv - inicioEv;
            const base = new Date(`${fmt(ahoraVE)}T${hhmm(ev.horaInicio)}:00`);
            const candidato = [-1, 0, 1].map(d => {
                const inicio = new Date(base.getTime() + d * 86400000);
                return { inicio, fin: new Date(inicio.getTime() + duracion) };
            }).find(x => ahoraVE <= x.fin);
            if (candidato) { inicioEv = candidato.inicio; finEv = candidato.fin; }
        }

        if (ahoraVE >= inicioEv && ahoraVE <= finEv) {
            return { tipo: 'en_curso', evento: ev, idInst: `${ev.nombre}|${fmt(inicioEv)}|${hhmm(ev.horaInicio)}` };
        }
    }
    return null;
}

// ---------------------------------------------------------------
// Helpers de programación y reproducción
// ---------------------------------------------------------------

// Devuelve TODAS las URLs de publicidad.txt (no solo la primera)
function getTodaPublicidad() {
    return (datasetConfig.publicidad || [])
        .filter(p => p && (p.video || p.url))
        .map(p => corregirUrl(p.video || p.url));
}

// Busca en next.txt el video "A continuación" del programa
// Formato: [{ "programa": "Nombre exacto del programa", "video": "https://..." }]
function getVideoInicioProg(nombrePrograma) {
    const lista = datasetConfig.inicioProg;
    if (!Array.isArray(lista)) return "";
    const buscado = (nombrePrograma || "").toLowerCase().trim();
    const item = lista.find(x => ((x.programa || x.nombre || "").toLowerCase().trim()) === buscado);
    return item ? corregirUrl(item.video || item.url) : "";
}

// Programas de hoy (según el día de Venezuela) con su estado, para el panel


// Obtiene la lista de episodios vinculada al campo "archivo" de programacion.txt.
// Admite archivos nuevos sin tener que agregarlos manualmente al código.
function obtenerListaDePrograma(prog) {
    const ruta = normalizarArchivoListaPrograma(prog && prog.archivo);
    if (ruta && Array.isArray(listasProgramasPorArchivo[ruta])) return listasProgramasPorArchivo[ruta];
    const n = String(prog && prog.archivo || '').toLowerCase();
    if (n.includes('magazine')) return datasetConfig.magazine;
    if (n.includes('secretos') || n.includes('prosperidad')) return datasetConfig.secretosProsperidad;
    if (n.includes('cartas') || n.includes('taron')) return datasetConfig.cartasTaron;
    return datasetConfig.magazine.length > 0 ? datasetConfig.magazine : datasetConfig.cartasTaron;
}

// Decide si hay que saltar el resto de la secuencia (solo ENTRE videos, nunca a mitad de uno)
function bloqueVencido(item) {
    if (!item.corteSuave) return false;
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
            const finVentana = hItem.fin || sumarSegundosHora(hItem.inicio, HIMNO_VENTANA_MIN * 60);
            if (estaEnHorario(hItem.inicio, finVentana, horaCompletaStr)) {
                if (ultimoHimnoReproducido !== idHimnoUnico) {
                    estadoActualTransmision.tituloActual = "Himno Nacional";
                    estadoActualTransmision.programaActual = "Transmisión Oficial";
                    estadoActualTransmision.aContinuacion = "Programación Regular";
                    return {
                        tipo: 'himno',
                        idUnico: idHimnoUnico,
                        // Sin corte por horario: el himno siempre se reproduce completo
                        secuencia: [{ url: corregirUrl(hItem.url), desc: "Himno Nacional" }]
                    };
                }
            }
        }
    }

    // 2. Verificación de transmisiones en vivo (vivo.txt)
    if (datasetConfig.vivo && datasetConfig.vivo.length > 0) {
        for (let vivoItem of datasetConfig.vivo) {
            if (vivoItem.dias.includes(diaSemana) && estaEnHorario(vivoItem.inicio, vivoItem.fin, horaCompletaStr)) {
                estadoActualTransmision.tituloActual = `Retransmisión: ${vivoItem.nombre}`;
                estadoActualTransmision.programaActual = vivoItem.nombre;
                estadoActualTransmision.aContinuacion = "Programación Regular";
                return {
                    tipo: 'vivo',
                    horaFinBloque: vivoItem.fin,
                    corteEstricto: true,
                    secuencia: [{ url: corregirUrl(vivoItem.url), desc: `Retransmisión en Vivo: ${vivoItem.nombre}` }]
                };
            }
        }
    }

    const estadoEv = verificarEstadoEvento();
    if (estadoEv && estadoEv.tipo === 'en_curso') {
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
                secuenciaEvento.push({ url: u, desc: `Publicidad antes del evento (${n + 1}/${anuncios.length})` });
            });
            ultimoEventoPublicidad = idEvento;
        }

        secuenciaEvento.push({ url: corregirUrl(ev.fuente), desc: `Evento: ${ev.nombre}` });

        return {
            tipo: 'evento',
            secuencia: secuenciaEvento
        };
    }

    // Si ya no hay programa en horario (o es otro distinto), se libera la marca de "programa completado"
    if (slotCompletado) {
        const aun = datasetConfig.programacion.some(p => Array.isArray(p.dias) && p.dias.includes(diaSemana) && estaEnHorario(p.inicio, p.fin, horaStr) && `${p.nombre}|${p.inicio}` === slotCompletado);
        if (!aun) slotCompletado = "";
    }

    for (let i = 0; i < datasetConfig.programacion.length; i++) {
        let prog = datasetConfig.programacion[i];
        if (Array.isArray(prog.dias) && prog.dias.includes(diaSemana) && estaEnHorario(prog.inicio, prog.fin, horaStr) && slotCompletado !== `${prog.nombre}|${prog.inicio}`) {
            let siguienteProg = datasetConfig.programacion[i + 1] ? datasetConfig.programacion[i + 1].nombre : "Transmisión Estelar / Gist";
            estadoActualTransmision.tituloActual = prog.nombre;
            estadoActualTransmision.programaActual = prog.nombre;
            estadoActualTransmision.aContinuacion = siguienteProg;

            let intro1 = datasetConfig.intros.length > 0 ? corregirUrl(datasetConfig.intros[0].video) : "";
            let intro2 = datasetConfig.intros.length > 1 ? corregirUrl(datasetConfig.intros[1].video) : intro1;
            let videoClasificacion = getVideoClasificacionPorHora(horaStr);
            const anuncios = getTodaPublicidad();

            let listaPrograma = obtenerListaDePrograma(prog);
            const idProgramaLog = `${prog.nombre}|${prog.archivo || '(sin archivo)'}|${Array.isArray(listaPrograma) ? listaPrograma.length : 0}`;
            if (ultimoProgramaInformado !== idProgramaLog) {
                ultimoProgramaInformado = idProgramaLog;
                console.log(`📺 [PROGRAMACIÓN] Seleccionado: "${prog.nombre}" | archivo: ${prog.archivo || 'NO DEFINIDO'} | episodios cargados: ${Array.isArray(listaPrograma) ? listaPrograma.length : 0}.`);
            }
            if (!Array.isArray(listaPrograma) || listaPrograma.length === 0) {
                console.log(`⚠️ [PROGRAMACIÓN] "${prog.nombre}" está en horario, pero su lista de videos está vacía. Revisa el campo archivo en programacion.txt y que ese archivo exista en el dataset.`);
            }

            let claveProg = `${prog.nombre}-${prog.inicio}`;
            if (indicesProgramas[claveProg] === undefined) {
                indicesProgramas[claveProg] = 0;
            }
            let indiceVideoActual = indicesProgramas[claveProg];

            // Agrega TODOS los anuncios a la secuencia
            const agregarPublicidad = (arr, etiqueta) => {
                anuncios.forEach((u, n) => {
                    arr.push({ url: u, desc: `${etiqueta} (${n + 1}/${anuncios.length})` });
                });
            };

            let secuenciaBloque = [];

            // 1) "A continuación: [programa]" (next.txt) — solo al comenzar el programa
            const claveInicio = `${fechaHoyStr}-${claveProg}`;
            if (ultimoInicioProg !== claveInicio) {
                const videoInicioProg = getVideoInicioProg(prog.nombre);
                if (videoInicioProg) {
                    secuenciaBloque.push({ url: videoInicioProg, desc: `A continuación: ${prog.nombre}` });
                } else {
                    console.log(`ℹ️ [A CONTINUACIÓN] "${prog.nombre}" no tiene video asignado en next.txt (formato: [{ "programa": "${prog.nombre}", "video": "https://..." }]).`);
                }
                ultimoInicioProg = claveInicio;
            }

            // 2) Intro 1 > toda la publicidad > Intro 2 > clasificación
            if (intro1) secuenciaBloque.push({ url: intro1, desc: "Intro Canal (1)" });
            agregarPublicidad(secuenciaBloque, "Espacio Publicitario");
            if (intro2) secuenciaBloque.push({ url: intro2, desc: "Intro Canal (2)" });
            if (videoClasificacion) secuenciaBloque.push({ url: videoClasificacion, desc: "Clasificación Horaria" });

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
                    desc: `${prog.nombre} (Parte 1 - ${indice1 + 1}/${total})`,
                    alTerminar: () => { indicesProgramas[claveProg] = (indice1 + 1) % total; guardarEstadoPersistente(); }
                });

                const inicioGrupo = secuenciaBloque.length; // desde aquí: intro + publicidad + Parte 2 (se evalúa si cabe en el horario)
                if (intro1) secuenciaBloque.push({ url: intro1, desc: "Intro Intermedia (1)" });
                agregarPublicidad(secuenciaBloque, "Espacio Publicitario Intermedio");
                if (intro2) secuenciaBloque.push({ url: intro2, desc: "Intro Intermedia (2)" });

                let videoObj2 = listaPrograma[indice2];
                secuenciaBloque.push({
                    url: corregirUrl(videoObj2.video || videoObj2.url),
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
                corteSuave: true, // NO corta videos a la fuerza: termina el video actual y cambia
                claveSlot: `${prog.nombre}|${prog.inicio}`,
                secuencia: secuenciaBloque
            };
        }
    }

    if (datasetConfig.playlistGist.length > 0) {
        if (indiceGistActual >= datasetConfig.playlistGist.length) indiceGistActual = 0;
        const itemGist = datasetConfig.playlistGist[indiceGistActual++];
        estadoActualTransmision.tituloActual = itemGist.title || "Canal C Playlist";
        estadoActualTransmision.programaActual = "Bloque Rotativo Gist";
        estadoActualTransmision.aContinuacion = "Programación en Espera";
        return {
            tipo: 'gist',
            claveSlot: slotCompletado || null,
            secuencia: [{ url: corregirUrl(itemGist.video || itemGist.url), desc: "Gist Respaldo" }]
        };
    }

    estadoActualTransmision.tituloActual = "En espera de programación";
    estadoActualTransmision.programaActual = "Canal C";
    estadoActualTransmision.aContinuacion = "Ninguna";
    return { tipo: 'espera', secuencia: [] };
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
        if (Array.isArray(prog.dias) && prog.dias.includes(diaSemana) && estaEnHorario(prog.inicio, prog.fin, horaStr)) {
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



async function emitirEspera() {
    return new Promise((resolve) => {
        const args = [
            '-re', '-f', 'lavfi', '-i', 'color=c=black:s=1024x576:r=24',
            '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
            '-t', '5',
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p', '-r', '24', '-g', '36',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
            '-f', 'mpegts', `udp://127.0.0.1:${RTMP_PUENTE_PUERTO}?pkt_size=1316`
        ];
        const proc = spawn('ffmpeg', args);
        proc.on('error', (err) => {
            console.log(`⚠️ [ESPERA] No se pudo generar la señal negra de espera: ${err.message}`);
            resolve();
        });
        proc.on('close', () => resolve());
    });
}

async function motorCanalC() {
    if (RTMP_URL) iniciarRTMP();
    else console.log('⚠️ [RTMP] Falta la variable de entorno RTMP_URL: el canal no tiene ninguna salida. Defínela y reinicia.');

    await sincronizarDataset();

    while (true) {
        const itemActual = obtenerElementoActualEnEmision();
        if (itemActual.tipo === 'himno' && itemActual.idUnico) {
            ultimoHimnoReproducido = itemActual.idUnico;
        }

        if (itemActual.tipo === 'espera') {
            await emitirEspera();
            continue;
        }

        const listaElementos = itemActual.secuencia || [];
        const horaFinBloqueStr = itemActual.horaFinBloque || null;

        for (let i = 0; i < listaElementos.length; i++) {
            const video = listaElementos[i];
            if (!video.url) continue;

            if (i > 0 && bloqueVencido(itemActual)) {
                console.log('⏭️ [HORARIO] El bloque terminó. Se omite el resto de la secuencia.');
                break;
            }

            if (itemActual.tipo === 'programa_secuencia') {
                if (video.alTerminar && !video.grupo && !video.sondeado) {
                    video.sondeado = true;
                    (async () => {
                        for (const x of listaElementos.filter(y => y.grupo)) await obtenerDuracion(x.url);
                    })();
                }
                if (video.inicioGrupo) {
                    const grupo = listaElementos.filter(x => x.grupo === video.grupo);
                    if (!(await grupoCabeEnHorario(grupo, itemActual))) {
                        console.log(`⏱️ [HORARIO] La Parte 2 no cabe antes de las ${itemActual.horaFinBloque}. Se omite para respetar el siguiente programa.`);
                        slotCompletado = itemActual.claveSlot;
                        break;
                    }
                }
            }

            if (!video.alTerminar && (itemActual.tipo === 'programa_secuencia' || itemActual.tipo === 'gist')) {
                const tLento = lentos.get(corregirUrl(video.url));
                if (tLento && Date.now() - tLento < 3600000) {
                    console.log(`⏭️ [SEÑAL] Se omite "${video.desc}" porque fue demasiado lento; se reintentará más tarde.`);
                    continue;
                }
            }

            const urlFinal = corregirUrl(video.url);
            console.log(`\n📺 AIRE: ${video.desc}`);
            console.log('⚙️ [SALIDA] Video directo (copy) y audio AAC normalizado a 48 kHz estéreo. Sin logo, banners, cintillo ni filtros gráficos.');

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
                '-thread_queue_size', '512',
                '-re',
                '-i', urlFinal,
                '-map', '0:v:0?',
                '-map', '0:a:0?',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '48000',
                '-ac', '2',
                '-af', 'aresample=async=1:first_pts=0',
                '-max_muxing_queue_size', '1024',
                '-muxdelay', '0',
                '-flush_packets', '1',
                '-f', 'mpegts', `udp://127.0.0.1:${RTMP_PUENTE_PUERTO}?pkt_size=1316`
            ];

            await new Promise((resolve) => {
                const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
                let ultimoFrame = Date.now();
                const inicioProcTs = Date.now();
                let lentoDesde = 0;
                let omitidoPorLento = false;
                const puedeOmitirPorLento = !video.alTerminar && (itemActual.tipo === 'programa_secuencia' || itemActual.tipo === 'gist');
                let duracionActual = 0;
                let tiempoActual = 0;
                let cortePorHorario = false;

                const verificadorHoraFin = setInterval(() => {
                    if (itemActual.tipo === 'evento') {
                        const e = verificarEstadoEvento();
                        if (!(e && e.tipo === 'en_curso')) {
                            console.log('⏰ [EVENTO] El evento terminó. Cortando transmisión.');
                            ffmpegProc.kill('SIGKILL');
                        }
                    } else if (horaFinBloqueStr && itemActual.corteEstricto) {
                        const { horaStr, horaCompletaStr } = obtenerTiempoVenezuela();
                        if (horaCompletaStr >= horaFinBloqueStr || horaStr >= horaFinBloqueStr) {
                            console.log(`⏰ [HORARIO] Límite alcanzado (${horaFinBloqueStr}). Cortando transmisión actual.`);
                            ffmpegProc.kill('SIGKILL');
                        }
                    } else if ((itemActual.tipo === 'programa_secuencia' || itemActual.tipo === 'gist') && ajusteHorarioActivo()) {
                        const ahoraProg = programaProgramadoAhora();
                        if (ahoraProg && ahoraProg.clave !== itemActual.claveSlot) {
                            const tolerancia = numAjuste((datasetConfig.ajustes || AJUSTES_DEFECTO).toleranciaMinutos, 3) * 60;
                            const restante = duracionActual > 0 ? duracionActual - tiempoActual : Infinity;
                            if (restante > tolerancia) {
                                console.log(`⏰ [HORARIO] Ya toca "${ahoraProg.prog.nombre}". Se corta el video para respetar la parrilla.`);
                                cortePorHorario = true;
                                ffmpegProc.kill('SIGKILL');
                            }
                        }
                    }
                }, 5000);

                const ultimasLineasFfmpeg = [];
                ffmpegProc.stderr.on('data', (data) => {
                    const msg = data.toString().trim();
                    if (!msg.includes('frame=')) {
                        for (const ln of msg.split('\n')) {
                            if (ln.trim()) {
                                ultimasLineasFfmpeg.push(ln.trim().slice(0, 220));
                                if (ultimasLineasFfmpeg.length > 8) ultimasLineasFfmpeg.shift();
                            }
                        }
                    }
                    if (msg.includes('frame=')) {
                        ultimoFrame = Date.now();
                        const sp = msg.match(/speed=\s*([\d.]+)x/g);
                        if (sp) {
                            const velocidad = parseFloat(sp[sp.length - 1].replace(/[^\d.]/g, ''));
                            if (velocidad < 0.5 && Date.now() - inicioProcTs > 10000) {
                                if (!lentoDesde) lentoDesde = Date.now();
                                else if (Date.now() - lentoDesde > 15000 && puedeOmitirPorLento && !omitidoPorLento) {
                                    omitidoPorLento = true;
                                    lentos.set(urlFinal, Date.now());
                                    console.log(`⛔ [SEÑAL] "${video.desc}" va demasiado lento; se omite durante una hora.`);
                                    try { ffmpegProc.kill('SIGKILL'); } catch (e) {}
                                }
                            } else if (velocidad >= 0.5) {
                                lentoDesde = 0;
                            }
                        }
                    }
                    if (!duracionActual) {
                        const d = msg.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
                        if (d) duracionActual = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
                    }
                    const tiempos = msg.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
                    if (tiempos) {
                        const u = tiempos[tiempos.length - 1].match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
                        tiempoActual = Number(u[1]) * 3600 + Number(u[2]) * 60 + Number(u[3]);
                    }
                });

                const watchdogCongelamiento = setInterval(() => {
                    if (Date.now() - ultimoFrame > 15000) {
                        console.log(`⚠️ [WATCHDOG] El video "${video.desc}" no entrega cuadros. Reiniciando proceso.`);
                        ffmpegProc.kill('SIGKILL');
                    }
                }, 5000);

                ffmpegProc.on('error', (err) => {
                    console.log(`❌ [FFMPEG] No se pudo iniciar FFmpeg: ${err.message}`);
                    clearInterval(verificadorHoraFin);
                    clearInterval(watchdogCongelamiento);
                    resolve();
                });
                ffmpegProc.on('close', (code) => {
                    console.log(`ℹ️ [CIERRE] Finalizó el archivo: ${video.desc} (Código: ${code})`);
                    if (code !== 0 && code !== null) {
                        console.log(`❌ [FFMPEG] Error al emitir "${video.desc}". Últimas líneas de ffmpeg:\n   ` + ultimasLineasFfmpeg.join('\n   '));
                    }
                    clearInterval(verificadorHoraFin);
                    clearInterval(watchdogCongelamiento);
                    if (!cortePorHorario && typeof video.alTerminar === 'function') video.alTerminar();
                    resolve();
                });
            });

            if (itemActual.tipo === 'programa_secuencia') {
                const programadoAhora = programaProgramadoAhora();
                if (programadoAhora && programadoAhora.clave !== itemActual.claveSlot) {
                    console.log(`🔁 [PROGRAMACIÓN] Cambio detectado al terminar el video. Entra "${programadoAhora.prog.nombre}".`);
                    break;
                }
            }
        }

        // Pausa breve entre archivos; si no hay programación, emitirEspera mantiene el RTMP activo.
        await new Promise(resolve => setTimeout(resolve, 500));
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

app.listen(port, () => {
    console.log(`🚀 Servidor de Canal C corriendo en el puerto ${port}`);
    motorCanalC();
}); 
