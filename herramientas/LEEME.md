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

Los subtítulos se suben con un `X-TIMESTAMP-MAP` que los ata al reloj de los
segmentos. **No sacarlo**: los segmentos MPEG-TS no arrancan en cero (el muxer
les pone ~1,5 s) y sin ese encabezado hls.js adelanta todas las líneas y se
come la primera.

Volver a subir el mismo id **reemplaza** ese video: avisa cuántos archivos
había y, al terminar, borra los que sobraron de la vez anterior. Dos capítulos
distintos con el mismo nombre de archivo dan el mismo id, así que conviene
mirar ese aviso.

Opciones útiles:

- `--solo-preparar` convierte y deja los archivos en `hls-<id>/` sin subir
  nada. No necesita credenciales: sirve para probar ffmpeg. Si la carpeta ya
  existe no la pisa: hay que borrarla o pasar `--si`.
- `--sin-avisar` sube pero no llama al servidor.
- `--avisar <id> --duracion <segundos>` reintenta sólo el aviso, si la subida
  salió bien y el servidor estaba caído. Necesita también las credenciales de
  R2: lee de ahí las calidades, los subtítulos y el peso, para mandar el mismo
  cuerpo que manda la subida normal. Si en R2 no hay nada bajo ese id, avisa
  en vez de registrar un video que no existe.
- `--id`, `--titulo`, `--sala`, `--hilos`, `--trabajo`, `--conservar`, `--si`.

`--listar` muestra lo de tu sala y, aparte, cuánto ocupa **el bucket entero**:
los 10 GB gratis son del bucket, no de tu prefijo.

## Pruebas

```bash
python herramientas/pruebas_subir.py
```

No entran en `npm test`, que es la suite de Node de `pruebas/`.
