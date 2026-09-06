# herramientas/

Scripts que corren en la PC del dueño, no en Railway. `.railwayignore` deja
esta carpeta afuera del contenedor. Es la única parte del proyecto en Python.

## Preparar la PC (una sola vez)

```powershell
winget install Gyan.FFmpeg
winget install Python.Python.3.12
python -m pip install -r herramientas/requirements.txt
cp herramientas/.env.ejemplo herramientas/.env   # y completarlo
```

`herramientas/.env` no va al repo. Los valores salen de las tareas 9 y 10 de
`TAREAS-DUENO.md` y de la clave de subida que genera `/panel`.

## subir.py

```bash
# Antes del stream: convierte a HLS, sube a R2 y le avisa al servidor.
python herramientas/subir.py "S01E03.mkv"

# Qué hay guardado y cuánto de los 10 GB queda libre.
python herramientas/subir.py --listar

# Después del stream: libera espacio.
python herramientas/subir.py --borrar s01e03
```

Deja en R2, bajo `istincho/<id>/`:

```
maestra.m3u8              playlist maestra (es la URL que usa la Sala)
720p/lista.m3u8  + seg00000.ts …
1080p/lista.m3u8 + seg00000.ts …
subtitulos/<idioma>/lista.m3u8 + subtitulos.vtt
```

Segmentos de **6 segundos**: 300 personas mirando 2 h son 360.000 lecturas de
las 10 millones gratis por mes. No cambiar sin rehacer la cuenta y anotarla en
`BITACORA.md`.

Opciones útiles:

- `--solo-preparar` convierte y deja los archivos en `hls-<id>/` sin subir
  nada. No necesita credenciales: sirve para probar ffmpeg.
- `--sin-avisar` sube pero no llama al servidor.
- `--avisar <id> --duracion <segundos>` reintenta sólo el aviso, si la subida
  salió bien y el servidor estaba caído.
- `--id`, `--titulo`, `--sala`, `--hilos`, `--trabajo`, `--conservar`, `--si`.

## Pruebas

```bash
python herramientas/pruebas_subir.py
```

No entran en `npm test`, que es la suite de Node de `pruebas/`.
