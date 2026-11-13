const { spawn } = require('child_process');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const os = require('os');

const app = express();
const port = process.env.PORT || 8080;

const DATASET_REPO_ID = process.env.DATASET_REPO_ID || "cristianbracho904/programacion-tv";
const DATASET_BRANCH = process.env.DATASET_BRANCH || "main";
const HF_TOKEN = process.env.HF_TOKEN || "";
const RTMP_URL = (process.env.RTMP_URL || "").trim();
const RTMP_PUENTE_PUERTO = 9999;

const FALLBACK_IMAGE = "https://www.dropbox.com/scl/fi/x9xpsosc6mlmn5rw8e2at/Copilot_20260224_002036.png?rlkey=340kgc42pa64ytajhzv0vl53b&st=qr7ly3ru&dl=1";
const ARCHIVO_ESTADO_PERSISTENTE = '/tmp/estado_episodios.json';
const HILOS = process.env.FFMPEG_THREADS || String(Math.max(1, Math.round(os.cpus().length / 2)));
const UA_NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

app.use(express.json({ limit: '5mb' }));

let datasetConfig = {
    programacion: [],
    magazine: [],
    ajustes: { modoCodificacion: "ultraligero" }
};

let estadoActualTransmision = {
    tituloActual: "Iniciando señal ligera...",
    programaActual: "Canal C",
    horaVenezuela: "--:--:--"
};

let indicesProgramas = {};
let procesoActual = null;
let itemEnAire = null;

function obtenerTiempoVenezuela() {
    const options = { timeZone: 'America/Caracas', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };
    const formatter = new Intl.DateTimeFormat('en-GB', options);
    return formatter.format(new Date());
}

app.get('/', (req, res) => {
    res.send('Canal C en modo optimizado de bajo consumo de CPU.');
});

app.get('/api/estado', (req, res) => {
    res.json(estadoActualTransmision);
});

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

// Iniciar RTMP puente sin recodificar si hay salida configurada
let procesoRtmp = null;
function iniciarRTMP() {
    if (!RTMP_URL) return;
    if (procesoRtmp) { try { procesoRtmp.kill('SIGKILL'); } catch (e) {} }
    
    procesoRtmp = spawn('ffmpeg', [
        '-fflags', '+nobuffer+genpts',
        '-i', `udp://127.0.0.1:${RTMP_PUENTE_PUERTO}?buffer_size=4000000&overrun_nonfatal=1`,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-f', 'flv',
        RTMP_URL
    ]);

    procesoRtmp.on('close', () => {
        setTimeout(iniciarRTMP, 5000);
    });
}

// Obtener siguiente elemento de reproducción de manera segura
function obtenerSiguienteVideo() {
    if (datasetConfig.magazine.length > 0) {
        let clave = "magazine_global";
        if (indicesProgramas[clave] === undefined) indicesProgramas[clave] = 0;
        let idx = indicesProgramas[clave];
        if (idx >= datasetConfig.magazine.length) idx = 0;
        
        let item = datasetConfig.magazine[idx];
        indicesProgramas[clave] = (idx + 1) % datasetConfig.magazine.length;
        
        return {
            url: corregirUrl(item.video || item.url),
            desc: item.titulo || "Episodio de Magazine"
        };
    }
    return {
        url: FALLBACK_IMAGE,
        desc: "Imagen de respaldo"
    };
}

async function motorTransmisionLigero() {
    if (RTMP_URL) iniciarRTMP();

    while (true) {
        let videoActual = obtenerSiguienteVideo();
        estadoActualTransmision.tituloActual = videoActual.desc;
        estadoActualTransmision.horaVenezuela = obtenerTiempoVenezuela();

        console.log(`\n📺 TRANSMITIENDO (MODO LIGERO): ${videoActual.desc}`);

        // COMANDOS DE FFMPEG OPTIMIZADOS PARA BAJO USO DE CPU Y CERO DESINCRONIZACIÓN
        let ffmpegArgs = [
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '2',
            '-fflags', '+genpts+ignidx+discardcorrupt',
            '-thread_queue_size', '512',
            ...(HILOS ? ['-threads', HILOS] : []),
            '-re',
            '-i', videoActual.url,
            // Filtro de reescalado simple y rápido + corrección estricta de audio para evitar desfases
            '-vf', 'scale=1280:720:flags=fast_bilinear,format=yuv420p',
            '-af', 'aresample=async=1:min_hard_comp=0.100:first_pts=0',
            // Codificación ultrarrápida para evitar saturar la CPU al 100%
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-b:v', '800k',
            '-maxrate', '1000k',
            '-bufsize', '1500k',
            '-g', '48',
            // Configuración de audio ligera y estable
            '-c:a', 'aac',
            '-b:a', '96k',
            '-ac', '2',
            '-f', 'mpegts',
            `udp://127.0.0.1:${RTMP_PUENTE_PUERTO}?pkt_size=1316`
        ];

        await new Promise((resolve) => {
            const proc = spawn('ffmpeg', ffmpegArgs);
            procesoActual = proc;

            let ultimoFrame = Date.now();
            const watchdog = setInterval(() => {
                if (Date.now() - ultimoFrame > 15000) {
                    console.log("⚠️ [WATCHDOG] El flujo se detuvo o congeló. Reiniciando proceso FFmpeg...");
                    try { proc.kill('SIGKILL'); } catch (e) {}
                }
            }, 5000);

            proc.stderr.on('data', (data) => {
                if (data.toString().includes("frame=")) {
                    ultimoFrame = Date.now();
                }
            });

            proc.on('close', (code) => {
                clearInterval(watchdog);
                if (procesoActual === proc) procesoActual = null;
                console.log(`ℹ️ Fin del archivo actual (Código: ${code})`);
                resolve();
            });
        });

        // Breve pausa entre transmisiones
        await new Promise(r => setTimeout(r, 1000));
    }
}

// Proxy interno seguro para Hugging Face datasets privados
app.use('/_hf', async (req, res) => {
    const ip = (req.socket && req.socket.remoteAddress) || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).end();
    let ruta = '';
    try { ruta = decodeURIComponent((req.path || '').replace(/^\/+/, '')); } catch (e) { return res.status(400).end(); }
    if (!ruta || ruta.split('/').includes('..')) return res.status(400).end();
    
    const url = `https://huggingface.co/datasets/${DATASET_REPO_ID}/resolve/${DATASET_BRANCH}/${ruta}`;
    try {
        const headers = HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {};
        const r = await axios.get(url, { headers, responseType: 'stream', validateStatus: () => true });
        res.status(r.status);
        r.data.pipe(res);
    } catch (e) {
        res.status(502).end();
    }
});

app.listen(port, () => {
    console.log(`🚀 Servidor ligero de Canal C activo en el puerto ${port}`);
    motorTransmisionLigero();
});
 
