#!/usr/bin/env python3
"""Prepara un video para la Sala y lo sube a Cloudflare R2.

Uso normal, antes del stream:

    python herramientas/subir.py "S01E03.mkv"

Corta el archivo en HLS (720p y 1080p, segmentos de 6 segundos), saca los
subtitulos a WebVTT si el archivo trae alguna pista de texto, sube todo a R2
bajo `<prefijo>/<id>/` y le avisa al servidor que el video existe.

Otros usos:

    python herramientas/subir.py --listar
    python herramientas/subir.py --borrar s01e03

Las credenciales salen de herramientas/.env (ver .env.ejemplo). Nunca se
imprimen: el dueno trabaja con la pantalla al aire.
"""

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# --------------------------------------------------------------------------
# Constantes
# --------------------------------------------------------------------------

# Seis segundos por segmento es una decision de costo, no de estetica: 300
# personas mirando 2 horas con segmentos de 6 s son 360.000 lecturas de las
# 10 millones gratis por mes de R2. Con segmentos de 2 s serian 1.080.000 y
# entrarian 9 noches en vez de 25. Si alguna vez se cambia, anotarlo en
# BITACORA.md con la cuenta nueva.
SEGMENTO_SEGUNDOS = 6

# (altura, bitrate de video, maxrate, bufsize). El audio va aparte, 128k.
# Los numeros no son decorativos: son el presupuesto del bucket de 10 GB. Una
# peli de 2 h a 5000k pesa 4,5 GB; a 8000k, 7,2 GB, y entran dos en vez de
# tres. Si alguna vez cambian, rehacer la cuenta en BITACORA.md.
CALIDADES = (
    (720, "2500k", "2675k", "3750k"),
    (1080, "5000k", "5350k", "7500k"),
)

# Debajo de esto la imagen se cae a pedazos y ahorrar deja de tener sentido.
TASA_MINIMA_KBPS = 400

# Los segmentos MPEG-TS no arrancan en cero: el muxer de ffmpeg les pone un
# colchon de aproximadamente 1,4 s para no emitir DTS negativos (medido:
# 1,445 / 1,459 / 1,480 / 1,512 segun el archivo). El WebVTT que sacamos
# aparte esta en tiempos de 0, asi que hay que atarlo a ese reloj con un
# X-TIMESTAMP-MAP o los subtitulos salen adelantados esa misma cantidad.
RELOJ_MPEGTS = 90000

PREFIJO_POR_DEFECTO = "istincho"
BUCKET_POR_DEFECTO = "sala-video"

# Subtitulos que son texto y se pueden pasar a WebVTT. Los de imagen
# (hdmv_pgs_subtitle, dvd_subtitle, dvb_subtitle, xsub) necesitarian OCR:
# se saltean con aviso en vez de romper la corrida.
CODECS_SUBTITULO_TEXTO = frozenset(
    {"subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text", "subviewer"}
)

TIPOS_DE_CONTENIDO = {
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts": "video/mp2t",
    ".m4s": "video/iso.segment",
    ".mp4": "video/mp4",
    ".vtt": "text/vtt",
}

# Todo lo que se sube vive bajo un id nuevo, asi que ningun objeto cambia
# nunca de contenido: se puede cachear para siempre.
CACHE_LARGO = "public, max-age=31536000, immutable"

IDIOMAS = {
    "spa": "Espanol", "es": "Espanol",
    "eng": "Ingles", "en": "Ingles",
    "por": "Portugues", "pt": "Portugues",
    "fra": "Frances", "fre": "Frances", "fr": "Frances",
    "ita": "Italiano", "it": "Italiano",
    "deu": "Aleman", "ger": "Aleman", "de": "Aleman",
    "jpn": "Japones", "ja": "Japones",
    "und": "Sin identificar",
}

VARIABLES_R2 = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
VARIABLES_SERVIDOR = ("URL_SERVIDOR", "CLAVE_SUBIDA")


class Aviso(Exception):
    """Error esperable: se muestra como una linea, sin stack trace."""


# --------------------------------------------------------------------------
# Configuracion
# --------------------------------------------------------------------------

def leer_env(ruta):
    """Lee un archivo tipo .env a un diccionario. No imprime ningun valor."""
    valores = {}
    if not Path(ruta).is_file():
        return valores
    with open(ruta, "r", encoding="utf-8") as archivo:
        for linea in archivo:
            linea = linea.strip()
            if not linea or linea.startswith("#"):
                continue
            if linea.startswith("export "):
                linea = linea[len("export "):].strip()
            if "=" not in linea:
                continue
            nombre, _, valor = linea.partition("=")
            nombre = nombre.strip()
            valor = valor.strip()
            if len(valor) >= 2 and valor[0] == valor[-1] and valor[0] in ("'", '"'):
                valor = valor[1:-1]
            if nombre:
                valores[nombre] = valor
    return valores


def configuracion(ruta_env, entorno=None):
    """Junta las variables de entorno con el .env. El .env manda."""
    entorno = os.environ if entorno is None else entorno
    conocidas = (
        "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET", "R2_URL_PUBLICA", "URL_SERVIDOR", "CLAVE_SUBIDA", "SALA_SLUG",
    )
    valores = {n: entorno[n] for n in conocidas if entorno.get(n)}
    valores.update({k: v for k, v in leer_env(ruta_env).items() if v})
    valores.setdefault("R2_BUCKET", BUCKET_POR_DEFECTO)
    valores.setdefault("SALA_SLUG", PREFIJO_POR_DEFECTO)
    return valores


def exigir(config, nombres, para):
    faltan = [n for n in nombres if not config.get(n)]
    if faltan:
        raise Aviso(
            "Faltan variables en herramientas/.env para " + para + ": "
            + ", ".join(faltan)
            + "\nCopia herramientas/.env.ejemplo a herramientas/.env y completalo."
        )


# --------------------------------------------------------------------------
# Utilidades puras
# --------------------------------------------------------------------------

def hacer_id(nombre):
    """Convierte el nombre de un archivo en un id corto y seguro para una URL."""
    base = Path(str(nombre)).stem
    base = unicodedata.normalize("NFKD", base)
    base = "".join(c for c in base if not unicodedata.combining(c))
    base = base.lower()
    base = re.sub(r"[^a-z0-9]+", "-", base)
    base = re.sub(r"-{2,}", "-", base).strip("-")
    return base[:60]


def sanear_etiqueta(texto, por_defecto="und"):
    """Deja un tag de idioma seguro para una carpeta y para una URI.

    El `language` de un mkv es texto libre: `es MX (Latino)` es un valor
    real. Sin esto, la clave de R2 sale `subtitulos/es mx (latino)/` y la
    maestra queda con `URI="subtitulos/es mx (latino)/lista.m3u8"`: espacios
    y parentesis sin percent-encoding en una URI de playlist son un 404 mudo
    que no dice por que. El id lo valida `validar_id`; el idioma no tenia
    ninguna guarda.
    """
    base = unicodedata.normalize("NFKD", str(texto or ""))
    base = "".join(c for c in base if not unicodedata.combining(c)).lower()
    base = re.sub(r"[^a-z0-9]+", "-", base)
    base = re.sub(r"-{2,}", "-", base).strip("-")
    return base[:30] or por_defecto


def validar_id(identificador):
    """Un id malo borraria o pisaria objetos de otro video. Se valida siempre."""
    if not identificador or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,59}", str(identificador)):
        raise Aviso(
            "Id invalido: " + repr(identificador)
            + ". Solo minusculas, numeros y guiones, hasta 60 caracteres, "
            "empezando por letra o numero."
        )
    return identificador


def validar_slug(slug):
    """El slug es el prefijo dentro del bucket, o sea entrada sin validar en
    el camino destructivo: `--borrar s01e03 --sala "../otro"` opera bajo
    `../otro/s01e03/`. Mismo formato que `slugValido` en servidor/videos.js,
    para que no exista un slug que uno acepte y el otro no."""
    if not slug or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,49}", str(slug)):
        raise Aviso(
            "Sala invalida: " + repr(slug)
            + ". Solo minusculas, numeros, guiones y guiones bajos, hasta 50 "
            "caracteres, empezando por letra o numero."
        )
    return str(slug)


def kbps(texto):
    """De `2500k` saca 2500."""
    return int(re.sub(r"[^0-9]", "", str(texto)) or 0)


def escalar_calidad(base, altura):
    """Baja el bitrate de un escalon para una fuente mas chica.

    Los bits van con los pixeles y los pixeles van con el cuadrado de la
    altura: un 480p tiene (480/720)^2 = 0,44 de los pixeles de un 720p. Sin
    esta cuenta, una fuente de 480p hereda los 2500 kbps del escalon de 720p
    y gasta mas del doble de lo que necesita en un bucket de 10 GB. Es la
    misma idea que "nunca agrandar", aplicada al bitrate en vez de al tamano.
    """
    altura_base, bitrate, maxrate, bufsize = base
    factor = (float(altura) / float(altura_base)) ** 2
    tasa = max(TASA_MINIMA_KBPS, int(round(kbps(bitrate) * factor / 100.0)) * 100)
    return (
        altura,
        "%dk" % tasa,
        "%dk" % int(round(tasa * kbps(maxrate) / float(kbps(bitrate)))),
        "%dk" % int(round(tasa * kbps(bufsize) / float(kbps(bitrate)))),
    )


def calidades_aplicables(altura_fuente, calidades=CALIDADES):
    """Nunca agrandar: un 1080p inventado a partir de un 720p ocupa el doble
    en un bucket de 10 GB y no se ve mejor."""
    aplicables = [c for c in calidades if c[0] <= altura_fuente]
    if aplicables:
        return aplicables
    return [escalar_calidad(calidades[0], max(2, (int(altura_fuente) // 2) * 2))]


def tipo_de_contenido(nombre):
    """Sin esto R2 devuelve application/octet-stream y hls.js no reproduce."""
    return TIPOS_DE_CONTENIDO.get(Path(str(nombre)).suffix.lower(), "application/octet-stream")


def clave_r2(prefijo, identificador, ruta_relativa):
    """Las claves de R2 llevan barras normales siempre, tambien en Windows."""
    partes = [p for p in re.split(r"[\\/]+", str(ruta_relativa)) if p not in ("", ".")]
    return "/".join([str(prefijo).strip("/"), str(identificador)] + partes)


def unir_url(base, clave):
    return str(base).rstrip("/") + "/" + str(clave).lstrip("/")


def nombre_de_idioma(codigo, titulo=None):
    if titulo:
        return titulo
    codigo = (codigo or "und").lower()
    if codigo in IDIOMAS:
        return IDIOMAS[codigo]
    # `es-mx-latino` sigue siendo espanol: se prueba con la raiz antes de
    # rendirse y mostrar el codigo crudo.
    return IDIOMAS.get(codigo.split("-", 1)[0], codigo.upper())


def formatear_bytes(cantidad):
    valor = float(cantidad)
    for unidad in ("B", "KB", "MB", "GB"):
        if valor < 1024:
            return ("%d %s" % (valor, unidad)) if unidad == "B" else ("%.1f %s" % (valor, unidad))
        valor /= 1024
    return "%.1f TB" % valor


def formatear_tiempo(segundos):
    if segundos is None or segundos != segundos or segundos == float("inf"):
        return "--:--"
    segundos = max(0, int(segundos))
    horas, resto = divmod(segundos, 3600)
    minutos, segs = divmod(resto, 60)
    if horas:
        return "%d:%02d:%02d" % (horas, minutos, segs)
    return "%02d:%02d" % (minutos, segs)


# --------------------------------------------------------------------------
# Progreso legible
# --------------------------------------------------------------------------

class Barra:
    """Una linea que se reescribe sola. Una subida de 2 GB tarda y el dueno
    va a estar mirando."""

    def __init__(self, etiqueta, total, salida=None, es_terminal=None):
        self.etiqueta = etiqueta
        self.total = max(1, float(total or 1))
        self.hecho = 0.0
        self.salida = salida or sys.stdout
        self.arranco = time.monotonic()
        self.ultimo_dibujo = 0.0
        self.candado = threading.Lock()
        if es_terminal is None:
            es_terminal = bool(getattr(self.salida, "isatty", lambda: False)())
        self.es_terminal = es_terminal

    def avanzar(self, cantidad):
        with self.candado:
            self.hecho += cantidad
            self._dibujar(False)

    def poner(self, valor):
        with self.candado:
            self.hecho = float(valor)
            self._dibujar(False)

    def terminar(self, mensaje=None):
        with self.candado:
            self.hecho = self.total
            self._dibujar(True)
            if mensaje:
                self.salida.write("   " + mensaje + "\n")
            self.salida.flush()

    def _dibujar(self, forzar):
        ahora = time.monotonic()
        if not forzar and ahora - self.ultimo_dibujo < 0.4:
            return
        self.ultimo_dibujo = ahora
        proporcion = min(1.0, self.hecho / self.total)
        transcurrido = max(0.001, ahora - self.arranco)
        resto = (transcurrido / proporcion - transcurrido) if proporcion > 0 else None
        lleno = int(proporcion * 24)
        linea = "  %-11s [%s%s] %3d%%  faltan %s" % (
            self.etiqueta,
            "#" * lleno,
            "." * (24 - lleno),
            int(proporcion * 100),
            formatear_tiempo(resto),
        )
        if self.es_terminal:
            self.salida.write("\r" + linea + "   ")
            if forzar:
                self.salida.write("\n")
        elif forzar:
            self.salida.write(linea + "\n")
        self.salida.flush()


def paso(numero, total, texto):
    print("\n[%d/%d] %s" % (numero, total, texto))
    sys.stdout.flush()


# --------------------------------------------------------------------------
# ffmpeg y ffprobe
# --------------------------------------------------------------------------

def comprobar_programas(programas=("ffmpeg", "ffprobe")):
    faltan = [p for p in programas if shutil.which(p) is None]
    if faltan:
        raise Aviso(
            "No encuentro " + " ni ".join(faltan) + " en el PATH.\n"
            "Instalalos con:  winget install Gyan.FFmpeg\n"
            "Despues cerra y abri la terminal y probá con:  ffmpeg -version"
        )


def analizar_ffprobe(datos):
    """Del JSON de ffprobe saca lo poco que hace falta para armar el comando."""
    formato = datos.get("format") or {}
    flujos = datos.get("streams") or []
    try:
        duracion = float(formato.get("duration"))
    except (TypeError, ValueError):
        duracion = 0.0

    videos = [f for f in flujos if f.get("codec_type") == "video"
              and f.get("disposition", {}).get("attached_pic", 0) != 1]
    if not videos:
        raise Aviso("El archivo no tiene ninguna pista de video.")
    altura = max(int(f.get("height") or 0) for f in videos)
    if altura <= 0:
        raise Aviso("No pude leer la altura del video con ffprobe.")

    audios = [f for f in flujos if f.get("codec_type") == "audio"]
    indice_audio = None
    for numero, flujo in enumerate(audios):
        if flujo.get("disposition", {}).get("default", 0) == 1:
            indice_audio = numero
            break
    if indice_audio is None and audios:
        indice_audio = 0

    subtitulos = []
    salteados = []
    for numero, flujo in enumerate(f for f in flujos if f.get("codec_type") == "subtitle"):
        tags = flujo.get("tags") or {}
        codec = (flujo.get("codec_name") or "").lower()
        pista = {
            "indice": numero,
            "codec": codec,
            "idioma": sanear_etiqueta(tags.get("language")),
            "titulo": tags.get("title") or None,
            "predeterminado": (flujo.get("disposition") or {}).get("default", 0) == 1,
        }
        if codec in CODECS_SUBTITULO_TEXTO:
            subtitulos.append(pista)
        else:
            salteados.append(pista)

    return {
        "duracion": duracion,
        "altura": altura,
        "indice_audio": indice_audio,
        "subtitulos": subtitulos,
        "subtitulos_salteados": salteados,
    }


def probar_fuente(entrada, correr=None):
    correr = correr or subprocess.run
    resultado = correr(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(entrada)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if resultado.returncode != 0:
        raise Aviso("ffprobe no pudo leer el archivo:\n" + (resultado.stderr or "").strip())
    try:
        return analizar_ffprobe(json.loads(resultado.stdout))
    except json.JSONDecodeError:
        raise Aviso("ffprobe devolvio algo que no es JSON.")


def nombre_de_calidad(altura):
    return "%dp" % altura


def construir_comando_ffmpeg(entrada, destino, calidades, indice_audio,
                             segundo_de_segmento=SEGMENTO_SEGUNDOS):
    """Un solo ffmpeg produce todas las calidades y la playlist maestra."""
    destino = Path(destino)
    cantidad = len(calidades)

    if cantidad == 1:
        filtro = "[0:v]scale=-2:%d[v0]" % calidades[0][0]
    else:
        etiquetas = "".join("[e%d]" % i for i in range(cantidad))
        partes = ["[0:v]split=%d%s" % (cantidad, etiquetas)]
        for i, (altura, _, _, _) in enumerate(calidades):
            partes.append("[e%d]scale=-2:%d[v%d]" % (i, altura, i))
        filtro = ";".join(partes)

    comando = [
        "ffmpeg", "-hide_banner", "-nostdin", "-y",
        "-i", str(entrada),
        "-filter_complex", filtro,
    ]

    mapa = []
    for i, _ in enumerate(calidades):
        comando += ["-map", "[v%d]" % i]
        if indice_audio is None:
            mapa.append("v:%d,name:%s" % (i, nombre_de_calidad(calidades[i][0])))
        else:
            comando += ["-map", "0:a:%d" % indice_audio]
            mapa.append("v:%d,a:%d,name:%s" % (i, i, nombre_de_calidad(calidades[i][0])))

    for i, (_, bitrate, maxrate, bufsize) in enumerate(calidades):
        comando += [
            "-c:v:%d" % i, "libx264",
            "-b:v:%d" % i, bitrate,
            "-maxrate:v:%d" % i, maxrate,
            "-bufsize:v:%d" % i, bufsize,
            "-profile:v:%d" % i, "main",
        ]

    comando += ["-preset", "veryfast", "-pix_fmt", "yuv420p", "-sc_threshold", "0"]
    # Sin un keyframe justo en cada corte, ffmpeg estira los segmentos y el
    # reloj de la sala deja de poder saltar a un segundo exacto.
    comando += ["-force_key_frames", "expr:gte(t,n_forced*%d)" % segundo_de_segmento]

    if indice_audio is not None:
        comando += ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"]

    comando += [
        "-f", "hls",
        "-hls_time", str(segundo_de_segmento),
        "-hls_playlist_type", "vod",
        "-hls_list_size", "0",
        "-hls_flags", "independent_segments",
        "-hls_segment_type", "mpegts",
        "-hls_segment_filename", str(destino / "%v" / "seg%05d.ts"),
        "-master_pl_name", "maestra.m3u8",
        "-var_stream_map", " ".join(mapa),
        "-progress", "pipe:1", "-nostats", "-loglevel", "error",
        str(destino / "%v" / "lista.m3u8"),
    ]
    return comando


SEGUNDOS_DE_PROGRESO = re.compile(r"^out_time=(\d+):(\d\d):(\d\d(?:\.\d+)?)$")


def segundos_de_linea_de_progreso(linea):
    """De `out_time=00:01:23.45` saca 83.45. Devuelve None si no es esa linea."""
    encontrado = SEGUNDOS_DE_PROGRESO.match(str(linea).strip())
    if not encontrado:
        return None
    horas, minutos, segundos = encontrado.groups()
    return int(horas) * 3600 + int(minutos) * 60 + float(segundos)


def correr_ffmpeg_con_progreso(comando, duracion, etiqueta="convirtiendo", salida=None):
    """Corre ffmpeg leyendo el progreso por stdout, con stderr a un archivo.

    stderr NO puede ser un pipe mas. Con los dos en pipe y un solo lector se
    arma un abrazo mortal: ffmpeg llena el buffer del pipe de stderr (4 KB
    medidos en Windows; con 8 KB ya cuelga), se bloquea escribiendo, deja de
    emitir `-progress` por stdout, y el padre se queda esperando stdout para
    siempre, sin timeout y con la barra congelada. No hace falta un caso
    raro: un rip de 2 h con ruido de decodificacion pasa los 8 KB con unas
    cien lineas de aviso.

    Un archivo temporal lo resuelve sin hilos: el sistema operativo absorbe
    todo lo que ffmpeg escriba y al final se lee entero.
    """
    barra = Barra(etiqueta, max(1.0, duracion), salida=salida)
    with tempfile.TemporaryFile() as ruido:
        proceso = subprocess.Popen(
            comando, stdout=subprocess.PIPE, stderr=ruido,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        for linea in proceso.stdout:
            segundos = segundos_de_linea_de_progreso(linea)
            if segundos is not None:
                barra.poner(segundos)
        proceso.stdout.close()
        codigo = proceso.wait()
        ruido.seek(0)
        error = ruido.read().decode("utf-8", "replace")
    if codigo != 0:
        raise Aviso("ffmpeg fallo (codigo %d):\n%s" % (codigo, (error or "").strip()[-2000:]))
    barra.terminar()


# --------------------------------------------------------------------------
# Subtitulos atados al reloj del MPEG-TS
# --------------------------------------------------------------------------

def medir_desfase_ts(carpeta, correr=None):
    """Segundos en los que arranca el primer segmento MPEG-TS.

    Se mide, no se adivina: el colchon del muxer depende de la version de
    ffmpeg y del archivo de entrada. Devuelve None si no se pudo medir, para
    que el que llama avise en vez de inventar un numero.
    """
    correr = correr or subprocess.run
    segmentos = sorted(Path(carpeta).rglob("seg*.ts"))
    if not segmentos:
        return None
    resultado = correr(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(segmentos[0])],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if resultado.returncode != 0:
        return None
    try:
        datos = json.loads(resultado.stdout)
    except (json.JSONDecodeError, TypeError):
        return None
    tiempos = []
    for origen in [datos.get("format") or {}] + list(datos.get("streams") or []):
        try:
            tiempos.append(float(origen.get("start_time")))
        except (TypeError, ValueError):
            continue
    if not tiempos:
        return None
    # hls.js toma como origen el menor PTS del fragmento (video o audio), que
    # es justo lo que ffprobe informa como format.start_time.
    return max(0.0, min(tiempos))


def encabezado_timestamp_map(desfase):
    """El encabezado que ata el tiempo del WebVTT al reloj de 90 kHz del TS.

    RFC 8216 seccion 3.5 dice que SHOULD estar. hls.js
    (src/utils/webvtt-parser.ts), que es el reproductor de la Sala, sin este
    encabezado mapea la cue 0 al MPEGTS 0: como el TS arranca en ~1,5 s,
    todas las cues salen adelantadas esa cantidad y la primera desaparece
    (queda en tiempo negativo). Lo escribe el muxer HLS de ffmpeg cuando los
    subtitulos van en el var_stream_map; como aca salen aparte, nos toca a
    nosotros.
    """
    return "X-TIMESTAMP-MAP=MPEGTS:%d,LOCAL:00:00:00.000" % int(
        round(max(0.0, float(desfase or 0.0)) * RELOJ_MPEGTS))


def poner_timestamp_map(texto, desfase):
    """Mete el encabezado justo despues de la linea WEBVTT, que es donde va."""
    lineas = str(texto).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not lineas or not lineas[0].lstrip("\ufeff").startswith("WEBVTT"):
        lineas.insert(0, "WEBVTT")
    # Los encabezados van pegados al WEBVTT, antes de la primera linea en
    # blanco. Si ya habia uno, se reemplaza en vez de duplicarlo.
    resto = [l for l in lineas[1:] if not l.strip().startswith("X-TIMESTAMP-MAP")]
    return "\n".join([lineas[0], encabezado_timestamp_map(desfase)] + resto)


def extraer_subtitulos(entrada, destino, pistas, correr=None, desfase=0.0):
    """Una carpeta por pista: subtitulos/<idioma>/subtitulos.vtt.

    `desfase` son los segundos en los que arranca el MPEG-TS (lo mide
    medir_desfase_ts). Va al X-TIMESTAMP-MAP de cada WebVTT: sin el, los
    subtitulos salen adelantados y la primera linea no se ve nunca.
    """
    correr = correr or subprocess.run
    hechas = []
    usados = set()
    for pista in pistas:
        etiqueta = sanear_etiqueta(pista["idioma"])
        sufijo = etiqueta
        numero = 2
        while sufijo in usados:
            sufijo = "%s-%d" % (etiqueta, numero)
            numero += 1
        usados.add(sufijo)

        carpeta = Path(destino) / "subtitulos" / sufijo
        carpeta.mkdir(parents=True, exist_ok=True)
        archivo = carpeta / "subtitulos.vtt"
        resultado = correr(
            ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
             "-i", str(entrada), "-map", "0:s:%d" % pista["indice"],
             "-c:s", "webvtt", str(archivo)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if resultado.returncode != 0 or not archivo.is_file() or archivo.stat().st_size == 0:
            print("   (no pude convertir la pista de subtitulos %s, la salteo)" % etiqueta)
            continue
        archivo.write_text(
            poner_timestamp_map(archivo.read_text(encoding="utf-8-sig"), desfase),
            encoding="utf-8")
        hechas.append({
            "carpeta": "subtitulos/" + sufijo,
            "idioma": etiqueta,
            "nombre": nombre_de_idioma(etiqueta, pista["titulo"]),
            "predeterminado": pista["predeterminado"],
        })
    return hechas


# --------------------------------------------------------------------------
# Playlists
# --------------------------------------------------------------------------

def escribir_playlist_de_subtitulo(duracion, archivo="subtitulos.vtt"):
    """Un WebVTT entero como unico segmento. Es lo que entiende hls.js."""
    entera = max(1, int(math.ceil(duracion)))
    return "\n".join([
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:%d" % entera,
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXTINF:%.3f," % duracion,
        archivo,
        "#EXT-X-ENDLIST",
        "",
    ])


def normalizar_uris(playlist):
    """En Windows, ffmpeg escribe `720p\\lista.m3u8` en la playlist maestra.

    En una URL la barra invertida no separa carpetas: el navegador pediria
    literalmente `720p%5Clista.m3u8` y R2 contestaria 404. Como el dueno
    convierte en Windows y la playlist se lee en un navegador, hay que pasar
    todo a barras normales antes de subir.
    """
    salida = []
    for linea in str(playlist).splitlines():
        pelada = linea.strip()
        if pelada.startswith("#"):
            linea = re.sub(
                r'URI="([^"]*)"',
                lambda encontrado: 'URI="%s"' % encontrado.group(1).replace("\\", "/"),
                linea,
            )
        elif pelada:
            linea = linea.replace("\\", "/")
        salida.append(linea)
    return "\n".join(salida) + "\n"


def _entrecomillar(texto):
    return str(texto).replace('"', "'")


def inyectar_subtitulos(maestra, pistas, grupo="subs"):
    """ffmpeg no sabe de los WebVTT que sacamos aparte: hay que agregarlos a
    la maestra y decirle a cada calidad que ese grupo existe."""
    if not pistas:
        return maestra
    lineas = maestra.splitlines()
    medias = []
    for numero, pista in enumerate(pistas):
        medias.append(
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="%s",NAME="%s",LANGUAGE="%s",'
            'AUTOSELECT=YES,DEFAULT=%s,FORCED=NO,URI="%s/lista.m3u8"' % (
                grupo,
                _entrecomillar(pista["nombre"]),
                _entrecomillar(pista["idioma"]),
                "YES" if (pista.get("predeterminado") and numero == 0) else "NO",
                pista["carpeta"],
            )
        )

    salida = []
    puestas = False
    for linea in lineas:
        if linea.startswith("#EXT-X-STREAM-INF:"):
            if not puestas:
                salida.extend(medias)
                puestas = True
            if "SUBTITLES=" not in linea:
                linea = linea.rstrip() + ',SUBTITLES="%s"' % grupo
        salida.append(linea)
    if not puestas:
        salida = medias + salida
    return "\n".join(salida) + "\n"


# --------------------------------------------------------------------------
# R2 (protocolo S3)
# --------------------------------------------------------------------------

def crear_cliente(config, fabrica=None, fabrica_config=None):
    """R2 habla S3, pero no es S3.

    Dos particularidades que cuestan una tarde si no se saben:
    - boto3 >= 1.36 calcula y manda un CRC32 en cada PutObject y UploadPart
      aunque nadie se lo pida. R2 hoy SI soporta CRC-32 (la pagina "S3 API
      compatibility" de Cloudflare, actualizada el 31/07/2026, lo lista en
      modo COMPOSITE), asi que no rompe nada; se deja igual en `when_required`
      porque es menos trabajo y menos bytes por objeto, y porque es lo que
      esta probado. Ojo: `when_required` NO apaga los checksums de las
      operaciones que el modelo de S3 marca como obligatorias, y DeleteObjects
      es una de ellas: ahi el CRC32 viaja igual. Medido, no supuesto.
    - la region es siempre "auto" y el endpoint es del account id, no del
      bucket.
    """
    if fabrica is None or fabrica_config is None:
        try:
            import boto3
            from botocore.config import Config
        except ImportError:
            raise Aviso(
                "Falta boto3.\nInstalalo con:  python -m pip install -r herramientas/requirements.txt"
            )
        fabrica = fabrica or boto3.client
        fabrica_config = fabrica_config or Config

    opciones = fabrica_config(
        signature_version="s3v4",
        request_checksum_calculation="when_required",
        response_checksum_validation="when_required",
        retries={"max_attempts": 5, "mode": "standard"},
    )
    return fabrica(
        "s3",
        endpoint_url=config.get("R2_ENDPOINT")
        or ("https://%s.r2.cloudflarestorage.com" % config["R2_ACCOUNT_ID"]),
        aws_access_key_id=config["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=config["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=opciones,
    )


def archivos_a_subir(carpeta):
    """Lista (ruta absoluta, ruta relativa con barras normales, bytes).

    La maestra va ultima a proposito: mientras no exista, un reproductor que
    adivine la URL no puede empezar a leer un video a medio subir.
    """
    carpeta = Path(carpeta)
    items = []
    for ruta in sorted(carpeta.rglob("*")):
        if ruta.is_file():
            relativa = ruta.relative_to(carpeta).as_posix()
            items.append((ruta, relativa, ruta.stat().st_size))
    items.sort(key=lambda item: (item[1] == "maestra.m3u8", item[1]))
    return items


def subir_carpeta(cliente, bucket, prefijo, identificador, carpeta,
                  hilos=6, salida=None):
    items = archivos_a_subir(carpeta)
    if not items:
        raise Aviso("No hay nada para subir en " + str(carpeta))
    total = sum(tamano for _, _, tamano in items)
    barra = Barra("subiendo", total, salida=salida)
    barra.salida.write("   %d archivos, %s\n" % (len(items), formatear_bytes(total)))

    def subir_uno(item):
        ruta, relativa, _ = item
        clave = clave_r2(prefijo, identificador, relativa)
        cliente.upload_file(
            str(ruta), bucket, clave,
            ExtraArgs={
                "ContentType": tipo_de_contenido(relativa),
                "CacheControl": CACHE_LARGO,
            },
            Callback=barra.avanzar,
        )
        return clave

    maestra = [i for i in items if i[1] == "maestra.m3u8"]
    resto = [i for i in items if i[1] != "maestra.m3u8"]
    claves = []
    with ThreadPoolExecutor(max_workers=max(1, hilos)) as pool:
        for clave in pool.map(subir_uno, resto):
            claves.append(clave)
    for item in maestra:
        claves.append(subir_uno(item))
    barra.terminar()
    return {"claves": claves, "bytes": total, "archivos": len(items)}


def limpiar_sobrantes(cliente, bucket, previas, nuevas, salida=None):
    """Borra lo que quedo de una subida anterior del mismo id.

    `subir_carpeta` pisa, no limpia. Si el video nuevo tiene menos segmentos
    que el viejo (otra fuente, otro corte, otra duracion), los sobrantes se
    quedan ocupando los 10 GB sin aparecer en ninguna playlist y sin que nada
    los nombre. Corre DESPUES de la subida y despues de la maestra: recien
    ahi las claves que sobran son las que no referencia nadie.
    """
    salida = salida or sys.stdout
    puestas = set(nuevas)
    sobrantes = [c for c in previas if c not in puestas]
    if not sobrantes:
        return []
    try:
        borrar_objetos(cliente, bucket, sobrantes)
    except Exception as error:
        # El video ya esta arriba y anda: una limpieza fallida avisa, no
        # tumba la corrida ni impide avisarle al servidor.
        salida.write("   (no pude borrar %d archivo(s) viejos: %s)\n"
                     % (len(sobrantes), type(error).__name__))
        return []
    salida.write("   %d archivo(s) de la version anterior, borrados\n" % len(sobrantes))
    return sobrantes


def leer_maestra(cliente, bucket, clave):
    """Baja la playlist maestra de R2. Es la ficha de lo que se subio."""
    try:
        return cliente.get_object(Bucket=bucket, Key=clave)["Body"].read().decode(
            "utf-8", "replace")
    except Exception as error:
        raise Aviso(
            "No pude leer %s de R2 (%s).\n"
            "Si el video no esta subido, corre el script sin --avisar."
            % (clave, type(error).__name__))


def datos_de_maestra(texto):
    """De la maestra saca las calidades y las pistas de subtitulo.

    Es lo que le falta a `--avisar` para mandar el cuerpo completo: en un
    reintento el script ya no tiene el archivo original, pero la maestra en
    R2 dice exactamente que se subio.
    """
    calidades = []
    subtitulos = []
    for linea in str(texto).splitlines():
        pelada = linea.strip()
        if pelada.startswith("#EXT-X-MEDIA:") and "TYPE=SUBTITLES" in pelada:
            idioma = re.search(r'LANGUAGE="([^"]*)"', pelada)
            nombre = re.search(r'NAME="([^"]*)"', pelada)
            etiqueta = idioma.group(1) if idioma else "und"
            subtitulos.append({
                "idioma": etiqueta,
                "nombre": nombre.group(1) if nombre else nombre_de_idioma(etiqueta),
            })
        elif pelada and not pelada.startswith("#"):
            encontrado = re.match(r"^(\d+)p/", pelada)
            if encontrado:
                calidades.append(int(encontrado.group(1)))
    return {"calidades": sorted(set(calidades)), "subtitulos": subtitulos}


def listar_objetos(cliente, bucket, prefijo):
    """Devuelve [{clave, tamano}] de todo lo que hay bajo el prefijo.

    La barra al final no es cosmetica: sin ella, pedir `istincho/s01` trae
    tambien todo `istincho/s01e03`, y `--borrar s01` se llevaria puesto otro
    video.
    """
    objetos = []
    testigo = None
    # Un prefijo vacio es el bucket entero (lo usa --listar para saber cuanto
    # queda de los 10 GB de verdad). "/" no seria vacio: no matchearia nada.
    raiz = str(prefijo).strip("/")
    while True:
        argumentos = {"Bucket": bucket, "Prefix": (raiz + "/") if raiz else "",
                      "MaxKeys": 1000}
        if testigo:
            argumentos["ContinuationToken"] = testigo
        respuesta = cliente.list_objects_v2(**argumentos)
        for objeto in respuesta.get("Contents") or []:
            objetos.append({"clave": objeto["Key"], "tamano": objeto.get("Size", 0)})
        if not respuesta.get("IsTruncated"):
            break
        testigo = respuesta.get("NextContinuationToken")
        if not testigo:
            break
    return objetos


def agrupar_por_video(objetos, prefijo):
    """Junta las claves por id: `<prefijo>/<id>/...`."""
    grupos = {}
    largo = len(prefijo.strip("/")) + 1
    for objeto in objetos:
        resto = objeto["clave"][largo:]
        identificador = resto.split("/", 1)[0]
        if not identificador:
            continue
        grupo = grupos.setdefault(identificador, {"id": identificador, "archivos": 0, "bytes": 0})
        grupo["archivos"] += 1
        grupo["bytes"] += objeto["tamano"]
    return sorted(grupos.values(), key=lambda g: g["id"])


def borrar_objetos(cliente, bucket, claves):
    """delete_objects acepta hasta 1000 por llamada; con 2 horas de video hay
    mas de 1000 segmentos, asi que hay que partir si o si."""
    borradas = 0
    for arranque in range(0, len(claves), 1000):
        tanda = claves[arranque:arranque + 1000]
        cliente.delete_objects(
            Bucket=bucket,
            Delete={"Objects": [{"Key": c} for c in tanda], "Quiet": True},
        )
        borradas += len(tanda)
    return borradas


# --------------------------------------------------------------------------
# Aviso al servidor
# --------------------------------------------------------------------------

def pedir_al_servidor(config, metodo, camino, cuerpo=None, abrir=None):
    abrir = abrir or urllib.request.urlopen
    url = str(config["URL_SERVIDOR"]).rstrip("/") + camino
    datos = json.dumps(cuerpo).encode("utf-8") if cuerpo is not None else None
    pedido = urllib.request.Request(url, data=datos, method=metodo)
    pedido.add_header("Content-Type", "application/json")
    pedido.add_header("X-Clave-Subida", config["CLAVE_SUBIDA"])
    try:
        with abrir(pedido, timeout=30) as respuesta:
            texto = respuesta.read().decode("utf-8", "replace")
            return respuesta.status, texto
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except urllib.error.URLError as error:
        raise Aviso("No pude hablar con el servidor (%s): %s" % (url, error.reason))


def avisar_video(config, datos, abrir=None):
    estado, texto = pedir_al_servidor(config, "POST", "/api/videos", datos, abrir=abrir)
    if estado >= 400:
        raise Aviso(
            "El servidor rechazo el aviso (HTTP %d): %s\n"
            "El video ya esta en R2. Cuando lo arregles, avisale con:\n"
            "  python herramientas/subir.py --avisar %s --titulo %r --duracion %s"
            % (estado, texto.strip()[:400], datos["id"], datos["titulo"], datos["duracion"])
        )
    return texto


def avisar_borrado(config, identificador, abrir=None):
    estado, texto = pedir_al_servidor(
        config, "DELETE", "/api/videos/" + identificador, abrir=abrir)
    if estado >= 400 and estado != 404:
        raise Aviso("El servidor no pudo borrarlo (HTTP %d): %s" % (estado, texto.strip()[:400]))
    return estado


# --------------------------------------------------------------------------
# Acciones
# --------------------------------------------------------------------------

def prefijo_de(args, config):
    """El prefijo dentro del bucket, siempre validado. Es entrada del usuario
    y arma la clave de R2, incluida la del camino que borra."""
    return validar_slug(getattr(args, "sala", None) or config["SALA_SLUG"])


def accion_subir(args, config):
    entrada = Path(args.archivo)
    if not entrada.is_file():
        raise Aviso("No existe el archivo: " + str(entrada))
    comprobar_programas()
    # Las credenciales se exigen antes de convertir: media hora de ffmpeg para
    # despues morir por una variable que falta seria una broma pesada.
    if not args.solo_preparar:
        exigir(config, VARIABLES_R2 + ("R2_URL_PUBLICA",), "subir a R2")
        if not args.sin_avisar:
            exigir(config, VARIABLES_SERVIDOR, "avisarle al servidor")

    identificador = validar_id(args.id or hacer_id(entrada.name))
    titulo = args.titulo or entrada.stem
    prefijo = prefijo_de(args, config)

    paso(1, 5, "Revisando el archivo")
    fuente = probar_fuente(entrada)
    calidades = calidades_aplicables(fuente["altura"])
    print("   %s - %s, fuente de %dp" % (
        entrada.name, formatear_tiempo(fuente["duracion"]), fuente["altura"]))
    print("   calidades: " + ", ".join(nombre_de_calidad(c[0]) for c in calidades)
          + ("" if len(calidades) == len(CALIDADES)
             else "  (no se agranda: la fuente no da para mas)"))
    if fuente["indice_audio"] is None:
        print("   sin pista de audio")
    if fuente["subtitulos_salteados"]:
        print("   %d pista(s) de subtitulos son imagen (no texto) y se saltean"
              % len(fuente["subtitulos_salteados"]))

    carpeta_padre = Path(args.trabajo) if args.trabajo else Path(tempfile.gettempdir())
    trabajo = Path(tempfile.mkdtemp(prefix="sala-" + identificador + "-", dir=str(carpeta_padre)))
    try:
        paso(2, 5, "Convirtiendo a HLS (segmentos de %d s)" % SEGMENTO_SEGUNDOS)
        comando = construir_comando_ffmpeg(
            entrada, trabajo, calidades, fuente["indice_audio"])
        for altura, _, _, _ in calidades:
            (trabajo / nombre_de_calidad(altura)).mkdir(parents=True, exist_ok=True)
        correr_ffmpeg_con_progreso(comando, fuente["duracion"])

        paso(3, 5, "Subtitulos")
        pistas = []
        if fuente["subtitulos"]:
            # Los segmentos MPEG-TS no arrancan en cero y los WebVTT si: sin
            # este numero los subtitulos salen adelantados y la primera linea
            # no aparece nunca.
            desfase = medir_desfase_ts(trabajo)
            if desfase is None:
                print("   (no pude medir donde arranca el MPEG-TS: los "
                      "subtitulos pueden quedar corridos)")
                desfase = 0.0
            pistas = extraer_subtitulos(
                entrada, trabajo, fuente["subtitulos"], desfase=desfase)
            for pista in pistas:
                (trabajo / pista["carpeta"] / "lista.m3u8").write_text(
                    escribir_playlist_de_subtitulo(fuente["duracion"]), encoding="utf-8")
            print("   %d pista(s): %s" % (len(pistas), ", ".join(p["nombre"] for p in pistas)))
        else:
            print("   el archivo no trae subtitulos de texto")

        maestra = trabajo / "maestra.m3u8"
        if not maestra.is_file():
            raise Aviso("ffmpeg no dejo la playlist maestra en " + str(maestra))
        for playlist in trabajo.rglob("*.m3u8"):
            playlist.write_text(
                normalizar_uris(playlist.read_text(encoding="utf-8")), encoding="utf-8")
        maestra.write_text(
            inyectar_subtitulos(maestra.read_text(encoding="utf-8"), pistas), encoding="utf-8")

        if args.solo_preparar:
            destino = Path.cwd() / ("hls-" + identificador)
            if destino.exists():
                # Borrar una carpeta del dueno sin preguntar es de mal gusto:
                # puede tener ahi la corrida anterior que estaba mirando.
                if not args.si:
                    raise Aviso(
                        "Ya existe %s.\nBorrala vos o corre de nuevo con --si "
                        "para reemplazarla." % destino)
                shutil.rmtree(destino)
            shutil.move(str(trabajo), str(destino))
            trabajo = None
            print("\nListo, sin subir. Quedo en: %s" % destino)
            return 0

        paso(4, 5, "Subiendo a R2 (bucket %s, %s/%s/)"
             % (config["R2_BUCKET"], prefijo, identificador))
        cliente = crear_cliente(config)
        entero = prefijo + "/" + identificador
        previas = [o["clave"] for o in
                   listar_objetos(cliente, config["R2_BUCKET"], entero)]
        if previas:
            # Dos capitulos distintos con el mismo nombre de archivo dan el
            # mismo id. Que se entere ahora y no cuando falte un video.
            print("   OJO: ya habia %d archivo(s) en %s/. Este video los reemplaza."
                  % (len(previas), entero))
        resultado = subir_carpeta(
            cliente, config["R2_BUCKET"], prefijo, identificador, trabajo, hilos=args.hilos)
        limpiar_sobrantes(cliente, config["R2_BUCKET"], previas, resultado["claves"])

        url = unir_url(config["R2_URL_PUBLICA"],
                       clave_r2(prefijo, identificador, "maestra.m3u8"))
        datos = {
            "id": identificador,
            "slug": prefijo,
            "titulo": titulo,
            "duracion": round(fuente["duracion"], 3),
            "url": url,
            "calidades": [c[0] for c in calidades],
            "subtitulos": [{"idioma": p["idioma"], "nombre": p["nombre"]} for p in pistas],
            "bytes": resultado["bytes"],
        }

        paso(5, 5, "Avisandole al servidor")
        if args.sin_avisar:
            print("   salteado (--sin-avisar). Datos para cargarlo a mano:")
            print("   " + json.dumps(datos, ensure_ascii=False))
        else:
            avisar_video(config, datos)
            print("   ok")

        print("\nListo: %s (%s, %s)" % (titulo, formatear_tiempo(fuente["duracion"]),
                                        formatear_bytes(resultado["bytes"])))
        print("Playlist: " + url)
        return 0
    finally:
        if trabajo and not args.conservar and Path(trabajo).exists():
            shutil.rmtree(trabajo, ignore_errors=True)
        elif trabajo and args.conservar:
            print("Archivos de trabajo en: " + str(trabajo))


def accion_listar(args, config):
    exigir(config, VARIABLES_R2, "listar lo que hay en R2")
    prefijo = prefijo_de(args, config)
    cliente = crear_cliente(config)
    objetos = listar_objetos(cliente, config["R2_BUCKET"], prefijo)
    grupos = agrupar_por_video(objetos, prefijo)
    if not grupos:
        print("No hay nada en %s bajo %s/" % (config["R2_BUCKET"], prefijo))
    else:
        print("%-32s %9s %10s" % ("id", "archivos", "peso"))
        for grupo in grupos:
            print("%-32s %9d %10s"
                  % (grupo["id"], grupo["archivos"], formatear_bytes(grupo["bytes"])))
        print("%-32s %9d %10s"
              % ("total " + prefijo + "/", sum(g["archivos"] for g in grupos),
                 formatear_bytes(sum(g["bytes"] for g in grupos))))

    # Los 10 GB gratis son del bucket entero, no de este prefijo. Contando
    # solo `istincho/` el numero miente en cuanto haya otro prefijo (otra
    # sala, una prueba, lo que sea) y el aviso llegaria tarde: cuando R2
    # empiece a cobrar.
    todo = sum(o["tamano"] for o in listar_objetos(cliente, config["R2_BUCKET"], ""))
    print("En el bucket %s hay %s en total. Quedan %s de los 10 GB gratis."
          % (config["R2_BUCKET"], formatear_bytes(todo),
             formatear_bytes(max(0, 10 * 1024 ** 3 - todo))))
    return 0


def accion_borrar(args, config):
    identificador = validar_id(args.borrar)
    exigir(config, VARIABLES_R2, "borrar de R2")
    prefijo = prefijo_de(args, config)
    cliente = crear_cliente(config)
    entero = prefijo + "/" + identificador
    objetos = listar_objetos(cliente, config["R2_BUCKET"], entero)
    claves = [o["clave"] for o in objetos]
    bytes_totales = sum(o["tamano"] for o in objetos)

    if not claves:
        print("En R2 no hay nada bajo %s/" % entero)
    else:
        print("Se van a borrar %d archivos (%s) de %s/"
              % (len(claves), formatear_bytes(bytes_totales), entero))
        if not args.si:
            respuesta = input("Escribi el id para confirmar: ").strip()
            if respuesta != identificador:
                print("No coincide. No se borro nada.")
                return 1
        borradas = borrar_objetos(cliente, config["R2_BUCKET"], claves)
        print("Borrados %d objetos de R2." % borradas)

    if args.sin_avisar:
        print("No le aviso al servidor (--sin-avisar).")
        return 0
    exigir(config, VARIABLES_SERVIDOR, "avisarle al servidor")
    estado = avisar_borrado(config, identificador)
    print("Servidor: %s" % ("no lo tenia" if estado == 404 else "borrado del almacen"))
    return 0


def accion_avisar(args, config):
    """Reintento del paso 5 cuando el video ya esta en R2 y el aviso fallo.

    Manda el MISMO cuerpo que la subida normal, no uno recortado. El servidor
    pisa la ficha entera con lo que llega: un cuerpo a medias dejaria el video
    sin calidades, sin subtitulos y con 0 bytes en el panel, o directamente
    daria 400 si algun dia esos campos pasan a ser obligatorios.

    Lo que falta (calidades, subtitulos, peso) sale de R2, que es donde quedo:
    en un reintento el archivo original ya no esta a mano, y la maestra dice
    exactamente que se subio. De paso, si en R2 no hay nada, avisa en vez de
    registrar un video que no existe.
    """
    identificador = validar_id(args.avisar)
    exigir(config, VARIABLES_SERVIDOR + ("R2_URL_PUBLICA",) + VARIABLES_R2,
           "avisarle al servidor de un video ya subido")
    if args.duracion is None:
        raise Aviso("--avisar necesita tambien --duracion (en segundos).")
    prefijo = prefijo_de(args, config)
    cliente = crear_cliente(config)
    entero = prefijo + "/" + identificador
    objetos = listar_objetos(cliente, config["R2_BUCKET"], entero)
    if not objetos:
        raise Aviso(
            "En R2 no hay nada bajo %s/, asi que no hay nada que avisar.\n"
            "Corre el script con el archivo de video, sin --avisar." % entero)

    clave_maestra = clave_r2(prefijo, identificador, "maestra.m3u8")
    ficha = datos_de_maestra(
        leer_maestra(cliente, config["R2_BUCKET"], clave_maestra))
    datos = {
        "id": identificador,
        "slug": prefijo,
        "titulo": args.titulo or identificador,
        "duracion": round(float(args.duracion), 3),
        "url": unir_url(config["R2_URL_PUBLICA"], clave_maestra),
        "calidades": ficha["calidades"],
        "subtitulos": ficha["subtitulos"],
        "bytes": sum(o["tamano"] for o in objetos),
    }
    avisar_video(config, datos)
    print("Avisado: " + datos["url"])
    return 0


# --------------------------------------------------------------------------
# Entrada
# --------------------------------------------------------------------------

def armar_parser():
    parser = argparse.ArgumentParser(
        prog="subir.py",
        description="Prepara un video en HLS y lo sube a Cloudflare R2 para la Sala.",
    )
    parser.add_argument("archivo", nargs="?", help="archivo de video a subir")
    parser.add_argument("--listar", action="store_true", help="mostrar que hay en R2")
    parser.add_argument("--borrar", metavar="ID", help="borrar un video de R2 y del servidor")
    parser.add_argument("--avisar", metavar="ID",
                        help="reintentar el aviso al servidor de un video ya subido "
                             "(lee de R2 calidades, subtitulos y peso)")
    parser.add_argument("--id", help="id del video (por defecto, sale del nombre del archivo)")
    parser.add_argument("--titulo", help="titulo que se ve en el panel")
    parser.add_argument("--duracion", type=float, help="duracion en segundos (solo con --avisar)")
    parser.add_argument("--sala", help="prefijo en el bucket (por defecto, SALA_SLUG)")
    parser.add_argument("--hilos", type=int, default=6, help="subidas en paralelo (por defecto 6)")
    parser.add_argument("--trabajo", help="carpeta donde convertir (por defecto, la temporal)")
    parser.add_argument("--solo-preparar", action="store_true", dest="solo_preparar",
                        help="convertir y dejar los archivos, sin subir nada")
    parser.add_argument("--sin-avisar", action="store_true", dest="sin_avisar",
                        help="no llamar al servidor")
    parser.add_argument("--conservar", action="store_true",
                        help="no borrar la carpeta temporal al terminar")
    parser.add_argument("--si", action="store_true",
                        help="no preguntar al borrar ni al reemplazar una carpeta")
    parser.add_argument("--env", default=str(Path(__file__).with_name(".env")),
                        help="ruta del .env con las credenciales")
    return parser


def main(argv=None):
    parser = armar_parser()
    args = parser.parse_args(argv)
    elegidas = [bool(args.archivo), args.listar, bool(args.borrar), bool(args.avisar)]
    if sum(1 for e in elegidas if e) != 1:
        parser.print_help()
        return 2
    try:
        config = configuracion(args.env)
        if args.listar:
            return accion_listar(args, config)
        if args.borrar:
            return accion_borrar(args, config)
        if args.avisar:
            return accion_avisar(args, config)
        return accion_subir(args, config)
    except Aviso as aviso:
        print("\n" + str(aviso), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nCortado a mano.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
