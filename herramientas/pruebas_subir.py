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
import io
import json
import re
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
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
    """Cliente S3 de mentira que anota el orden y cuantas subidas hay en vuelo."""

    def __init__(self, demora=0.0):
        self.orden = []
        self.demora = demora
        self.candado = threading.Lock()
        self.en_vuelo = 0
        self.en_vuelo_al_subir_la_maestra = None
        self.sin_callback = []
        self.extras = {}

    def upload_file(self, ruta, bucket, clave, ExtraArgs=None, Callback=None):
        es_maestra = clave.endswith("maestra.m3u8")
        if es_maestra:
            with self.candado:
                self.en_vuelo_al_subir_la_maestra = self.en_vuelo
        else:
            with self.candado:
                self.en_vuelo += 1
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
        espia = ClienteEspia(demora=0.05)
        subir.subir_carpeta(espia, "sala-video", "istincho", "s01e03",
                            carpeta_de_prueba(), hilos=2, salida=io.StringIO())
        self.assertEqual(espia.en_vuelo_al_subir_la_maestra, 0)
        self.assertEqual(espia.orden[-1], "istincho/s01e03/maestra.m3u8")

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

    def test_apaga_los_checksum_que_r2_no_implementa(self):
        # boto3 >= 1.36 manda un CRC32 en cada PutObject y UploadPart. R2 no
        # implementa esos encabezados y la subida falla.
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
    DeleteObjects. Guarda todo en memoria y anota los encabezados recibidos."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    @property
    def deposito(self):
        return self.server.deposito

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
        self.deposito["objetos"][clave] = {
            "datos": datos,
            "ContentType": self.headers.get("Content-Type"),
            "CacheControl": self.headers.get("Cache-Control"),
        }
        self.deposito["encabezados"].append(dict(self.headers))
        self.deposito["orden"].append(clave)
        self.send_response(200)
        self.send_header("ETag", '"%s"' % base64.b16encode(b"x").decode())
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
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
    def __init__(self):
        self.deposito = {"objetos": {}, "encabezados": [], "borrados": [], "orden": []}
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
            self.assertEqual(objetos["istincho/s01e03/maestra.m3u8"]["CacheControl"],
                             subir.CACHE_LARGO)

    def test_la_maestra_se_sube_ultima(self):
        # Si la maestra existiera antes que los segmentos, alguien que abra la
        # sala mientras se sube veria un video incompleto.
        with S3Local() as s3:
            cliente = subir.crear_cliente(self.config(s3))
            subir.subir_carpeta(
                cliente, "sala-video", "istincho", "s01e03", self.carpeta_hls(), hilos=4)
            self.assertEqual(s3.deposito["orden"][-1], "istincho/s01e03/maestra.m3u8")
            self.assertEqual(len(s3.deposito["orden"]), 6)

    def test_no_viajan_encabezados_de_checksum(self):
        # Es la incompatibilidad concreta de boto3 >= 1.36 con R2. Si alguien
        # saca el Config de crear_cliente, esta prueba lo caza.
        with S3Local() as s3:
            cliente = subir.crear_cliente(self.config(s3))
            subir.subir_carpeta(
                cliente, "sala-video", "istincho", "s01e03", self.carpeta_hls(), hilos=2)
            for encabezados in s3.deposito["encabezados"]:
                minusculas = {k.lower() for k in encabezados}
                self.assertNotIn("x-amz-sdk-checksum-algorithm", minusculas)
                self.assertFalse([k for k in minusculas if k.startswith("x-amz-checksum-")],
                                 msg=str(sorted(minusculas)))

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
