#!/usr/bin/env python3
"""Pruebas de herramientas/subir.py.

    python herramientas/pruebas_subir.py

No van en `pruebas/` porque ahi vive la suite de Node (`npm test`, node --test)
y esto es Python. Se corren aparte, a mano, antes de tocar el script.

Cada prueba se escribio rompiendo primero el codigo que protege y mirando que
fallara: un test que pasa contra el codigo roto no es una red de seguridad.
Las que hablan S3 levantan un doble local del API (http.server) y le apuntan
un cliente boto3 de verdad, asi se ejercita la firma y los encabezados que
manda boto3, que es donde estan las diferencias entre R2 y S3. Si boto3 no
esta instalado, esas pruebas se saltean con aviso.
"""

import base64
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import subir  # noqa: E402


# ==========================================================================
# Utilidades puras
# ==========================================================================

class PruebaIdentificadores(unittest.TestCase):

    def test_hacer_id_saca_acentos_y_espacios(self):
        self.assertEqual(subir.hacer_id("La Niña   (2019).mkv"), "la-nina-2019")
        self.assertEqual(subir.hacer_id("S01E03.mkv"), "s01e03")

    def test_hacer_id_no_deja_guiones_en_las_puntas(self):
        self.assertEqual(subir.hacer_id("--raro--.mp4"), "raro")

    def test_validar_id_rechaza_lo_que_borraria_de_mas(self):
        # Sin esta guarda, `--borrar ..` o `--borrar ''` construyen un prefijo
        # que abarca todo el bucket del canal.
        for malo in ["", "..", "../otro", "s01/e03", "S01E03", "-arranca-mal", None]:
            with self.assertRaises(subir.Aviso, msg=repr(malo)):
                subir.validar_id(malo)

    def test_validar_id_acepta_lo_normal(self):
        self.assertEqual(subir.validar_id("s01e03"), "s01e03")
        self.assertEqual(subir.validar_id("la-nina-2019"), "la-nina-2019")


class PruebaClavesYUrls(unittest.TestCase):

    def test_clave_r2_usa_barras_normales_tambien_en_windows(self):
        # Si esto usara os.path.join, en Windows la clave saldria
        # `istincho/s01e03\720p\seg00000.ts` y el objeto quedaria inalcanzable.
        clave = subir.clave_r2("istincho", "s01e03", "720p\\seg00000.ts")
        self.assertEqual(clave, "istincho/s01e03/720p/seg00000.ts")
        self.assertNotIn("\\", clave)

    def test_clave_r2_no_duplica_barras(self):
        self.assertEqual(
            subir.clave_r2("/istincho/", "s01e03", "/maestra.m3u8"),
            "istincho/s01e03/maestra.m3u8",
        )

    def test_unir_url_no_deja_barra_doble(self):
        self.assertEqual(
            subir.unir_url("https://pub-x.r2.dev/", "istincho/s01e03/maestra.m3u8"),
            "https://pub-x.r2.dev/istincho/s01e03/maestra.m3u8",
        )


class PruebaTiposDeContenido(unittest.TestCase):

    def test_cada_extension_tiene_el_tipo_que_espera_hls_js(self):
        self.assertEqual(subir.tipo_de_contenido("maestra.m3u8"), "application/vnd.apple.mpegurl")
        self.assertEqual(subir.tipo_de_contenido("720p/seg00000.ts"), "video/mp2t")
        self.assertEqual(subir.tipo_de_contenido("subtitulos/spa/subtitulos.vtt"), "text/vtt")

    def test_mayusculas_en_la_extension(self):
        self.assertEqual(subir.tipo_de_contenido("LISTA.M3U8"), "application/vnd.apple.mpegurl")


class PruebaCalidades(unittest.TestCase):

    def test_fuente_1080_da_las_dos(self):
        self.assertEqual([c[0] for c in subir.calidades_aplicables(1080)], [720, 1080])

    def test_fuente_720_no_agranda_a_1080(self):
        # Un 1080p inventado desde un 720p duplica el peso en un bucket de
        # 10 GB sin que se vea mejor.
        self.assertEqual([c[0] for c in subir.calidades_aplicables(720)], [720])

    def test_fuente_chica_igual_produce_una_calidad(self):
        calidades = subir.calidades_aplicables(480)
        self.assertEqual(len(calidades), 1)
        self.assertEqual(calidades[0][0], 480)

    def test_altura_impar_se_vuelve_par(self):
        # libx264 con yuv420p no acepta alturas impares.
        self.assertEqual(subir.calidades_aplicables(481)[0][0] % 2, 0)


class PruebaFfprobe(unittest.TestCase):

    def datos(self, **cambios):
        base = {
            "format": {"duration": "7245.5"},
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "height": 1080},
                {"codec_type": "audio", "codec_name": "aac", "disposition": {"default": 0}},
                {"codec_type": "audio", "codec_name": "ac3", "disposition": {"default": 1}},
                {"codec_type": "subtitle", "codec_name": "subrip",
                 "tags": {"language": "spa", "title": "Latino"}, "disposition": {"default": 1}},
                {"codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle",
                 "tags": {"language": "eng"}},
            ],
        }
        base.update(cambios)
        return base

    def test_lee_duracion_altura_y_audio_predeterminado(self):
        leido = subir.analizar_ffprobe(self.datos())
        self.assertAlmostEqual(leido["duracion"], 7245.5)
        self.assertEqual(leido["altura"], 1080)
        # El indice es relativo a las pistas de audio (0:a:1), no al stream.
        self.assertEqual(leido["indice_audio"], 1)

    def test_separa_subtitulos_de_texto_de_los_de_imagen(self):
        leido = subir.analizar_ffprobe(self.datos())
        self.assertEqual([p["codec"] for p in leido["subtitulos"]], ["subrip"])
        self.assertEqual([p["codec"] for p in leido["subtitulos_salteados"]], ["hdmv_pgs_subtitle"])
        # El indice tiene que ser el de la pista de subtitulos (0:s:0), no el
        # del stream dentro del archivo: con 0:s:3 ffmpeg falla.
        self.assertEqual(leido["subtitulos"][0]["indice"], 0)

    def test_sin_audio_no_explota(self):
        datos = self.datos()
        datos["streams"] = [s for s in datos["streams"] if s["codec_type"] != "audio"]
        self.assertIsNone(subir.analizar_ffprobe(datos)["indice_audio"])

    def test_sin_video_avisa_claro(self):
        datos = self.datos()
        datos["streams"] = [s for s in datos["streams"] if s["codec_type"] != "video"]
        with self.assertRaises(subir.Aviso):
            subir.analizar_ffprobe(datos)

    def test_la_caratula_no_cuenta_como_video(self):
        # Un mp3 o un mkv con caratula trae un stream de video de 1 frame.
        datos = self.datos()
        datos["streams"].append({"codec_type": "video", "codec_name": "mjpeg", "height": 3000,
                                 "disposition": {"attached_pic": 1}})
        self.assertEqual(subir.analizar_ffprobe(datos)["altura"], 1080)


class PruebaComandoFfmpeg(unittest.TestCase):

    def comando(self, calidades=None, indice_audio=0):
        return subir.construir_comando_ffmpeg(
            "entrada.mkv", Path("/t"), calidades or list(subir.CALIDADES), indice_audio)

    def test_segmentos_de_seis_segundos(self):
        comando = self.comando()
        self.assertIn("-hls_time", comando)
        self.assertEqual(comando[comando.index("-hls_time") + 1], "6")
        self.assertEqual(subir.SEGMENTO_SEGUNDOS, 6)

    def test_keyframes_alineados_con_el_corte(self):
        # Sin esto los segmentos salen mas largos que 6 s y el reloj de la
        # sala no puede saltar a un segundo exacto.
        comando = self.comando()
        self.assertIn("expr:gte(t,n_forced*6)",
                      comando[comando.index("-force_key_frames") + 1])

    def test_var_stream_map_con_la_sintaxis_que_acepta_ffmpeg(self):
        # ffmpeg quiere `name:720p`. Con `name=720p` contesta
        # "Invalid keyval name=720p" y no escribe nada.
        mapa = self.comando()[self.comando().index("-var_stream_map") + 1]
        self.assertEqual(mapa, "v:0,a:0,name:720p v:1,a:1,name:1080p")

    def test_sin_audio_el_mapa_no_menciona_pistas_de_audio(self):
        comando = self.comando(indice_audio=None)
        mapa = comando[comando.index("-var_stream_map") + 1]
        self.assertEqual(mapa, "v:0,name:720p v:1,name:1080p")
        self.assertNotIn("-c:a", comando)

    def test_una_sola_calidad_no_usa_split(self):
        comando = self.comando(calidades=[subir.CALIDADES[0]])
        filtro = comando[comando.index("-filter_complex") + 1]
        self.assertNotIn("split", filtro)
        self.assertIn("scale=-2:720", filtro)

    def test_playlist_de_tipo_vod(self):
        comando = self.comando()
        self.assertEqual(comando[comando.index("-hls_playlist_type") + 1], "vod")


class PruebaProgresoDeFfmpeg(unittest.TestCase):

    def test_lee_out_time(self):
        self.assertAlmostEqual(
            subir.segundos_de_linea_de_progreso("out_time=00:01:23.450000"), 83.45)
        self.assertAlmostEqual(
            subir.segundos_de_linea_de_progreso("out_time=01:00:00.000000"), 3600.0)

    def test_ignora_las_demas_lineas(self):
        for linea in ["frame=120", "out_time_us=83450000", "progress=continue", ""]:
            self.assertIsNone(subir.segundos_de_linea_de_progreso(linea))


class PruebaPlaylists(unittest.TestCase):

    MAESTRA = "\n".join([
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        "#EXT-X-STREAM-INF:BANDWIDTH=2685893,RESOLUTION=1280x720",
        "720p\\lista.m3u8",
        "",
        "#EXT-X-STREAM-INF:BANDWIDTH=5336192,RESOLUTION=1920x1080",
        "1080p\\lista.m3u8",
        "",
    ])

    PISTAS = [
        {"carpeta": "subtitulos/spa", "idioma": "spa",
         "nombre": "Espanol", "predeterminado": True},
        {"carpeta": "subtitulos/eng", "idioma": "eng",
         "nombre": "Ingles", "predeterminado": False},
    ]

    def test_normalizar_uris_arregla_las_barras_de_windows(self):
        # ffmpeg en Windows escribe `720p\lista.m3u8`. En una URL la barra
        # invertida no separa carpetas: R2 contesta 404 y el video no arranca.
        arreglada = subir.normalizar_uris(self.MAESTRA)
        self.assertIn("720p/lista.m3u8", arreglada)
        self.assertNotIn("\\", arreglada)

    def test_normalizar_uris_tambien_dentro_de_URI(self):
        linea = '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subtitulos\\spa\\lista.m3u8"'
        self.assertIn('URI="subtitulos/spa/lista.m3u8"', subir.normalizar_uris(linea))

    def test_normalizar_uris_no_toca_los_demas_comentarios(self):
        self.assertIn("#EXT-X-VERSION:6", subir.normalizar_uris(self.MAESTRA))

    def test_inyectar_subtitulos_agrega_media_y_marca_cada_calidad(self):
        salida = subir.inyectar_subtitulos(subir.normalizar_uris(self.MAESTRA), self.PISTAS)
        lineas = salida.splitlines()
        medias = [l for l in lineas if l.startswith("#EXT-X-MEDIA:")]
        streams = [l for l in lineas if l.startswith("#EXT-X-STREAM-INF:")]
        self.assertEqual(len(medias), 2)
        self.assertEqual(len(streams), 2)
        for linea in streams:
            self.assertIn('SUBTITLES="subs"', linea)
        for linea in medias:
            self.assertIn('GROUP-ID="subs"', linea)
        # Las declaraciones tienen que ir antes del primer EXT-X-STREAM-INF.
        self.assertLess(lineas.index(medias[0]), lineas.index(streams[0]))

    def test_inyectar_subtitulos_sin_pistas_no_toca_nada(self):
        self.assertEqual(subir.inyectar_subtitulos(self.MAESTRA, []), self.MAESTRA)

    def test_solo_una_pista_queda_como_predeterminada(self):
        pistas = [dict(p, predeterminado=True) for p in self.PISTAS]
        salida = subir.inyectar_subtitulos(self.MAESTRA, pistas)
        self.assertEqual(salida.count("DEFAULT=YES"), 1)

    def test_playlist_de_subtitulo_es_valida(self):
        texto = subir.escribir_playlist_de_subtitulo(7245.5)
        self.assertTrue(texto.startswith("#EXTM3U"))
        self.assertIn("#EXT-X-ENDLIST", texto)
        self.assertIn("subtitulos.vtt", texto)
        # TARGETDURATION es entero y nunca menor que el EXTINF.
        objetivo = int(re.search(r"#EXT-X-TARGETDURATION:(\d+)", texto).group(1))
        duracion = float(re.search(r"#EXTINF:([\d.]+),", texto).group(1))
        self.assertGreaterEqual(objetivo, duracion)


class PruebaEnv(unittest.TestCase):

    def escribir(self, contenido):
        carpeta = tempfile.mkdtemp()
        ruta = Path(carpeta) / ".env"
        ruta.write_text(contenido, encoding="utf-8")
        return ruta

    def test_lee_pares_y_saltea_comentarios(self):
        ruta = self.escribir(
            "# comentario\n\nR2_BUCKET=sala-video\nexport R2_ACCOUNT_ID='abc'\n"
            'R2_URL_PUBLICA="https://pub-x.r2.dev"\nsin_igual\n')
        valores = subir.leer_env(ruta)
        self.assertEqual(valores["R2_BUCKET"], "sala-video")
        self.assertEqual(valores["R2_ACCOUNT_ID"], "abc")
        self.assertEqual(valores["R2_URL_PUBLICA"], "https://pub-x.r2.dev")
        self.assertNotIn("sin_igual", valores)

    def test_un_valor_con_signo_igual_adentro_no_se_corta(self):
        ruta = self.escribir("CLAVE_SUBIDA=aa=bb=cc\n")
        self.assertEqual(subir.leer_env(ruta)["CLAVE_SUBIDA"], "aa=bb=cc")

    def test_sin_archivo_devuelve_vacio(self):
        self.assertEqual(subir.leer_env("no-existe-jamas.env"), {})

    def test_el_env_le_gana_al_entorno(self):
        ruta = self.escribir("R2_BUCKET=del-archivo\n")
        config = subir.configuracion(ruta, entorno={"R2_BUCKET": "del-entorno"})
        self.assertEqual(config["R2_BUCKET"], "del-archivo")

    def test_valores_por_defecto(self):
        config = subir.configuracion("no-existe-jamas.env", entorno={})
        self.assertEqual(config["R2_BUCKET"], "sala-video")
        self.assertEqual(config["SALA_SLUG"], "istincho")

    def test_exigir_nombra_lo_que_falta_sin_mostrar_valores(self):
        with self.assertRaises(subir.Aviso) as caja:
            subir.exigir({"R2_ACCOUNT_ID": "secreto-abc"},
                         ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID"), "probar")
        mensaje = str(caja.exception)
        self.assertIn("R2_ACCESS_KEY_ID", mensaje)
        self.assertNotIn("secreto-abc", mensaje)


class PruebaOrdenDeSubida(unittest.TestCase):

    def carpeta(self):
        raiz = Path(tempfile.mkdtemp())
        (raiz / "720p").mkdir()
        (raiz / "720p" / "seg00000.ts").write_bytes(b"a" * 10)
        (raiz / "720p" / "lista.m3u8").write_text("x")
        # `subtitulos/` va despues de `maestra` por orden alfabetico: sin el
        # orden explicito, la maestra no queda ultima.
        (raiz / "subtitulos" / "spa").mkdir(parents=True)
        (raiz / "subtitulos" / "spa" / "subtitulos.vtt").write_text("WEBVTT\n")
        (raiz / "maestra.m3u8").write_text("y")
        return raiz

    def test_la_maestra_va_ultima(self):
        # Mientras la maestra no exista, nadie puede empezar a mirar un video
        # a medio subir.
        items = subir.archivos_a_subir(self.carpeta())
        self.assertEqual(items[-1][1], "maestra.m3u8")
        self.assertEqual(len(items), 4)

    def test_las_rutas_relativas_salen_con_barras_normales(self):
        items = subir.archivos_a_subir(self.carpeta())
        for _, relativa, _ in items:
            self.assertNotIn("\\", relativa)


class ClienteEspia:
    """Cliente S3 de mentira que anota el orden y cuantas subidas hay en vuelo.

    Con `esperados` no depende del reloj ni del scheduler: cada subida que no
    es la maestra se queda esperando hasta que arrancaron TODAS, y recien ahi
    se sueltan juntas. Asi, si alguien pone la maestra en el mismo lote que el
    resto, la maestra corre necesariamente con las otras en vuelo y el test
    falla siempre; con el codigo bueno, la maestra sale sola y en vuelo es 0
    siempre. Antes esto se hacia con un `sleep` y salia verde 6 de cada 10
    corridas aun con la invariante rota: una red de seguridad que es una
    tirada de dados no es una red.
    """

    def __init__(self, demora=0.0, esperados=None):
        self.orden = []
        self.demora = demora
        self.esperados = esperados
        self.candado = threading.Lock()
        self.arrancaron_todas = threading.Event()
        self.en_vuelo = 0
        self.en_vuelo_al_subir_la_maestra = None
        self.sin_callback = []
        self.extras = {}

    def upload_file(self, ruta, bucket, clave, ExtraArgs=None, Callback=None):
        es_maestra = clave.endswith("maestra.m3u8")
        if es_maestra:
            with self.candado:
                self.en_vuelo_al_subir_la_maestra = self.en_vuelo
            # Si la maestra corre en el mismo lote, suelta a las demas: el
            # test tiene que fallar por la asercion, no colgarse.
            self.arrancaron_todas.set()
        else:
            with self.candado:
                self.en_vuelo += 1
                if self.esperados is not None and self.en_vuelo >= self.esperados:
                    self.arrancaron_todas.set()
            if self.esperados is not None:
                self.arrancaron_todas.wait(timeout=10)
            time.sleep(self.demora)
            with self.candado:
                self.en_vuelo -= 1
        with self.candado:
            self.orden.append(clave)
            self.extras[clave] = ExtraArgs or {}
            if Callback is None:
                self.sin_callback.append(clave)
        if Callback is not None:
            Callback(Path(ruta).stat().st_size)


def carpeta_de_prueba():
    raiz = Path(tempfile.mkdtemp())
    for calidad in ("720p", "1080p"):
        (raiz / calidad).mkdir()
        (raiz / calidad / "lista.m3u8").write_text("#EXTM3U\n")
        for numero in range(2):
            (raiz / calidad / ("seg%05d.ts" % numero)).write_bytes(b"\x47" * 1024)
    (raiz / "maestra.m3u8").write_text("#EXTM3U\n")
    return raiz


class PruebaSubidaConEspia(unittest.TestCase):

    def test_la_maestra_no_se_sube_hasta_que_no_queda_nada_en_vuelo(self):
        # Si la maestra apareciera con segmentos todavia subiendo, alguien que
        # entre a la sala en ese momento veria el video cortado.
        #
        # El test es determinista: las 6 subidas que no son la maestra se
        # bloquean hasta que arrancaron todas, y hay un hilo mas que archivos,
        # asi que si la maestra estuviera en el mismo lote arrancaria si o si
        # con las otras seis en vuelo. No hay ventana de tiempo que ganar.
        carpeta = carpeta_de_prueba()
        cuantas = len([i for i in subir.archivos_a_subir(carpeta)
                       if i[1] != "maestra.m3u8"])
        espia = ClienteEspia(esperados=cuantas)
        subir.subir_carpeta(espia, "sala-video", "istincho", "s01e03",
                            carpeta, hilos=cuantas + 1, salida=io.StringIO())
        self.assertEqual(espia.en_vuelo_al_subir_la_maestra, 0)
        self.assertEqual(espia.orden[-1], "istincho/s01e03/maestra.m3u8")
        self.assertEqual(len(espia.orden), cuantas + 1)

    def test_cada_subida_lleva_callback_de_progreso(self):
        # Sin Callback la barra se queda en 0 hasta el final: una subida de
        # 2 GB parecia colgada.
        espia = ClienteEspia()
        salida = io.StringIO()
        carpeta = carpeta_de_prueba()
        resultado = subir.subir_carpeta(espia, "sala-video", "istincho", "s01e03",
                                        carpeta, hilos=3, salida=salida)
        self.assertEqual(espia.sin_callback, [])
        self.assertEqual(resultado["archivos"], len(espia.orden))
        self.assertEqual(resultado["bytes"], sum(t for _, _, t in subir.archivos_a_subir(carpeta)))

    def test_barra_avanza_de_a_pedazos(self):
        salida = io.StringIO()
        barra = subir.Barra("subiendo", 100, salida=salida, es_terminal=True)
        for _ in range(4):
            barra.avanzar(25)
            barra.ultimo_dibujo = 0
        barra.terminar()
        dibujado = salida.getvalue()
        self.assertIn("50%", dibujado)
        self.assertIn("100%", dibujado)


class PruebaAgrupar(unittest.TestCase):

    def test_agrupa_por_id(self):
        objetos = [
            {"clave": "istincho/s01e03/maestra.m3u8", "tamano": 100},
            {"clave": "istincho/s01e03/720p/seg00000.ts", "tamano": 900},
            {"clave": "istincho/otro/maestra.m3u8", "tamano": 50},
        ]
        grupos = subir.agrupar_por_video(objetos, "istincho")
        self.assertEqual([g["id"] for g in grupos], ["otro", "s01e03"])
        por_id = {g["id"]: g for g in grupos}
        self.assertEqual(por_id["s01e03"]["bytes"], 1000)
        self.assertEqual(por_id["s01e03"]["archivos"], 2)


class PruebaBorradoEnTandas(unittest.TestCase):

    def test_mas_de_mil_claves_se_parten(self):
        # delete_objects acepta 1000 por llamada; dos horas de video a 6 s son
        # 1200 segmentos por calidad. Sin partir, R2 rechaza el pedido entero.
        llamadas = []

        class ClienteFalso:
            def delete_objects(self, Bucket, Delete):
                llamadas.append(len(Delete["Objects"]))

        claves = ["istincho/x/seg%05d.ts" % i for i in range(2500)]
        borradas = subir.borrar_objetos(ClienteFalso(), "sala-video", claves)
        self.assertEqual(borradas, 2500)
        self.assertEqual(llamadas, [1000, 1000, 500])


class PruebaListadoPaginado(unittest.TestCase):

    def test_sigue_el_continuation_token(self):
        # Una peli entera pasa los 1000 objetos: sin paginar, --listar y
        # --borrar verian la mitad del video.
        paginas = [
            {"Contents": [{"Key": "istincho/x/a", "Size": 1}], "IsTruncated": True,
             "NextContinuationToken": "t1"},
            {"Contents": [{"Key": "istincho/x/b", "Size": 2}], "IsTruncated": False},
        ]
        pedidos = []

        class ClienteFalso:
            def list_objects_v2(self, **argumentos):
                pedidos.append(argumentos)
                return paginas[len(pedidos) - 1]

        objetos = subir.listar_objetos(ClienteFalso(), "sala-video", "istincho")
        self.assertEqual([o["clave"] for o in objetos], ["istincho/x/a", "istincho/x/b"])
        self.assertEqual(pedidos[1]["ContinuationToken"], "t1")
        self.assertEqual(pedidos[0]["Prefix"], "istincho/")


class PruebaClienteR2(unittest.TestCase):

    def crear(self, config=None):
        capturado = {}

        def fabrica(servicio, **argumentos):
            capturado["servicio"] = servicio
            capturado.update(argumentos)
            return "cliente"

        def fabrica_config(**argumentos):
            capturado["config"] = argumentos
            return argumentos

        base = {"R2_ACCOUNT_ID": "cuenta123", "R2_ACCESS_KEY_ID": "id",
                "R2_SECRET_ACCESS_KEY": "secreto"}
        base.update(config or {})
        subir.crear_cliente(base, fabrica=fabrica, fabrica_config=fabrica_config)
        return capturado

    def test_endpoint_y_region_de_r2(self):
        capturado = self.crear()
        self.assertEqual(capturado["endpoint_url"], "https://cuenta123.r2.cloudflarestorage.com")
        self.assertEqual(capturado["region_name"], "auto")

    def test_pide_los_checksum_solo_cuando_hacen_falta(self):
        # boto3 >= 1.36 manda un CRC32 en cada PutObject y UploadPart aunque
        # nadie se lo pida. R2 hoy lo soporta (CRC-32 en modo COMPOSITE), asi
        # que no rompe; se deja en `when_required` porque es menos trabajo por
        # objeto y es lo que esta probado contra el doble. La opcion no existe
        # antes de botocore 1.36: por eso el piso de requirements.txt.
        config = self.crear()["config"]
        self.assertEqual(config["request_checksum_calculation"], "when_required")
        self.assertEqual(config["response_checksum_validation"], "when_required")
        self.assertEqual(config["signature_version"], "s3v4")


class PruebaAvisoAlServidor(unittest.TestCase):

    def falso(self, estado=200, cuerpo="{}"):
        pedidos = []

        class Respuesta:
            status = estado

            def read(self_inner):
                return cuerpo.encode()

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *a):
                return False

        def abrir(pedido, timeout=None):
            pedidos.append(pedido)
            if estado >= 400:
                raise urllib.error.HTTPError(
                    pedido.full_url, estado, "no", {}, io_falso(cuerpo))
            return Respuesta()

        return abrir, pedidos

    def test_manda_la_clave_de_subida_en_la_cabecera(self):
        abrir, pedidos = self.falso()
        config = {"URL_SERVIDOR": "https://sala.example/", "CLAVE_SUBIDA": "clave-secreta"}
        subir.avisar_video(config, {"id": "s01e03", "titulo": "T", "duracion": 1}, abrir=abrir)
        pedido = pedidos[0]
        self.assertEqual(pedido.full_url, "https://sala.example/api/videos")
        self.assertEqual(pedido.get_method(), "POST")
        # urllib normaliza los nombres de cabecera a Capitalizado.
        self.assertEqual(pedido.get_header("X-clave-subida"), "clave-secreta")
        self.assertEqual(json.loads(pedido.data)["id"], "s01e03")

    def test_un_error_del_servidor_dice_como_reintentar(self):
        abrir, _ = self.falso(estado=403, cuerpo="clave invalida")
        config = {"URL_SERVIDOR": "https://sala.example", "CLAVE_SUBIDA": "x"}
        with self.assertRaises(subir.Aviso) as caja:
            subir.avisar_video(config, {"id": "s01e03", "titulo": "T", "duracion": 12},
                               abrir=abrir)
        mensaje = str(caja.exception)
        self.assertIn("--avisar s01e03", mensaje)
        self.assertIn("ya esta en R2", mensaje)

    def test_borrado_manda_delete_y_tolera_404(self):
        abrir, pedidos = self.falso(estado=404, cuerpo="no existe")
        config = {"URL_SERVIDOR": "https://sala.example", "CLAVE_SUBIDA": "x"}
        self.assertEqual(subir.avisar_borrado(config, "s01e03", abrir=abrir), 404)
        self.assertEqual(pedidos[0].get_method(), "DELETE")
        self.assertEqual(pedidos[0].full_url, "https://sala.example/api/videos/s01e03")


def io_falso(texto):
    import io
    return io.BytesIO(texto.encode())


# ==========================================================================
# Doble local del API S3
# ==========================================================================

class ManejadorS3(BaseHTTPRequestHandler):
    """Lo minimo del API S3 que usa el script: PUT, GET, list_objects_v2 y
    DeleteObjects. Guarda todo en memoria y anota TODOS los pedidos, no solo
    los PUT: mirar una sola operacion da una seguridad falsa, porque boto3 no
    manda los mismos encabezados en todas."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    @property
    def deposito(self):
        return self.server.deposito

    def _anotar(self, metodo):
        with self.deposito["candado"]:
            self.deposito["pedidos"].append({
                "metodo": metodo,
                "camino": self.path,
                "encabezados": {k.lower(): v for k, v in self.headers.items()},
            })

    def _esperar_a_las_demas(self, clave):
        """Barrera para el test de orden: las subidas que no son la maestra se
        quedan trabadas hasta que llegaron todas. Sin esto, que la maestra
        quede ultima depende del scheduler y el test sale verde a veces
        aunque la invariante este rota."""
        esperados = self.deposito.get("esperados")
        if not esperados or clave.endswith("maestra.m3u8"):
            if clave.endswith("maestra.m3u8"):
                self.deposito["llegaron_todas"].set()
            return
        with self.deposito["candado"]:
            self.deposito["en_vuelo"] += 1
            if self.deposito["en_vuelo"] >= esperados:
                self.deposito["llegaron_todas"].set()
        self.deposito["llegaron_todas"].wait(timeout=10)

    def _clave(self):
        camino = self.path.split("?", 1)[0].lstrip("/")
        bucket, _, clave = camino.partition("/")
        return bucket, urllib.request.unquote(clave)

    def _responder(self, codigo, cuerpo=b"", tipo="application/xml"):
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        if cuerpo:
            self.wfile.write(cuerpo)

    def do_PUT(self):
        bucket, clave = self._clave()
        largo = int(self.headers.get("Content-Length") or 0)
        datos = self.rfile.read(largo)
        self._anotar("PUT")
        self._esperar_a_las_demas(clave)
        with self.deposito["candado"]:
            self.deposito["objetos"][clave] = {
                "datos": datos,
                "ContentType": self.headers.get("Content-Type"),
                "CacheControl": self.headers.get("Cache-Control"),
            }
            self.deposito["orden"].append(clave)
        self.send_response(200)
        self.send_header("ETag", '"%s"' % base64.b16encode(b"x").decode())
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._anotar("GET")
        if "list-type=2" in self.path:
            return self._listar()
        bucket, clave = self._clave()
        objeto = self.deposito["objetos"].get(clave)
        if objeto is None:
            return self._responder(404, b"<Error><Code>NoSuchKey</Code></Error>")
        self._responder(200, objeto["datos"], objeto["ContentType"] or "application/octet-stream")

    def _listar(self):
        consulta = dict(
            par.split("=", 1) for par in self.path.split("?", 1)[1].split("&") if "=" in par)
        prefijo = urllib.request.unquote(consulta.get("prefix", ""))
        claves = sorted(k for k in self.deposito["objetos"] if k.startswith(prefijo))
        tope = int(consulta.get("max-keys", 1000))
        desde = urllib.request.unquote(consulta.get("continuation-token", ""))
        if desde:
            claves = [k for k in claves if k > desde]
        tanda, cortado = claves[:tope], len(claves) > tope
        piezas = ["<?xml version='1.0' encoding='UTF-8'?>",
                  "<ListBucketResult xmlns='http://s3.amazonaws.com/doc/2006-03-01/'>",
                  "<Name>sala-video</Name>",
                  "<IsTruncated>%s</IsTruncated>" % ("true" if cortado else "false")]
        if cortado:
            piezas.append("<NextContinuationToken>%s</NextContinuationToken>" % tanda[-1])
        for clave in tanda:
            piezas.append("<Contents><Key>%s</Key><Size>%d</Size></Contents>"
                          % (clave, len(self.deposito["objetos"][clave]["datos"])))
        piezas.append("</ListBucketResult>")
        self._responder(200, "".join(piezas).encode())

    def do_POST(self):
        self._anotar("POST")
        if "delete" not in self.path.split("?", 1)[-1]:
            return self._responder(400, b"<Error><Code>NoSePuede</Code></Error>")
        largo = int(self.headers.get("Content-Length") or 0)
        cuerpo = self.rfile.read(largo)
        raiz = ET.fromstring(cuerpo)
        borradas = []
        for objeto in raiz.iter():
            if objeto.tag.endswith("Key") and objeto.text:
                self.deposito["objetos"].pop(objeto.text, None)
                borradas.append(objeto.text)
        self.deposito["borrados"].append(borradas)
        self._responder(200, b"<?xml version='1.0'?><DeleteResult></DeleteResult>")


class S3Local:
    def __init__(self, esperados=None):
        self.deposito = {
            "objetos": {}, "pedidos": [], "borrados": [], "orden": [],
            "candado": threading.Lock(), "esperados": esperados,
            "en_vuelo": 0, "llegaron_todas": threading.Event(),
        }
        self.servidor = ThreadingHTTPServer(("127.0.0.1", 0), ManejadorS3)
        self.servidor.deposito = self.deposito
        self.hilo = threading.Thread(target=self.servidor.serve_forever, daemon=True)

    def __enter__(self):
        self.hilo.start()
        return self

    def __exit__(self, *a):
        self.servidor.shutdown()
        self.servidor.server_close()

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.servidor.server_address[1]


def hay_boto3():
    try:
        import boto3  # noqa: F401
        return True
    except ImportError:
        return False


@unittest.skipUnless(
    hay_boto3(),
    "sin boto3 (python -m pip install -r herramientas/requirements.txt): "
    "se saltean las pruebas contra el doble del API S3")
class PruebaContraDobleS3(unittest.TestCase):
    """Estas corren un cliente boto3 de verdad contra un S3 de mentira.

    No prueban que R2 acepte lo que mandamos (para eso hace falta el bucket
    real, que todavia no existe), pero si prueban lo que sale por el cable:
    claves, Content-Type, Cache-Control y que no viajen los encabezados de
    checksum que R2 no implementa.
    """

    def carpeta_hls(self):
        raiz = Path(tempfile.mkdtemp())
        for calidad in ("720p", "1080p"):
            (raiz / calidad).mkdir()
            (raiz / calidad / "lista.m3u8").write_text("#EXTM3U\nseg00000.ts\n")
            (raiz / calidad / "seg00000.ts").write_bytes(b"\x47" * 4096)
        (raiz / "subtitulos" / "spa").mkdir(parents=True)
        (raiz / "subtitulos" / "spa" / "subtitulos.vtt").write_text("WEBVTT\n")
        (raiz / "maestra.m3u8").write_text("#EXTM3U\n")
        return raiz

    def config(self, s3):
        return {
            "R2_ENDPOINT": s3.url,
            "R2_ACCOUNT_ID": "cuenta",
            "R2_ACCESS_KEY_ID": "clave-de-prueba",
            "R2_SECRET_ACCESS_KEY": "secreto-de-prueba",
            "R2_BUCKET": "sala-video",
        }

    def test_sube_el_arbol_entero_con_claves_y_tipos_correctos(self):
        with S3Local() as s3:
            cliente = subir.crear_cliente(self.config(s3))
            resultado = subir.subir_carpeta(
                cliente, "sala-video", "istincho", "s01e03", self.carpeta_hls(), hilos=3)

            objetos = s3.deposito["objetos"]
            self.assertEqual(resultado["archivos"], 6)
            self.assertIn("istincho/s01e03/maestra.m3u8", objetos)
            self.assertIn("istincho/s01e03/720p/seg00000.ts", objetos)
            self.assertIn("istincho/s01e03/subtitulos/spa/subtitulos.vtt", objetos)
            for clave in objetos:
                self.assertNotIn("\\", clave)
            self.assertEqual(objetos["istincho/s01e03/maestra.m3u8"]["ContentType"],
                             "application/vnd.apple.mpegurl")
            self.assertEqual(objetos["istincho/s01e03/720p/seg00000.ts"]["ContentType"],
                             "video/mp2t")
            self.assertEqual(
                objetos["istincho/s01e03/subtitulos/spa/subtitulos.vtt"]["ContentType"],
                "text/vtt")
            # El valor escrito a mano: comparar contra subir.CACHE_LARGO es
            # comparar la constante consigo misma y pasa igual con `no-store`.
            self.assertEqual(objetos["istincho/s01e03/maestra.m3u8"]["CacheControl"],
                             "public, max-age=31536000, immutable")

    def test_la_maestra_se_sube_ultima(self):
        # Si la maestra existiera antes que los segmentos, alguien que abra la
        # sala mientras se sube veria un video incompleto.
        #
        # Determinista: el doble traba los cinco PUT que no son la maestra
        # hasta que llegaron los cinco, y se sube con un hilo mas que
        # archivos. Si la maestra saliera en el mismo lote, su PUT terminaria
        # ANTES que los trabados y no quedaria ultima nunca.
        carpeta = self.carpeta_hls()
        cuantas = len([i for i in subir.archivos_a_subir(carpeta)
                       if i[1] != "maestra.m3u8"])
        with S3Local(esperados=cuantas) as s3:
            cliente = subir.crear_cliente(self.config(s3))
            subir.subir_carpeta(
                cliente, "sala-video", "istincho", "s01e03", carpeta,
                hilos=cuantas + 1)
            self.assertEqual(s3.deposito["orden"][-1], "istincho/s01e03/maestra.m3u8")
            self.assertEqual(len(s3.deposito["orden"]), cuantas + 1)

    def test_los_put_van_sin_checksum_y_el_delete_lo_lleva_igual(self):
        """Mira TODO el cable, no solo los PUT.

        Medido contra boto3 1.43 (herramientas/, experimento del verificador):

        - PutObject: sin el Config viajan `x-amz-sdk-checksum-algorithm: CRC32`
          y `x-amz-checksum-crc32`; con `when_required`, ninguno. Esa mitad es
          la que caza que alguien saque el Config.
        - DeleteObjects: manda el CRC32 SIEMPRE, tenga o no el Config, porque
          el modelo de S3 lo marca `requestChecksumRequired` y `when_required`
          no apaga los obligatorios. No es un problema: la tabla "Checksum
          Types" de la pagina "S3 API compatibility" de Cloudflare
          (actualizada el 31/07/2026) lista CRC-32 como soportado. Pero si
          alguien creyera que aca NO viaja ningun checksum, `--borrar` seria
          lo primero en romperse contra R2 y este test no lo veria. Por eso
          se assertea lo que de verdad sale.
        """
        with S3Local() as s3:
            cliente = subir.crear_cliente(self.config(s3))
            subir.subir_carpeta(
                cliente, "sala-video", "istincho", "s01e03", self.carpeta_hls(), hilos=2)
            claves = [o["clave"] for o in
                      subir.listar_objetos(cliente, "sala-video", "istincho/s01e03")]
            subir.borrar_objetos(cliente, "sala-video", claves)

            puestas = [p for p in s3.deposito["pedidos"] if p["metodo"] == "PUT"]
            borrados = [p for p in s3.deposito["pedidos"]
                        if p["metodo"] == "POST" and "delete" in p["camino"]]
            self.assertTrue(puestas)
            self.assertTrue(borrados)

            for pedido in puestas:
                nombres = set(pedido["encabezados"])
                self.assertNotIn("x-amz-sdk-checksum-algorithm", nombres,
                                 msg="volvio el checksum al PutObject: "
                                     "falta el Config de crear_cliente")
                self.assertFalse([n for n in nombres if n.startswith("x-amz-checksum-")],
                                 msg=str(sorted(nombres)))

            for pedido in borrados:
                self.assertEqual(pedido["encabezados"].get("x-amz-sdk-checksum-algorithm"),
                                 "CRC32",
                                 msg="DeleteObjects cambio de comportamiento: "
                                     "revisar la nota de crear_cliente")
                self.assertIn("x-amz-checksum-crc32", pedido["encabezados"])

    def test_listar_y_borrar_ida_y_vuelta(self):
        with S3Local() as s3:
            cliente = subir.crear_cliente(self.config(s3))
            subir.subir_carpeta(
                cliente, "sala-video", "istincho", "s01e03", self.carpeta_hls(), hilos=2)
            subir.subir_carpeta(
                cliente, "sala-video", "istincho", "otro", self.carpeta_hls(), hilos=2)

            grupos = subir.agrupar_por_video(
                subir.listar_objetos(cliente, "sala-video", "istincho"), "istincho")
            self.assertEqual(sorted(g["id"] for g in grupos), ["otro", "s01e03"])

            claves = [o["clave"] for o in
                      subir.listar_objetos(cliente, "sala-video", "istincho/s01e03")]
            subir.borrar_objetos(cliente, "sala-video", claves)

            quedan = subir.agrupar_por_video(
                subir.listar_objetos(cliente, "sala-video", "istincho"), "istincho")
            self.assertEqual([g["id"] for g in quedan], ["otro"])

    def test_borrar_por_prefijo_no_se_lleva_un_id_parecido(self):
        # `istincho/s01` como prefijo tambien matchea `istincho/s01e03`: si
        # listar_objetos no agregara la barra final, `--borrar s01` se
        # llevaria puesto el otro video.
        with S3Local() as s3:
            cliente = subir.crear_cliente(self.config(s3))
            subir.subir_carpeta(
                cliente, "sala-video", "istincho", "s01", self.carpeta_hls(), hilos=2)
            subir.subir_carpeta(
                cliente, "sala-video", "istincho", "s01e03", self.carpeta_hls(), hilos=2)

            args = mock.Mock(borrar="s01", sala="istincho", si=True, sin_avisar=True)
            with mock.patch.object(subir, "crear_cliente", return_value=cliente):
                subir.accion_borrar(args, self.config(s3))

            quedan = subir.agrupar_por_video(
                subir.listar_objetos(cliente, "sala-video", "istincho"), "istincho")
            self.assertEqual([g["id"] for g in quedan], ["s01e03"])

# ==========================================================================
# F1: mucho ruido por stderr no puede colgar el script
# ==========================================================================

CODIGO_HIJO_RUIDOSO = (
    "import sys\n"
    "ruido, codigo, marca = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]\n"
    "sys.stderr.write('r' * ruido)\n"
    "sys.stderr.flush()\n"
    "sys.stdout.write('out_time=00:00:10.000000' + chr(10))\n"
    "sys.stdout.flush()\n"
    "sys.stderr.write(chr(10) + marca + chr(10))\n"
    "sys.stderr.flush()\n"
    "sys.exit(codigo)\n"
)


class PruebaFfmpegRuidoso(unittest.TestCase):
    """ffmpeg escribiendo mucho por stderr no puede dejar el script colgado.

    Con stdout y stderr los dos en un pipe y un solo lector se arma un abrazo
    mortal: el hijo llena el buffer del pipe de stderr y se bloquea; al
    bloquearse deja de emitir progreso por stdout; el padre se queda leyendo
    stdout para siempre. Medido en Windows: 4096 bytes pasan, 8192 cuelgan, y
    un rip de 2 h con ruido de decodificacion pasa los 8 KB con unas cien
    lineas de aviso.

    El hijo es un script de Python en vez de ffmpeg: hace falta un proceso
    que escupa mucho stderr, no un video.
    """

    MARCA = "ULTIMA-LINEA-DEL-ERROR"

    @classmethod
    def setUpClass(cls):
        cls.carpeta = Path(tempfile.mkdtemp())
        cls.hijo = cls.carpeta / "hijo_ruidoso.py"
        cls.hijo.write_text(CODIGO_HIJO_RUIDOSO, encoding="utf-8")

    def correr(self, ruido, codigo=0, limite=60, salida=None):
        """Corre en un hilo aparte con tope de tiempo: si se cuelga, el test
        falla en vez de dejar la suite colgada para siempre."""
        comando = [sys.executable, str(self.hijo), str(ruido), str(codigo), self.MARCA]
        caja = {"salida": salida if salida is not None else io.StringIO()}
        listo = threading.Event()

        def trabajo():
            try:
                subir.correr_ffmpeg_con_progreso(comando, 10.0, salida=caja["salida"])
                caja["fin"] = "ok"
            except subir.Aviso as aviso:
                caja["fin"] = "aviso"
                caja["mensaje"] = str(aviso)
            except BaseException as error:      # noqa: BLE001
                caja["fin"] = "error"
                caja["mensaje"] = repr(error)
            listo.set()

        threading.Thread(target=trabajo, daemon=True).start()
        if not listo.wait(limite):
            self.fail(
                "correr_ffmpeg_con_progreso no volvio en %d s con %d bytes de "
                "stderr: el padre se quedo leyendo stdout mientras el hijo se "
                "bloqueaba escribiendo stderr." % (limite, ruido))
        return caja

    def test_con_poco_ruido_termina(self):
        # Control del arnes: con 100 bytes no se cuelga ni el codigo roto. Si
        # este fallara, los otros dos no estarian probando lo que dicen.
        self.assertEqual(self.correr(100)["fin"], "ok")

    def test_mas_ruido_que_el_buffer_del_pipe_tampoco_cuelga(self):
        self.assertEqual(self.correr(300000)["fin"], "ok")

    def test_el_error_llega_entero_aunque_sea_largo(self):
        # La marca se escribe DESPUES de los 300 KB de ruido: si aparece en el
        # mensaje, se leyo stderr completo y no un pedazo.
        caja = self.correr(300000, codigo=1)
        self.assertEqual(caja["fin"], "aviso")
        self.assertIn("codigo 1", caja["mensaje"])
        self.assertIn(self.MARCA, caja["mensaje"])

    def test_la_barra_sigue_marcando_el_progreso(self):
        salida = io.StringIO()
        self.assertEqual(self.correr(300000, salida=salida)["fin"], "ok")
        self.assertIn("100%", salida.getvalue())


# ==========================================================================
# F2: los subtitulos, atados al reloj del MPEG-TS
# ==========================================================================

VTT_DE_MUESTRA = (
    "WEBVTT\n"
    "\n"
    "00:01.000 --> 00:05.000\n"
    "primera linea\n"
    "\n"
    "00:06.000 --> 00:09.000\n"
    "segunda linea\n"
)


def segundos_de_local(texto):
    segundos = 0.0
    for parte in texto.split(":"):
        segundos = segundos * 60 + float(parte)
    return segundos


def donde_cae_la_cue(vtt, segundo_de_la_cue, arranque_del_ts):
    """Modelo de lo que hace hls.js con un WebVTT que va aparte del HLS.

    `src/utils/webvtt-parser.ts` lee X-TIMESTAMP-MAP y corre todas las cues
    por la diferencia entre el MPEGTS del encabezado y el PTS con el que
    arranca el fragmento (initPTS). Sin encabezado toma MPEGTS 0, que es como
    afirmar que el video empieza en el segundo 0 cuando en realidad empieza en
    1,5. Una cue que cae en negativo queda antes del comienzo y no se muestra
    nunca.

    Devuelve el segundo de la linea de tiempo de la playlist en el que se ve
    esa cue.
    """
    mapeado, local = 0.0, 0.0
    encontrado = re.search(r"^X-TIMESTAMP-MAP=(.+)$", str(vtt), re.M)
    if encontrado:
        for parte in encontrado.group(1).split(","):
            parte = parte.strip()
            if parte.startswith("MPEGTS:"):
                mapeado = int(parte[len("MPEGTS:"):]) / 90000.0
            elif parte.startswith("LOCAL:"):
                local = segundos_de_local(parte[len("LOCAL:"):])
    return segundo_de_la_cue + (mapeado - local) - arranque_del_ts


class PruebaAlineacionDeSubtitulos(unittest.TestCase):

    # Cuatro corridas distintas de ffmpeg, cuatro arranques: el colchon del
    # muxer no es una constante que se pueda hardcodear, hay que medirlo.
    ARRANQUES = (1.445, 1.459, 1.480, 1.512)

    def test_el_modelo_detecta_el_bug_que_venimos_a_arreglar(self):
        # Control del modelo: con el VTT como lo deja ffmpeg (sin encabezado)
        # la primera cue cae en negativo -o sea, desaparece- y la segunda se
        # adelanta 1,445 s. Son exactamente los numeros medidos.
        self.assertAlmostEqual(donde_cae_la_cue(VTT_DE_MUESTRA, 1.0, 1.445), -0.445, places=3)
        self.assertAlmostEqual(donde_cae_la_cue(VTT_DE_MUESTRA, 6.0, 1.445), 4.555, places=3)

    def test_con_el_encabezado_cada_cue_cae_en_su_segundo(self):
        for arranque in self.ARRANQUES:
            atado = subir.poner_timestamp_map(VTT_DE_MUESTRA, arranque)
            for cue in (1.0, 6.0):
                self.assertAlmostEqual(
                    donde_cae_la_cue(atado, cue, arranque), cue, places=3,
                    msg="arranque %s, cue %s" % (arranque, cue))

    def test_la_primera_linea_no_desaparece(self):
        for arranque in self.ARRANQUES:
            atado = subir.poner_timestamp_map(VTT_DE_MUESTRA, arranque)
            self.assertGreater(donde_cae_la_cue(atado, 1.0, arranque), 0,
                               msg="arranque %s" % arranque)

    def test_el_encabezado_usa_el_reloj_de_90_khz(self):
        self.assertEqual(subir.encabezado_timestamp_map(1.0),
                         "X-TIMESTAMP-MAP=MPEGTS:90000,LOCAL:00:00:00.000")
        self.assertEqual(subir.encabezado_timestamp_map(1.512),
                         "X-TIMESTAMP-MAP=MPEGTS:136080,LOCAL:00:00:00.000")

    def test_el_encabezado_va_pegado_a_la_linea_webvtt(self):
        # El WebVTT quiere los encabezados antes de la primera linea en
        # blanco. Suelto en el medio del archivo no lo lee nadie.
        lineas = subir.poner_timestamp_map(VTT_DE_MUESTRA, 1.5).split("\n")
        self.assertEqual(lineas[0], "WEBVTT")
        self.assertTrue(lineas[1].startswith("X-TIMESTAMP-MAP="))
        self.assertEqual(lineas[2], "")

    def test_no_se_duplica_si_ya_estaba(self):
        una = subir.poner_timestamp_map(VTT_DE_MUESTRA, 1.5)
        dos = subir.poner_timestamp_map(una, 1.5)
        self.assertEqual(una, dos)
        self.assertEqual(dos.count("X-TIMESTAMP-MAP"), 1)

    def test_un_vtt_con_saltos_de_windows_no_se_rompe(self):
        atado = subir.poner_timestamp_map(VTT_DE_MUESTRA.replace("\n", "\r\n"), 1.5)
        self.assertNotIn("\r", atado)
        self.assertAlmostEqual(donde_cae_la_cue(atado, 1.0, 1.5), 1.0, places=3)


class PruebaMedirDesfase(unittest.TestCase):

    def carpeta_con_segmento(self):
        raiz = Path(tempfile.mkdtemp())
        (raiz / "720p").mkdir()
        (raiz / "720p" / "seg00000.ts").write_bytes(b"\x47" * 188)
        return raiz

    def ffprobe(self, datos, codigo=0):
        def correr(comando, **argumentos):
            self.pedido = [str(c) for c in comando]
            return Corrido(codigo, json.dumps(datos))
        return correr

    def test_toma_el_arranque_del_primer_segmento(self):
        # hls.js usa el menor PTS del fragmento (video o audio), que es lo que
        # ffprobe informa como format.start_time.
        medido = subir.medir_desfase_ts(
            self.carpeta_con_segmento(),
            correr=self.ffprobe({"format": {"start_time": "1.512000"},
                                 "streams": [{"start_time": "1.533333"}]}))
        self.assertAlmostEqual(medido, 1.512, places=3)
        self.assertTrue(self.pedido[0] == "ffprobe")
        self.assertTrue(self.pedido[-1].endswith("seg00000.ts"))

    def test_sin_segmentos_devuelve_none(self):
        self.assertIsNone(subir.medir_desfase_ts(Path(tempfile.mkdtemp())))

    def test_si_ffprobe_falla_devuelve_none_en_vez_de_inventar(self):
        self.assertIsNone(subir.medir_desfase_ts(
            self.carpeta_con_segmento(), correr=self.ffprobe({}, codigo=1)))

    def test_si_no_hay_start_time_devuelve_none(self):
        self.assertIsNone(subir.medir_desfase_ts(
            self.carpeta_con_segmento(), correr=self.ffprobe({"format": {}, "streams": []})))


def hay_ffmpeg():
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@unittest.skipUnless(hay_ffmpeg(), "sin ffmpeg/ffprobe en el PATH")
class PruebaCircuitoRealDeFfmpeg(unittest.TestCase):
    """El unico test que corre ffmpeg de verdad.

    Los subtitulos adelantados no se ven en ningun mock: salen de que el muxer
    MPEG-TS arranca en ~1,5 s y el WebVTT en 0. Hace falta un segmento de
    verdad para medirlo. La fuente son 8 segundos de `testsrc`, asi que el
    test tarda un par de segundos, no minutos.
    """

    def fuente(self, carpeta):
        subtitulos = carpeta / "subs.srt"
        subtitulos.write_text(
            "1\n00:00:01,000 --> 00:00:05,000\nprimera linea\n\n"
            "2\n00:00:06,000 --> 00:00:07,500\nsegunda linea\n",
            encoding="utf-8")
        entrada = carpeta / "prueba.mkv"
        hecho = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=8",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
             "-i", str(subtitulos),
             "-map", "0:v", "-map", "1:a", "-map", "2:s",
             "-c:v", "libx264", "-preset", "ultrafast",
             "-c:a", "aac", "-c:s", "srt",
             "-metadata:s:s:0", "language=spa", str(entrada)],
            capture_output=True, text=True, encoding="utf-8", errors="replace")
        self.assertEqual(hecho.returncode, 0, (hecho.stderr or "")[-600:])
        return entrada

    def test_las_cues_quedan_alineadas_con_los_segmentos_de_verdad(self):
        carpeta = Path(tempfile.mkdtemp())
        entrada = self.fuente(carpeta)
        trabajo = carpeta / "hls"
        datos = subir.probar_fuente(entrada)
        calidades = subir.calidades_aplicables(datos["altura"])
        for altura, _, _, _ in calidades:
            (trabajo / subir.nombre_de_calidad(altura)).mkdir(parents=True, exist_ok=True)
        subir.correr_ffmpeg_con_progreso(
            subir.construir_comando_ffmpeg(
                entrada, trabajo, calidades, datos["indice_audio"]),
            datos["duracion"], salida=io.StringIO())

        arranque = subir.medir_desfase_ts(trabajo)
        self.assertIsNotNone(arranque, "no se pudo medir el arranque del TS")
        # El colchon del muxer existe y no es cero. Este es el numero que hace
        # falta y que el codigo viejo no miraba nunca.
        self.assertGreater(arranque, 0.5)
        self.assertLess(arranque, 3.0)

        pistas = subir.extraer_subtitulos(
            entrada, trabajo, datos["subtitulos"], desfase=arranque)
        self.assertEqual(len(pistas), 1)
        vtt = (trabajo / pistas[0]["carpeta"] / "subtitulos.vtt").read_text(encoding="utf-8")

        # Contra el arranque medido de verdad: con el encabezado la cue cae en
        # su segundo; sin el (como salia antes) la primera linea desaparece.
        self.assertAlmostEqual(donde_cae_la_cue(vtt, 1.0, arranque), 1.0, places=2)
        self.assertLess(donde_cae_la_cue(VTT_DE_MUESTRA, 1.0, arranque), 0)

        # Y el MPEGTS del encabezado es el arranque real del segmento, no un
        # numero copiado de otra corrida.
        puesto = int(re.search(r"MPEGTS:(\d+)", vtt).group(1))
        self.assertAlmostEqual(puesto / 90000.0, arranque, places=3)


# ==========================================================================
# F3: lo que cuesta plata y lo que rompe el video
# ==========================================================================

class PruebaLoQueCuestaPlata(unittest.TestCase):
    """Los numeros del comando de ffmpeg son el presupuesto del bucket.

    Todo lo de aca esta escrito a mano y no leido de `subir.CALIDADES`: un
    test que compara la constante contra si misma pasa igual despues de
    cambiarla, que es justo el error que hay que cazar.
    """

    def comando(self, calidades=None, indice_audio=0):
        return subir.construir_comando_ffmpeg(
            "entrada.mkv", Path("/t"), calidades or list(subir.CALIDADES), indice_audio)

    def valor(self, comando, bandera):
        return comando[comando.index(bandera) + 1]

    def test_las_tasas_son_las_del_presupuesto_de_10_gb(self):
        # Una peli de 2 h a 5000k pesa 4,5 GB; a 8000k, 7,2 GB. Es lo caro y
        # lo que no se nota hasta que R2 empieza a cobrar.
        self.assertEqual(subir.CALIDADES, (
            (720, "2500k", "2675k", "3750k"),
            (1080, "5000k", "5350k", "7500k"),
        ))

    def test_cada_calidad_manda_su_bitrate_maxrate_y_bufsize(self):
        # Sin maxrate/bufsize, libx264 con -b:v se pasa de largo en las
        # escenas movidas y el segmento de 6 s deja de entrar en el ancho de
        # banda que el reproductor eligio.
        comando = self.comando()
        esperado = [("2500k", "2675k", "3750k"), ("5000k", "5350k", "7500k")]
        for indice, (bitrate, maxrate, bufsize) in enumerate(esperado):
            self.assertEqual(self.valor(comando, "-b:v:%d" % indice), bitrate)
            self.assertEqual(self.valor(comando, "-maxrate:v:%d" % indice), maxrate)
            self.assertEqual(self.valor(comando, "-bufsize:v:%d" % indice), bufsize)

    def test_la_playlist_lleva_todos_los_segmentos(self):
        # `-hls_list_size 5` deja una peli de 2 h con cinco segmentos en la
        # playlist: el video queda roto y ffmpeg no dice nada.
        self.assertEqual(self.valor(self.comando(), "-hls_list_size"), "0")

    def test_los_segmentos_son_mpegts(self):
        # Con fmp4, ffmpeg escribe fragmentos de MP4 dentro de archivos .ts
        # (que se suben como video/mp2t) y hace falta un init.mp4 que nadie
        # sube. Ademas cambia el reloj con el que se alinean los subtitulos.
        self.assertEqual(self.valor(self.comando(), "-hls_segment_type"), "mpegts")

    def test_la_maestra_se_llama_maestra(self):
        # Es la URL que se le manda al servidor y la que abre la Sala.
        self.assertEqual(self.valor(self.comando(), "-master_pl_name"), "maestra.m3u8")

    def test_cada_calidad_escribe_en_su_propia_carpeta(self):
        # Sin %v las dos calidades escriben en el mismo lugar: un solo juego
        # de segmentos con los dos bitrates mezclados.
        comando = self.comando()
        self.assertIn("%v", str(self.valor(comando, "-hls_segment_filename")))
        self.assertIn("%v", str(comando[-1]))

    def test_el_cache_es_de_un_ano_e_inmutable(self):
        # Con `no-store`, cada espectador vuelve a pedir cada segmento cada
        # vez: adios a las 10 millones de lecturas gratis.
        self.assertEqual(subir.CACHE_LARGO, "public, max-age=31536000, immutable")


class PruebaFuenteChica(unittest.TestCase):

    def test_una_fuente_de_480_no_paga_el_bitrate_de_un_720(self):
        # Los bits van con los pixeles: (480/720)^2 = 0,444, y 2500k * 0,444
        # da 1100k. Antes heredaba los 2500k del escalon de 720p y gastaba
        # mas del doble de lo necesario en un bucket de 10 GB.
        self.assertEqual(subir.calidades_aplicables(480),
                         [(480, "1100k", "1177k", "1650k")])

    def test_la_tasa_baja_cuando_baja_la_altura(self):
        tasas = [subir.kbps(subir.calidades_aplicables(a)[0][1])
                 for a in (576, 480, 360, 240)]
        self.assertEqual(tasas, sorted(tasas, reverse=True))
        self.assertTrue(all(t < 2500 for t in tasas), msg=str(tasas))

    def test_hay_un_piso_para_que_no_quede_ilegible(self):
        self.assertGreaterEqual(subir.kbps(subir.calidades_aplicables(90)[0][1]), 400)

    def test_una_fuente_grande_usa_la_tabla_sin_tocarla(self):
        self.assertEqual(subir.calidades_aplicables(1080), list(subir.CALIDADES))
        self.assertEqual(subir.calidades_aplicables(720), [(720, "2500k", "2675k", "3750k")])


# ==========================================================================
# Dobles para las acciones completas
# ==========================================================================

class Corrido:
    """Lo que devuelve subprocess.run, en chiquito."""

    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class RespuestaFalsa:
    def __init__(self, status=200, cuerpo="{}"):
        self.status = status
        self.cuerpo = cuerpo

    def read(self):
        return self.cuerpo.encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class ClienteFalsoR2:
    """R2 de mentira en un diccionario, para las acciones completas.

    La firma SigV4 y los encabezados del cable los cubre PruebaContraDobleS3
    con boto3 de verdad; aca lo que importa es el flujo. Un valor entero en
    vez de bytes significa "un objeto de ese tamano" (para no reservar 9 GB
    de memoria en la prueba de --listar).
    """

    def __init__(self, objetos=None):
        self.objetos = dict(objetos or {})
        self.borrados = []
        self.subidos = []
        self.listados = []

    def _tamano(self, clave):
        valor = self.objetos[clave]
        return valor if isinstance(valor, int) else len(valor)

    def upload_file(self, ruta, bucket, clave, ExtraArgs=None, Callback=None):
        datos = Path(ruta).read_bytes()
        self.objetos[clave] = datos
        self.subidos.append((clave, ExtraArgs or {}))
        if Callback is not None:
            Callback(len(datos))

    def list_objects_v2(self, Bucket, Prefix="", MaxKeys=1000, ContinuationToken=None):
        self.listados.append(Prefix)
        claves = sorted(c for c in self.objetos if c.startswith(Prefix))
        return {"Contents": [{"Key": c, "Size": self._tamano(c)} for c in claves],
                "IsTruncated": False}

    def delete_objects(self, Bucket, Delete):
        for objeto in Delete["Objects"]:
            self.objetos.pop(objeto["Key"], None)
            self.borrados.append(objeto["Key"])
        return {}

    def get_object(self, Bucket, Key):
        valor = self.objetos[Key]
        return {"Body": io.BytesIO(b"" if isinstance(valor, int) else valor)}


FUENTE_FALSA = {
    "format": {"duration": "2712.048"},
    "streams": [
        {"codec_type": "video", "codec_name": "h264", "height": 1080},
        {"codec_type": "audio", "codec_name": "aac", "disposition": {"default": 1}},
        {"codec_type": "subtitle", "codec_name": "subrip",
         "tags": {"language": "spa"}, "disposition": {"default": 1}},
    ],
}


def ffmpeg_de_mentira(comando, duracion, etiqueta="convirtiendo", salida=None):
    """Deja el arbol de archivos que dejaria ffmpeg, sin ffmpeg.

    Escribe la maestra con barras invertidas a proposito: es lo que ffmpeg
    escribe en Windows y hay que ver que el script lo normalice.
    """
    comando = [str(c) for c in comando]
    trabajo = Path(comando[-1]).parent.parent
    mapa = comando[comando.index("-var_stream_map") + 1]
    lineas = ["#EXTM3U", "#EXT-X-VERSION:6"]
    for parte in mapa.split(" "):
        nombre = parte.split("name:")[1]
        carpeta = trabajo / nombre
        carpeta.mkdir(parents=True, exist_ok=True)
        (carpeta / "lista.m3u8").write_text("#EXTM3U\nseg00000.ts\n", encoding="utf-8")
        (carpeta / "seg00000.ts").write_bytes(b"\x47" * 4096)
        lineas.append("#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1x" + nombre[:-1])
        lineas.append(nombre + "\\lista.m3u8")
    (trabajo / "maestra.m3u8").write_text("\n".join(lineas) + "\n", encoding="utf-8")


def subprocess_de_mentira(comando, **argumentos):
    """ffprobe (del archivo y del segmento) y la extraccion de subtitulos."""
    comando = [str(c) for c in comando]
    if comando[0] == "ffprobe":
        if comando[-1].endswith(".ts"):
            return Corrido(0, json.dumps({"format": {"start_time": "1.512000"},
                                          "streams": [{"start_time": "1.533333"}]}))
        return Corrido(0, json.dumps(FUENTE_FALSA))
    if "-c:s" in comando:
        Path(comando[-1]).write_text(VTT_DE_MUESTRA, encoding="utf-8")
        return Corrido(0)
    raise AssertionError("comando inesperado en la prueba: " + " ".join(comando))


CONFIG_DE_PRUEBA = {
    "R2_BUCKET": "sala-video",
    "R2_URL_PUBLICA": "https://pub-x.r2.dev",
    "R2_ACCOUNT_ID": "cuenta", "R2_ACCESS_KEY_ID": "id", "R2_SECRET_ACCESS_KEY": "secreto",
    "URL_SERVIDOR": "https://sala.example", "CLAVE_SUBIDA": "clave-secreta",
    "SALA_SLUG": "istincho",
}


# ==========================================================================
# F3: la accion de subir entera, que es el entregable
# ==========================================================================

class PruebaAccionSubir(unittest.TestCase):
    """El cuerpo del POST /api/videos no tenia un solo test.

    Es lo que el servidor guarda y lo que la Sala usa para reproducir: si sale
    incompleto o con la URL equivocada, el video esta en R2 y no lo encuentra
    nadie.
    """

    def correr(self, extra=(), cliente=None, estado=200):
        carpeta = Path(tempfile.mkdtemp())
        entrada = carpeta / "S01E03.mkv"
        entrada.write_bytes(b"esto no lo mira nadie: ffmpeg esta doblado")
        cliente = ClienteFalsoR2() if cliente is None else cliente
        pedidos = []

        def abrir(pedido, timeout=None):
            pedidos.append(pedido)
            return RespuestaFalsa(estado)

        args = subir.armar_parser().parse_args(
            [str(entrada), "--trabajo", str(carpeta)] + list(extra))
        with mock.patch.object(subir, "comprobar_programas", lambda *a: None), \
                mock.patch.object(subir.subprocess, "run", subprocess_de_mentira), \
                mock.patch.object(subir, "correr_ffmpeg_con_progreso", ffmpeg_de_mentira), \
                mock.patch.object(subir, "crear_cliente", return_value=cliente), \
                mock.patch.object(subir.urllib.request, "urlopen", abrir), \
                contextlib.redirect_stdout(io.StringIO()) as impreso:
            codigo = subir.accion_subir(args, dict(CONFIG_DE_PRUEBA))
        return {
            "codigo": codigo,
            "cuerpo": json.loads(pedidos[0].data) if pedidos else None,
            "pedidos": pedidos,
            "cliente": cliente,
            "salida": impreso.getvalue(),
        }

    def test_el_cuerpo_lleva_todo_lo_que_el_servidor_guarda(self):
        cuerpo = self.correr()["cuerpo"]
        self.assertEqual(cuerpo["id"], "s01e03")
        self.assertEqual(cuerpo["slug"], "istincho")
        self.assertEqual(cuerpo["titulo"], "S01E03")
        self.assertAlmostEqual(cuerpo["duracion"], 2712.048)
        self.assertEqual(cuerpo["calidades"], [720, 1080])
        self.assertEqual(cuerpo["subtitulos"], [{"idioma": "spa", "nombre": "Espanol"}])
        self.assertGreater(cuerpo["bytes"], 0)

    def test_la_url_apunta_a_la_maestra_y_no_a_una_lista_de_calidad(self):
        # `clave_r2(..., "lista.m3u8")` deja una URL que carga una sola
        # calidad y ningun subtitulo, o directamente un 404.
        hecho = self.correr()
        self.assertEqual(hecho["cuerpo"]["url"],
                         "https://pub-x.r2.dev/istincho/s01e03/maestra.m3u8")
        self.assertIn("istincho/s01e03/maestra.m3u8",
                      [c for c, _ in hecho["cliente"].subidos])

    def test_manda_la_clave_de_subida_en_la_cabecera(self):
        pedido = self.correr()["pedidos"][0]
        self.assertEqual(pedido.get_method(), "POST")
        self.assertEqual(pedido.full_url, "https://sala.example/api/videos")
        self.assertEqual(pedido.get_header("X-clave-subida"), "clave-secreta")

    def test_las_claves_de_r2_salen_con_barras_normales(self):
        subidas = [c for c, _ in self.correr()["cliente"].subidos]
        self.assertIn("istincho/s01e03/720p/seg00000.ts", subidas)
        self.assertIn("istincho/s01e03/1080p/lista.m3u8", subidas)
        for clave in subidas:
            self.assertNotIn("\\", clave)

    def test_la_maestra_va_ultima_tambien_en_la_accion_completa(self):
        self.assertTrue(self.correr()["cliente"].subidos[-1][0].endswith("maestra.m3u8"))

    def test_cada_objeto_va_con_su_tipo_y_el_cache_largo(self):
        extras = dict(self.correr()["cliente"].subidos)
        self.assertEqual(extras["istincho/s01e03/maestra.m3u8"]["ContentType"],
                         "application/vnd.apple.mpegurl")
        self.assertEqual(extras["istincho/s01e03/720p/seg00000.ts"]["ContentType"],
                         "video/mp2t")
        self.assertEqual(extras["istincho/s01e03/720p/seg00000.ts"]["CacheControl"],
                         "public, max-age=31536000, immutable")

    def test_un_error_del_servidor_dice_como_reintentar(self):
        with self.assertRaises(subir.Aviso) as caja:
            self.correr(estado=500)
        self.assertIn("--avisar s01e03", str(caja.exception))

    def test_sin_avisar_no_llama_al_servidor(self):
        hecho = self.correr(extra=["--sin-avisar"])
        self.assertEqual(hecho["pedidos"], [])
        self.assertIn("maestra.m3u8", hecho["salida"])

    def test_una_sala_con_puntos_no_pasa(self):
        with self.assertRaises(subir.Aviso):
            self.correr(extra=["--sala", "../otro"])

    def test_subir_de_nuevo_borra_lo_que_sobro_de_la_vez_anterior(self):
        # Si el video nuevo tiene menos segmentos que el viejo, los sobrantes
        # se quedan ocupando los 10 GB sin aparecer en ninguna playlist.
        cliente = ClienteFalsoR2({
            "istincho/s01e03/720p/seg09999.ts": b"sobra",
            "istincho/s01e03/720p/seg00000.ts": b"se pisa",
        })
        hecho = self.correr(cliente=cliente)
        self.assertEqual(cliente.borrados, ["istincho/s01e03/720p/seg09999.ts"])
        # Lo que se volvio a subir no se borra: quedaria un video sin segmento.
        self.assertIn("istincho/s01e03/720p/seg00000.ts", cliente.objetos)
        self.assertIn("ya habia", hecho["salida"])

    def test_el_subtitulo_que_se_sube_esta_atado_al_reloj_del_ts(self):
        # El ffprobe de mentira dice que el segmento arranca en 1,512 s. Si la
        # accion no midiera y asumiera cero, el WebVTT subiria con el
        # encabezado en 0 y los subtitulos saldrian adelantados 1,5 s.
        objetos = self.correr()["cliente"].objetos
        vtt = objetos["istincho/s01e03/subtitulos/spa/subtitulos.vtt"].decode("utf-8")
        self.assertIn("X-TIMESTAMP-MAP=MPEGTS:136080,LOCAL:00:00:00.000", vtt)
        self.assertAlmostEqual(donde_cae_la_cue(vtt, 1.0, 1.512), 1.0, places=3)

    def test_una_subida_limpia_no_borra_nada(self):
        hecho = self.correr()
        self.assertEqual(hecho["cliente"].borrados, [])
        self.assertNotIn("ya habia", hecho["salida"])


class PruebaSoloPreparar(unittest.TestCase):

    def correr_en(self, donde, extra=()):
        entrada = Path(donde) / "S01E03.mkv"
        entrada.write_bytes(b"cualquier cosa")
        args = subir.armar_parser().parse_args(
            [str(entrada), "--solo-preparar", "--trabajo", str(donde)] + list(extra))
        anterior = os.getcwd()
        os.chdir(str(donde))
        try:
            with mock.patch.object(subir, "comprobar_programas", lambda *a: None), \
                    mock.patch.object(subir.subprocess, "run", subprocess_de_mentira), \
                    mock.patch.object(subir, "correr_ffmpeg_con_progreso", ffmpeg_de_mentira), \
                    contextlib.redirect_stdout(io.StringIO()):
                return subir.accion_subir(args, dict(CONFIG_DE_PRUEBA))
        finally:
            os.chdir(anterior)

    def test_deja_la_carpeta_armada(self):
        donde = Path(tempfile.mkdtemp())
        self.assertEqual(self.correr_en(donde), 0)
        self.assertTrue((donde / "hls-s01e03" / "maestra.m3u8").is_file())
        self.assertTrue((donde / "hls-s01e03" / "720p" / "seg00000.ts").is_file())

    def test_no_borra_una_carpeta_que_ya_estaba_sin_permiso(self):
        # `shutil.rmtree` sin preguntar sobre una carpeta del dueno: ahi puede
        # estar la corrida anterior que estaba mirando.
        donde = Path(tempfile.mkdtemp())
        vieja = donde / "hls-s01e03"
        vieja.mkdir()
        (vieja / "no-me-borres.txt").write_text("importante", encoding="utf-8")
        with self.assertRaises(subir.Aviso) as caja:
            self.correr_en(donde)
        self.assertIn("--si", str(caja.exception))
        self.assertTrue((vieja / "no-me-borres.txt").is_file())

    def test_con_si_la_reemplaza(self):
        donde = Path(tempfile.mkdtemp())
        vieja = donde / "hls-s01e03"
        vieja.mkdir()
        (vieja / "no-me-borres.txt").write_text("ya fue", encoding="utf-8")
        self.assertEqual(self.correr_en(donde, extra=["--si"]), 0)
        self.assertFalse((vieja / "no-me-borres.txt").exists())
        self.assertTrue((vieja / "maestra.m3u8").is_file())


# ==========================================================================
# F3: el camino destructivo y el reintento
# ==========================================================================

class PruebaAccionBorrar(unittest.TestCase):
    """El unico test que habia pasaba `si=True`: la rama de confirmacion no se
    ejecutaba nunca y sacarla no rompia nada."""

    def cliente(self):
        return ClienteFalsoR2({
            "istincho/s01e03/maestra.m3u8": b"x" * 10,
            "istincho/s01e03/720p/seg00000.ts": b"y" * 100,
            "istincho/otro/maestra.m3u8": b"z" * 10,
        })

    def correr(self, argumentos, cliente=None, respuesta=None):
        cliente = self.cliente() if cliente is None else cliente
        args = subir.armar_parser().parse_args(argumentos)
        entrada = (mock.patch("builtins.input", return_value=respuesta)
                   if respuesta is not None
                   else mock.patch("builtins.input",
                                   side_effect=AssertionError("no tenia que preguntar")))
        with mock.patch.object(subir, "crear_cliente", return_value=cliente), entrada, \
                contextlib.redirect_stdout(io.StringIO()) as impreso:
            codigo = subir.accion_borrar(args, dict(CONFIG_DE_PRUEBA))
        return codigo, cliente, impreso.getvalue()

    def test_un_id_invalido_no_llega_a_tocar_r2(self):
        # Sin validar_id, `--borrar ..` arma el prefijo `istincho/../` y
        # `--borrar ''` el prefijo `istincho/`: se lleva la sala entera.
        for malo in ("..", "../otro", "S01E03", "s01/e03"):
            cliente = self.cliente()
            with self.assertRaises(subir.Aviso, msg=malo):
                self.correr(["--borrar", malo, "--si", "--sin-avisar"], cliente=cliente)
            self.assertEqual(cliente.borrados, [], msg=malo)

    def test_una_sala_invalida_tampoco(self):
        # `--sala "../otro"` opera bajo `../otro/s01e03/`: entrada sin validar
        # en el camino que borra.
        cliente = self.cliente()
        with self.assertRaises(subir.Aviso):
            self.correr(["--borrar", "s01e03", "--sala", "../otro", "--si", "--sin-avisar"],
                        cliente=cliente)
        self.assertEqual(cliente.borrados, [])

    def test_sin_escribir_el_id_no_borra_nada(self):
        codigo, cliente, impreso = self.correr(
            ["--borrar", "s01e03", "--sin-avisar"], respuesta="si dale")
        self.assertEqual(codigo, 1)
        self.assertEqual(cliente.borrados, [])
        self.assertIn("No coincide", impreso)

    def test_con_el_id_escrito_borra_solo_ese_video(self):
        codigo, cliente, _ = self.correr(
            ["--borrar", "s01e03", "--sin-avisar"], respuesta="s01e03")
        self.assertEqual(codigo, 0)
        self.assertEqual(sorted(cliente.borrados),
                         ["istincho/s01e03/720p/seg00000.ts",
                          "istincho/s01e03/maestra.m3u8"])
        self.assertIn("istincho/otro/maestra.m3u8", cliente.objetos)

    def test_con_si_no_pregunta(self):
        # El `input` de este camino esta parcheado para explotar: si se
        # llamara, el test se cae.
        codigo, cliente, _ = self.correr(["--borrar", "s01e03", "--si", "--sin-avisar"])
        self.assertEqual(codigo, 0)
        self.assertEqual(len(cliente.borrados), 2)


class PruebaAccionAvisar(unittest.TestCase):
    """El reintento manda el MISMO cuerpo que la subida.

    El servidor pisa la ficha entera con lo que llega: un cuerpo a medias deja
    el video sin calidades, sin subtitulos y con 0 bytes en el panel, y da 400
    si algun dia esos campos pasan a ser obligatorios.
    """

    MAESTRA = "\n".join([
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Espanol",LANGUAGE="spa",'
        'AUTOSELECT=YES,DEFAULT=YES,FORCED=NO,URI="subtitulos/spa/lista.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2685893,RESOLUTION=1280x720,SUBTITLES="subs"',
        "720p/lista.m3u8",
        '#EXT-X-STREAM-INF:BANDWIDTH=5336192,RESOLUTION=1920x1080,SUBTITLES="subs"',
        "1080p/lista.m3u8",
        "",
    ])

    def cliente(self):
        return ClienteFalsoR2({
            "istincho/s01e03/maestra.m3u8": self.MAESTRA.encode("utf-8"),
            "istincho/s01e03/720p/seg00000.ts": b"a" * 1000,
            "istincho/s01e03/1080p/seg00000.ts": b"b" * 2000,
            "istincho/s01e03/subtitulos/spa/subtitulos.vtt": b"WEBVTT\n",
        })

    def correr(self, argumentos, cliente=None):
        cliente = self.cliente() if cliente is None else cliente
        pedidos = []

        def abrir(pedido, timeout=None):
            pedidos.append(pedido)
            return RespuestaFalsa(200)

        args = subir.armar_parser().parse_args(argumentos)
        with mock.patch.object(subir, "crear_cliente", return_value=cliente), \
                mock.patch.object(subir.urllib.request, "urlopen", abrir), \
                contextlib.redirect_stdout(io.StringIO()):
            codigo = subir.accion_avisar(args, dict(CONFIG_DE_PRUEBA))
        return codigo, (json.loads(pedidos[0].data) if pedidos else None)

    def test_el_reintento_manda_el_cuerpo_completo(self):
        cliente = self.cliente()
        codigo, cuerpo = self.correr(
            ["--avisar", "s01e03", "--duracion", "2712.048", "--titulo", "Capitulo 3"],
            cliente=cliente)
        self.assertEqual(codigo, 0)
        self.assertEqual(cuerpo["id"], "s01e03")
        self.assertEqual(cuerpo["slug"], "istincho")
        self.assertEqual(cuerpo["titulo"], "Capitulo 3")
        self.assertAlmostEqual(cuerpo["duracion"], 2712.048)
        self.assertEqual(cuerpo["url"],
                         "https://pub-x.r2.dev/istincho/s01e03/maestra.m3u8")
        # Esto es lo que faltaba: sin estos tres campos el reintento deja la
        # ficha peor de lo que estaba.
        self.assertEqual(cuerpo["calidades"], [720, 1080])
        self.assertEqual(cuerpo["subtitulos"], [{"idioma": "spa", "nombre": "Espanol"}])
        self.assertEqual(cuerpo["bytes"],
                         sum(len(v) for v in cliente.objetos.values()))

    def test_si_en_r2_no_hay_nada_no_registra_un_video_fantasma(self):
        with self.assertRaises(subir.Aviso) as caja:
            self.correr(["--avisar", "s01e03", "--duracion", "10"],
                        cliente=ClienteFalsoR2())
        self.assertIn("no hay nada", str(caja.exception))

    def test_sin_duracion_avisa_en_vez_de_mandar_basura(self):
        with self.assertRaises(subir.Aviso):
            self.correr(["--avisar", "s01e03"])

    def test_un_id_invalido_no_pasa(self):
        with self.assertRaises(subir.Aviso):
            self.correr(["--avisar", "../otro", "--duracion", "10"])

    def test_datos_de_maestra_ignora_lo_que_no_es_una_calidad(self):
        leido = subir.datos_de_maestra(
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720p/lista.m3u8\n"
            "#EXT-X-MEDIA:TYPE=AUDIO,NAME=\"x\",LANGUAGE=\"eng\"\n")
        self.assertEqual(leido["calidades"], [720])
        self.assertEqual(leido["subtitulos"], [])


class PruebaAccionListar(unittest.TestCase):

    def correr(self, cliente):
        args = subir.armar_parser().parse_args(["--listar"])
        with mock.patch.object(subir, "crear_cliente", return_value=cliente), \
                contextlib.redirect_stdout(io.StringIO()) as impreso:
            subir.accion_listar(args, dict(CONFIG_DE_PRUEBA))
        return impreso.getvalue()

    def test_los_10_gb_se_cuentan_del_bucket_entero(self):
        # Contando solo su propio prefijo, --listar diria que quedan 9 GB
        # cuando en el bucket no queda ninguno, y el aviso llegaria cuando R2
        # ya este cobrando.
        cliente = ClienteFalsoR2({
            "istincho/s01e03/a.ts": 1024 ** 3,
            "otra-sala/peli/b.ts": 8 * 1024 ** 3,
        })
        impreso = self.correr(cliente)
        self.assertIn("En el bucket sala-video hay 9.0 GB en total. "
                      "Quedan 1.0 GB de los 10 GB gratis.", impreso)
        # Y para eso hay que pedirle al bucket entero, no solo al prefijo.
        self.assertIn("", cliente.listados)
        self.assertIn("istincho/", cliente.listados)

    def test_sigue_mostrando_lo_de_su_sala(self):
        impreso = self.correr(ClienteFalsoR2({
            "istincho/s01e03/a.ts": 100,
            "istincho/s01e04/b.ts": 200,
        }))
        self.assertIn("s01e03", impreso)
        self.assertIn("s01e04", impreso)

    def test_listar_objetos_con_prefijo_vacio_pide_todo_y_no_una_barra(self):
        # `"".strip("/") + "/"` da "/", que no matchea ninguna clave: el total
        # del bucket daria siempre cero.
        cliente = ClienteFalsoR2({"a/b.ts": 5})
        objetos = subir.listar_objetos(cliente, "sala-video", "")
        self.assertEqual([o["clave"] for o in objetos], ["a/b.ts"])
        self.assertEqual(cliente.listados, [""])


# ==========================================================================
# El idioma del mkv es texto libre y termina en una URI
# ==========================================================================

class PruebaIdiomaEnLaUri(unittest.TestCase):

    def pista_cruda(self, idioma):
        return [{"indice": 0, "codec": "subrip", "idioma": idioma,
                 "titulo": None, "predeterminado": True}]

    def extraer(self, pistas, desfase=1.512):
        carpeta = Path(tempfile.mkdtemp())

        def correr(comando, **argumentos):
            destino = Path(str([str(c) for c in comando][-1]))
            destino.write_text(VTT_DE_MUESTRA, encoding="utf-8")
            return Corrido(0)

        hechas = subir.extraer_subtitulos(
            "x.mkv", carpeta, pistas, correr=correr, desfase=desfase)
        return carpeta, hechas

    def test_ffprobe_ya_devuelve_la_etiqueta_saneada(self):
        leido = subir.analizar_ffprobe({
            "format": {"duration": "10"},
            "streams": [
                {"codec_type": "video", "height": 720},
                {"codec_type": "subtitle", "codec_name": "subrip",
                 "tags": {"language": "es MX (Latino)"}},
            ],
        })
        self.assertEqual(leido["subtitulos"][0]["idioma"], "es-mx-latino")

    def test_la_carpeta_y_la_uri_no_llevan_espacios_ni_parentesis(self):
        # Con `es MX (Latino)` la clave de R2 salia
        # `istincho/s01e03/subtitulos/es mx (latino)/subtitulos.vtt` y la
        # maestra con `URI="subtitulos/es mx (latino)/lista.m3u8"`: sin
        # percent-encoding, eso es un 404 mudo.
        _, pistas = self.extraer(self.pista_cruda("es MX (Latino)"))
        self.assertEqual(pistas[0]["carpeta"], "subtitulos/es-mx-latino")
        self.assertEqual(pistas[0]["idioma"], "es-mx-latino")
        self.assertEqual(pistas[0]["nombre"], "Espanol")

        maestra = subir.inyectar_subtitulos(
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720p/lista.m3u8\n", pistas)
        uri = re.search(r'URI="([^"]*)"', maestra).group(1)
        self.assertEqual(uri, "subtitulos/es-mx-latino/lista.m3u8")
        self.assertNotRegex(uri, r"[\s()]")
        # Una URI que necesita escaparse no es la URI que se subio.
        self.assertEqual(uri, urllib.parse.quote(uri, safe="/-_.~"))

        clave = subir.clave_r2("istincho", "s01e03", pistas[0]["carpeta"] + "/subtitulos.vtt")
        self.assertEqual(clave, "istincho/s01e03/subtitulos/es-mx-latino/subtitulos.vtt")
        self.assertEqual(clave, urllib.parse.quote(clave, safe="/-_.~"))

    def test_una_etiqueta_que_queda_vacia_cae_en_und(self):
        _, pistas = self.extraer(self.pista_cruda("(((...)))"))
        self.assertEqual(pistas[0]["carpeta"], "subtitulos/und")

    def test_dos_pistas_del_mismo_idioma_no_se_pisan(self):
        crudas = self.pista_cruda("spa") + [
            {"indice": 1, "codec": "subrip", "idioma": "spa",
             "titulo": "Forzados", "predeterminado": False}]
        _, pistas = self.extraer(crudas)
        self.assertEqual([p["carpeta"] for p in pistas],
                         ["subtitulos/spa", "subtitulos/spa-2"])

    def test_cada_vtt_queda_atado_al_reloj_del_ts(self):
        carpeta, pistas = self.extraer(self.pista_cruda("spa"), desfase=1.512)
        vtt = (carpeta / pistas[0]["carpeta"] / "subtitulos.vtt").read_text(encoding="utf-8")
        self.assertIn("X-TIMESTAMP-MAP=MPEGTS:136080,LOCAL:00:00:00.000", vtt)
        self.assertAlmostEqual(donde_cae_la_cue(vtt, 1.0, 1.512), 1.0, places=3)

    def test_el_nombre_visible_sale_del_titulo_de_la_pista(self):
        crudas = self.pista_cruda("spa")
        crudas[0]["titulo"] = "Espanol (Latino)"
        _, pistas = self.extraer(crudas)
        self.assertEqual(pistas[0]["nombre"], "Espanol (Latino)")
        self.assertEqual(pistas[0]["carpeta"], "subtitulos/spa")


class PruebaValidarSala(unittest.TestCase):

    def test_rechaza_lo_que_se_sale_del_prefijo(self):
        for malo in ["", "..", "../otro", "Istincho", "con espacio", "a" * 51, None, "/x"]:
            with self.assertRaises(subir.Aviso, msg=repr(malo)):
                subir.validar_slug(malo)

    def test_acepta_lo_normal(self):
        for bueno in ["istincho", "otra-sala", "sala_2", "a"]:
            self.assertEqual(subir.validar_slug(bueno), bueno)

    def test_es_el_mismo_formato_que_valida_el_servidor(self):
        # servidor/videos.js: /^[a-z0-9][a-z0-9_-]{0,49}$/. Si uno aceptara
        # algo que el otro no, habria fichas apuntando a un prefijo que no
        # existe.
        self.assertEqual(subir.validar_slug("a" * 50), "a" * 50)
        with self.assertRaises(subir.Aviso):
            subir.validar_slug("-arranca-mal")


if __name__ == "__main__":
    unittest.main(verbosity=2)
