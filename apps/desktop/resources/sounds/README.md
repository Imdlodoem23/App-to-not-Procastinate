# Sonidos de concentración

Los tres bucles del Study Mode (PROMPT.md §9): lluvia, ruido blanco y lo-fi. Van dentro de la app, así que suenan sin internet.

| Archivo            | Qué suena                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lluvia.wav`       | Lluvia suave: un fondo de ruido rosa, muchas gotas pequeñas sobre hojas y alféizares, alguna gota en un charco, el rumor grave del tejado y una sala pequeña, con rachas lentas                                    |
| `ruido-blanco.wav` | Ruido suave: rosa con una parte de blanco por encima, sin graves profundos ni agudos ásperos                                                                                                                       |
| `lo-fi.wav`        | 80 bpm, 12 compases (Gm9, C13, Fmaj9 y Dm9, tres veces): piano eléctrico, bajo redondo, batería _boom bap_ con swing, vibráfono en la segunda y la tercera vuelta, cinta con _wow_ y _flutter_ y crujido de vinilo |

## Sonoridad y formato

| Archivo            | Muestreo  | Bucle  | Tamaño  | Sonoridad integrada | Pico real | Pico de muestra | RMS        |
| ------------------ | --------- | ------ | ------- | ------------------- | --------- | --------------- | ---------- |
| `lluvia.wav`       | 22,05 kHz | 27,0 s | 1,19 MB | −20,0 LUFS          | −2,9 dBTP | −2,9 dBFS       | −21,8 dBFS |
| `ruido-blanco.wav` | 22,05 kHz | 24,0 s | 1,06 MB | −20,0 LUFS          | −7,4 dBTP | −7,4 dBFS       | −21,2 dBFS |
| `lo-fi.wav`        | 16,00 kHz | 36,0 s | 1,15 MB | −20,0 LUFS          | −4,7 dBTP | −4,8 dBFS       | −18,7 dBFS |

- **Misma sonoridad:** los tres están normalizados a −20 LUFS integrados, así que cambiar de sonido no cambia el volumen. El volumen de la app se aplica encima.
- **Cómo se mide:** ITU-R BS.1770-4 (ponderación K, bloques de 400 ms, puerta absoluta de −70 LUFS y relativa de −10 LU), sobre el propio bucle ya cuantizado a 16 bits y dando la vuelta al final, como suena en bucle. El pico real se estima con sobremuestreo ×4 y queda siempre por debajo de −1 dBTP. El mono se mide como un solo canal (peso 1,0); por los dos altavoces a la vez, un medidor estéreo marcaría unos 3 LU más.
- **Formato:** WAV PCM de 16 bits, mono, con _dither_ TPDF. No hay codificador de audio en `node_modules` ni ffmpeg en CI, y cada archivo debe quedarse en 1,2 MB o menos. Lluvia y ruido blanco van a 22,05 kHz. Lo-fi va a 16 kHz para que quepa su bucle de 36 s; la música ya pasa por un paso bajo de 6,5 kHz, así que apenas pierde nada.

## Bucle sin cortes

No hay fundido cruzado porque no hace falta: todo se genera en círculo.

- Cada evento (gota, chasquido, nota, golpe de batería) se escribe dando la vuelta al bucle, así que una cola que pasa del final sigue al principio.
- Cada filtro, reverberación y línea de retardo da dos vueltas al bucle y se queda con la segunda, así que el estado que entra en la primera muestra es el que sale de la última. Una tercera vuelta da exactamente las mismas muestras.
- Cada modulación (rachas, trémolo, _wow_, _flutter_) completa un número entero de ciclos por bucle.

La muestra que sigue a la última es la que la síntesis habría producido después. Un fundido cruzado, en cambio, hunde el nivel o produce filtrado en peine en la unión.

## Cómo reproducirlos en la app

Descodifica cada archivo a su propia frecuencia de muestreo y repítelo con un `AudioBufferSourceNode`, que remuestrea mientras suena y cruza la unión sin notarse:

```ts
const bytes = await (await fetch(url)).arrayBuffer();
const rate = new DataView(bytes).getUint32(24, true); // 22050 or 16000, from the WAV header
const buffer = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes);
const source = new AudioBufferSourceNode(context, { buffer, loop: true });
source.connect(volume).connect(context.destination);
source.start();
```

Comprobado en Chromium: con este método, el salto entre muestras en la unión es como cualquier otro de los tres archivos.

- Si se descodifica directamente en el contexto de la app (48 kHz), `decodeAudioData` remuestrea el archivo como si no fuera un bucle y rellena los extremos con silencio. En lluvia y ruido blanco no se nota; en lo-fi deja un tic muy leve cada 36 s. Por eso lo-fi empieza en su momento más tranquilo, justo antes del primer tiempo, y no encima del bombo.
- `<audio loop>` puede dejar un pequeño hueco al volver al principio.

Para empaquetarlos, `apps/desktop/electron-builder.yml` necesita esta entrada en `extraResources`; en la app instalada quedan en `process.resourcesPath/sounds`:

```yaml
- from: resources/sounds
  to: sounds
  filter: ['*.wav']
```

## Licencia

Son obra original del proyecto: `scripts/gen-sounds.mjs` los sintetiza con semillas fijas, sin muestras, grabaciones ni audio de terceros. Se dedican al dominio público con [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/deed.es), y así consta en `ASSET-LICENSES.json` y en los metadatos de cada WAV (`LIST/INFO`).

## Regenerarlos

```sh
node scripts/gen-sounds.mjs            # write the three files and print the loudness table
node scripts/gen-sounds.mjs --check    # write nothing; exit 1 if a file is missing or differs
node scripts/gen-sounds.mjs --out DIR  # write to another folder (previews)
```

La salida es determinista: sale igual byte a byte con la misma versión mayor de Node. Si cambias el script, vuelve a generarlos y copia aquí la tabla que imprime.
