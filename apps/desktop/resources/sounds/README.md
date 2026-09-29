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

## Cómo suenan en la app

El reproductor está en `apps/desktop/src/renderer/src/sounds/`:

- `loop-audio.ts` lee el WAV y lo remuestrea una sola vez, al cargarlo, a la frecuencia del contexto de audio (la de la tarjeta de sonido: 44,1 o 48 kHz, casi siempre). Usa un filtro sinc con ventana de Kaiser (48 coeficientes, corte en 0,45 × la frecuencia más baja de las dos) que, en la unión, lee las muestras del otro extremo del bucle en vez de silencio. El resultado dura lo mismo que el bucle y es otro bucle sin cortes.
- `loop-player.ts` lo repite con un `AudioBufferSourceNode` (`loop = true`) a velocidad 1, así que nada interpola mientras suena. Arrancar, parar y cambiar de sonido pasan siempre por una rampa de ganancia de 400 ms (al cambiar, los dos sonidos se funden), y el volumen se desliza en 50 ms.
- `app-player.ts` lo monta sobre el `AudioContext` real. Recibe los bytes de `sounds:load`:

```ts
const player = createAppLoopPlayer(prefs.sounds.volume); // 0–100
const loaded = await invoke('sounds:load', { sound: 'rain' });
if (loaded.ok) await player.play(loaded.value.bytes); // fades in over 400 ms
player.setVolume(40);
player.stop(); // fades out over 400 ms
```

Medido en Chromium a 48 kHz, dos vueltas de cada bucle en un `OfflineAudioContext`. La unión es el salto (segunda diferencia) al cruzarla dividido entre el percentil 99,9 del resto del bucle; por debajo de 1 no se distingue de cualquier otra muestra.

| Método                                                        | Energía entre 11,3 y 22 kHz (ruido blanco · lluvia · lo-fi) | Unión (ruido blanco · lluvia · lo-fi) |
| ------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------- |
| Remuestreo al cargar (el de la app)                           | −94,0 · −94,1 · −88,5 dB                                    | 0,35 · 0,06 · 0,03                    |
| El búfer a 22,05 o 16 kHz en un contexto a 48 kHz | −22,8 · −26,3 · −40,1 dB                                    | 0,11 · 0,03 · 0,04                    |
| `decodeAudioData` a 48 kHz                                    | −81,2 · −82,2 · −79,8 dB                                    | 0,61 · 0,20 · **2,13**                |

- **El búfer a 22,05 o 16 kHz** cruza la unión sin notarse, pero Chromium lo remuestrea por interpolación lineal, que deja imágenes por encima de la frecuencia de Nyquist del archivo: un siseo que el ruido blanco, «suave, sin agudos ásperos», no debe tener.
- **`decodeAudioData` a 48 kHz** remuestrea bien, pero trata el archivo como un sonido suelto y rellena sus extremos con silencio: en lo-fi deja un tic cada 36 s.
- **La rampa** no es opcional: el primer bombo de lo-fi llega entre 20 y 60 ms después de la muestra 0 (el RMS en ventanas de 10 ms salta de −23 a −11 dBFS), y cortar un bucle a mitad de onda hace clic. Con la rampa, los primeros 10 ms quedan por debajo de −57 dBFS.
- **El coste:** remuestrear un bucle son entre 50 y 85 millones de multiplicaciones (0,2–0,6 s en un procesador modesto). Se hace a trozos de 65 536 muestras cediendo el hilo entre uno y otro, así que la interfaz no se congela; si eliges otro sonido mientras tanto, el primero se descarta.
- `<audio loop>` puede dejar un pequeño hueco al volver al principio.

Las pruebas de `apps/desktop/test/renderer/sounds/` comprueban en Node, con los tres archivos, que el remuestreo conserva los tonos dentro de banda, no deja imágenes por encima de la frecuencia de Nyquist del archivo y no marca la unión, y que el reproductor hace las rampas y los fundidos.

## Empaquetado

`apps/desktop/electron-builder.yml` los copia con `extraResources`:

```yaml
- from: resources/sounds
  to: sounds
  filter: ['*.wav']
```

En la app instalada quedan en `process.resourcesPath/sounds`; en desarrollo, en `apps/desktop/resources/sounds`. `src/main/app/paths.ts` resuelve esa carpeta (`soundsDir`) y el archivo de cada sonido (`soundFilePath`), que es lo que lee `sounds:load`.

- `apps/desktop/test/main/app/packaged-resources.test.ts` comprueba que cada id de `SOUND_FILES` pasa el filtro, existe y se resuelve dentro de `process.resourcesPath/sounds`, y que en la carpeta no hay ningún WAV sin usar (este README no se empaqueta).
- Tras empaquetar, el flujo de publicación ejecuta `apps/desktop/scripts/check-packaged-resources.mjs`, que falla si `win-unpacked`, `linux-unpacked` o la `.app` no llevan los WAV (ni los modelos del Study Mode) con el mismo tamaño que el original.

## Licencia

Son obra original del proyecto: `scripts/gen-sounds.mjs` los sintetiza con semillas fijas, sin muestras, grabaciones ni audio de terceros. Se dedican al dominio público con [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/deed.es), y así consta en `ASSET-LICENSES.json` y en los metadatos de cada WAV (`LIST/INFO`).

## Regenerarlos

```sh
node scripts/gen-sounds.mjs            # write the three files and print the loudness table
node scripts/gen-sounds.mjs --check    # write nothing; exit 1 if a file is missing or differs
node scripts/gen-sounds.mjs --out DIR  # write to another folder (previews)
```

La salida es determinista: sale igual byte a byte con la misma versión mayor de Node. Si cambias el script, vuelve a generarlos y copia aquí la tabla que imprime.
