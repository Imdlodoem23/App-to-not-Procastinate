# Céntrate: textos de la web (es-ES)

Versión legible de todos los textos de la web. La fuente de verdad es `apps/web/src/content/copy.ts`: los componentes importan de ahí y no escriben textos propios. Si cambias un texto, cámbialo en los dos sitios.

Este documento sale de tres borradores de un panel de agentes, editados en uno solo con la sección 11 del brief y la guía de escritura de la skill `frontend-design`: verbos sencillos, datos concretos, sin relleno y desde el punto de vista de quien usa la app.

## Reglas de estilo

- **Mayúscula solo al empezar la frase.** «Study Mode» es un nombre propio y va siempre así.
- **Los titulares terminan en punto:** los de página y sección, los de las tarjetas, los arranques en negrita y los de los números. Las etiquetas no llevan punto: navegación, botones, nombres de funciones, preguntas del FAQ y cabeceras de tabla.
- **Signos:** el menos tipográfico «−» en los puntos negativos, comillas «», puntos suspensivos «…» y flechas «→» en las rutas de menús. Horas de 24 h y números en formato es-ES («1.240»).
- **Número y unidad no se separan:** en `copy.ts` van unidos con un espacio de no separación (`\u00a0`): «10 puntos», «1 h», «100 %». Las frases de ejemplo de la demo son la excepción, porque son lo que recibe el intérprete.
- **Voz:** tranquila y precisa, de tú. Las penalizaciones se cuentan como un dato, sin culpa. El humor se reserva para la página de bloqueo («YouTube seguirá ahí…»), la página 404 y el estado vacío de /novedades.
- **Un solo degradado en toda la web:** «Sigue funcionando.», en el titular de la escena pegajosa.
- **Notas al pie:** los números entre corchetes ([1]…[8]) remiten a la sección 12 y siguen el orden de aparición en la página de inicio. En `copy.ts`, cada referencia es un id (`note: 'admin'`) y el número lo calcula `footnoteNumber()`.
- **Marcas** (YouTube, Windows, macOS…) solo como texto. Nada de Apple ni de G-Helper en los textos.
- **Marcado en línea** (solo donde el componente lo renderiza con `inline()`): `**negrita**`, `` `código` `` y `[texto](enlace)`. Los huecos van entre llaves (`{version}`) y se rellenan con `fill()`, que comprueba los nombres al compilar.

## Decisiones del editor

| Hueco                   | Elegido                                        | Descartado                                                               | Por qué                                                                                                                                                        |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Titular del hero        | «Escríbelo. Y olvídate.»                       | «Escríbelo. Se cumple.», «Lo escribes. Se bloquea.»                      | En dos tiempos cuenta el producto entero: escribes una frase y te desentiendes, porque el bloqueo sigue aunque cierres la app.                                 |
| Titular de la demo      | «Pruébalo sin instalar nada.»                  | «Pruébalo. Aquí mismo.»                                                  | Dice qué ganas, no dónde estás.                                                                                                                                |
| Capítulo Bloqueo        | «Tú pones la frase. Céntrate pone el límite.»  | «Habla normal. Bloquea en serio.», «Se puede ampliar. Nunca acortar.»    | Reparte los papeles: tú escribes y la app cumple. Lo de ampliar queda en una tarjeta.                                                                          |
| Capítulo Study Mode     | «Mirar el cuaderno es estudiar. El móvil, no.» | «Sabe cuándo estudias. Y cuándo no.», «Si coges el móvil, se da cuenta.» | Es la frase más concreta y responde al miedo principal: que la IA castigue por mirar hacia abajo.                                                              |
| Capítulo Progreso       | «Cada minuto suma. Cada intento resta.»        | «Concentrarte suma. Rendirte resta.»                                     | Nombra las dos cosas que cuentan de verdad.                                                                                                                    |
| Botón del hero en Linux | Descarga el `.deb`                             | Ir a /descargar, descargar la AppImage                                   | Un botón que dice «Descargar» tiene que descargar. El .deb es el formato de Ubuntu y Debian, y la línea pequeña lo dice; la AppImage está en «Otros sistemas». |
| Botón del hero en móvil | «Ver las descargas»                            | «Descargar gratis»                                                       | En un móvil no hay nada que descargar: el botón lleva a /descargar y lo dice.                                                                                  |
| Página 404              | «Esta página no existe.» + un guiño            | «Esta página se ha ido a procrastinar.»                                  | Primero dice qué pasa y qué hacer; el humor va en la entradilla.                                                                                               |

Correcciones de datos respecto a los borradores:

- **Crear un bloqueo son dos Enter** (uno para revisar y otro para bloquear), no uno.
- **En la confirmación, la cabecera sigue en «Bloqueo: ninguno»:** nada aparece como activo hasta que el guardián lo confirma.
- **Desinstalar no promete «sin rastro»:** en Windows, `deleteAppDataOnUninstall: false` conserva la carpeta de datos del usuario, así que los textos recomiendan «Borrar todos mis datos» antes de desinstalar.
- **Sin la extensión no se promete que se cobre el intento** en el navegador: la nota 4 solo dice que la web no carga.
- **Horas coherentes en la ventana simulada:** bloqueo de 16:42 a 17:42, cuenta atrás en 42:18 y «quedan 42 min» en todas partes.
- **Privacidad sin garantías que no podemos afirmar:** no se nombran marcos de transferencia concretos para Render y GitHub.

## 1. Navegación, pie y textos comunes

- Marca: **Céntrate** (nombre accesible: «Céntrate, ir al inicio»)
- Enlaces: Funciones (`/#funciones`), Study Mode (`/#study-mode`), Privacidad (`/#privacidad`)
- Botón píldora: **Descargar** (nombre accesible: «Descargar Céntrate»)
- Nombre de la navegación: «Principal». Menú en móvil: «Abrir menú» / «Cerrar menú»
- Enlace para saltar: «Saltar al contenido»
- Vídeo: «Pausar», «Reproducir», «Repetir» (nombres accesibles: «Pausar el vídeo», «Reproducir el vídeo», «Repetir el vídeo»)
- Galerías: «Tarjeta anterior», «Tarjeta siguiente», «Galería: {name}», «Tarjeta {n} de {total}»
- Copiar: «Copiar» → «Copiado» (nombre accesible: «Copiar {what}»)
- Notas: «Nota {n}» y «Volver al texto»
- Versión: «Versión {version}»; si falla la API de GitHub, «Última versión». Fecha: «Publicada el {date}». Tamaño: «Tamaño». Sin dato: «No disponible»
- Duraciones: «{m} min», «{h} h», «{h} h {m} min»

**Pie de página**

- Enlaces: Descargar · Novedades · Privacidad · Código fuente · Informar de un problema
- Céntrate es software libre con licencia MIT.
- Esta web no usa cookies.
- YouTube, Windows, macOS y el resto de marcas citadas pertenecen a sus propietarios. Céntrate no está afiliado a ninguna de ellas.
- © 2026 Imdlodoem23 y colaboradores de Céntrate.

## 2. Hero

- Antetítulo (28 px): **Céntrate**
- Titular (64 px): **Escríbelo. Y olvídate.**
- Subtítulo opcional: Escribe qué quieres evitar y durante cuánto, y Céntrate lo bloquea aunque cierres la app.
- Botón y línea pequeña según el sistema:

| Sistema                               | Botón                         | Línea pequeña                                           |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------- |
| Windows (por defecto)                 | Descargar gratis para Windows | Gratis y sin cuenta. Windows 10 y 11.                   |
| macOS                                 | Descargar gratis para macOS   | Gratis y sin cuenta. Apple Silicon e Intel.             |
| Linux (descarga el .deb)              | Descargar gratis para Linux   | Gratis y sin cuenta. Paquete .deb para Ubuntu y Debian. |
| Móvil o desconocido (va a /descargar) | Ver las descargas             | Céntrate es para ordenador: Windows, macOS y Linux.     |

- Enlace: **Otros sistemas** → `/descargar`
- Nombre accesible del visual: La ventana de Céntrate: en el campo «¿Qué quieres hacer?» se escribe «no veo YouTube en una hora», se confirma con Enter y empieza una cuenta atrás de una hora.

## 3. Lo más destacado (`#funciones`)

- Titular: **Lo más destacado.**
- Botón de la píldora: «Pausar» / «Reanudar» (nombres accesibles: «Pausar el avance automático» / «Reanudar el avance automático»)
- Tarjetas:
  1. **Escríbelo y listo.** Escribe «no veo YouTube en una hora» y pulsa Enter dos veces: una para revisarlo y otra para bloquear.
  2. **Sigue bloqueado aunque cierres la app.** Ciérrala, termínala desde el Administrador de tareas o reinicia el ordenador: el bloqueo dura hasta el último minuto. [1]
  3. **Cada intento te cuesta 10 puntos.** No llegas a entrar. Y si lo vuelves a intentar en menos de 5 minutos, el siguiente cuesta el doble. [2]
  4. **El Study Mode te ve estudiar.** Una IA que funciona en tu ordenador nota si coges el móvil o te vas, y antes de nada te pregunta si sigues ahí. [3] _(tarjeta oscura con vídeo)_

## 4. Demo en vivo (`#prueba`)

- Titular: **Pruébalo sin instalar nada.**
- Entradilla: Escribe lo que quieres evitar, como lo dirías tú, y mira lo que haría Céntrate.
- Etiqueta del campo: **¿Qué quieres hacer?** · Ayuda: Por ejemplo, «no veo YouTube en una hora». · Botón: «Borrar»
- Frases de ejemplo («Prueba con»; rotan como placeholder cada 4 s):
  - «no veo YouTube en una hora»
  - «nada de TikTok ni Instagram durante 45 minutos»
  - «bloquea las redes sociales hasta las 20:30»
  - «sin juegos hora y media»
  - «no quiero ver Netflix 2h»
  - «estudiar mates 1 hora»
  - «sin insta media hora»
  - «nada de Discord hasta mañana a las 8»
  - «no veo series 1h30»
- Resultado, con el título «Esto haría Céntrate»:
  - Con duración: «Céntrate bloquearía {services} durante {duration}, hasta las {time}.»
  - Con hora de fin: «Céntrate bloquearía {services} hasta las {time} ({duration}).»
  - Categoría, en lugar de un servicio: «toda la categoría {category}»
  - Modo: «En modo Normal: después solo se podría ampliar, nunca acortar.»
  - Estudio: Céntrate te propondría un Study Mode de {duration} con la tarea «{task}».
  - Más de 4 h: «Son más de 4 horas: la app te pediría confirmarlo dos veces.»
  - Más de 24 h: «El máximo es 24 horas por bloqueo.»
  - Entendido a medias: He entendido {understood}, pero no «{rest}». En la app se abriría el formulario avanzado con eso ya puesto.
  - Nada entendido: No he entendido «{text}». La app no se inventaría nada: abriría el formulario avanzado para que lo elijas tú. + Prueba con un servicio y un tiempo, como «no quiero ver Netflix 2h».
  - Vacío: «Escribe una frase o elige un ejemplo.»
  - Filas: Qué se bloquea · Duración · Termina a las · Modo. Modo por defecto: Normal
- Letra pequeña: Es una demostración: aquí no se bloquea nada. Entiende las frases igual que la app, y lo que escribes no sale de esta página.

## 5. Escena pegajosa (`#guardian`)

- Titular (64 px): **Ciérrala. Sigue funcionando.** — el degradado va solo en «Sigue funcionando.», el único de toda la web.
- Entradilla: Los bloqueos los aplica el guardián, un pequeño servicio del sistema que instala Céntrate. Funciona con la app cerrada, después de reiniciar y aunque cambies la hora, y se quita solo cuando se acaba el tiempo. [1]
- Tiempos:
  1. **Cierras Céntrate.** Con la X, con «Salir» o desde el Administrador de tareas. La ventana se va; el bloqueo, no.
  2. **Abres youtube.com.** Por costumbre, casi sin pensarlo.
  3. **No carga. Y te cuesta 10 puntos.** En su lugar ves tu motivo, «Quiero aprobar mates», y lo que te ha costado el intento. [4]
- Navegador genérico: barra de direcciones «youtube.com»; pestaña «youtube.com», que pasa a «Bloqueado · Céntrate»
- Descripción para lectores de pantalla y versión estática: Animación en tres pasos: se cierra la ventana de Céntrate, un navegador intenta abrir youtube.com y, en su lugar, aparece la página de bloqueo de Céntrate con el motivo «Quiero aprobar mates» y −10 puntos.

## 6. Capítulos (fondo #f5f5f7)

### 6.1 Bloqueo (`#bloqueo`)

- Antetítulo: Bloqueo
- Titular: **Tú pones la frase. Céntrate pone el límite.**
- Entradilla: Escribe «nada de TikTok ni Instagram durante 45 minutos» y Céntrate entiende qué bloquear, cuánto y hasta qué hora. Lo confirmas con Enter y, desde ese momento, solo se puede ampliar.
- Galería (arranque en negrita + una frase):
  1. **Escribe como hablas.** Entiende «yt», «insta», «hora y media» o «hasta mañana a las 8», sin necesidad de internet. _(visual: typing)_
  2. **Tú confirmas.** Una tarjeta te enseña qué se bloquea, cuánto dura y a qué hora termina, y lo que no entiende no se lo inventa. _(visual: confirm)_
  3. **Webs y apps a la vez.** Bloquea webs en el navegador y cierra apps como Steam, Discord o Roblox si intentas abrirlas.
  4. **Solo se puede ampliar.** Añade 15 minutos, media hora o una hora con un clic; para acortar no hay botón. _(visual: countdown)_
  5. **Salir antes tiene un precio.** Escribes a mano una frase de compromiso, esperas 10 minutos (30 en Estricto) y pierdes al menos 200 puntos y tu racha; en Hardcore, no hay salida. [5]

### 6.2 Study Mode (`#study-mode`)

- Antetítulo: Study Mode
- Titular: **Mirar el cuaderno es estudiar. El móvil, no.**
- Entradilla: Di qué vas a estudiar y enciende la cámara. Una IA que funciona en tu ordenador comprueba si estás estudiando: si no, te avisa, y si sigues sin estudiar, bloquea tus distracciones durante una hora. [3]
- Galería (arranque en negrita + una frase):
  1. **Hecho a tu medida.** Una calibración de unos 2 minutos le enseña cómo estudias tú: mirando la pantalla, con un libro o con un cuaderno.
  2. **Primero pregunta.** Si te despistas 15 segundos, te pregunta «¿Sigues ahí?», y si sigues así 30 segundos más, es un strike y pierdes 15 puntos. _(visual: study)_
  3. **Aprende de sus errores.** Si te avisa sin motivo, pulsa «¡Estaba estudiando!» y lo tendrá en cuenta la próxima vez.
  4. **Tres strikes, una hora sin distracciones.** Al tercer strike, el guardián bloquea tus distracciones durante 60 minutos, aunque cierres la app. [6]
  5. **También sin cámara.** Si no tienes cámara o prefieres no usarla, el Study Mode se fija en la app que tienes delante y en tu actividad con el teclado y el ratón.

### 6.3 Progreso (`#progreso`)

- Antetítulo: Progreso
- Titular: **Cada minuto suma. Cada intento resta.**
- Entradilla: Los puntos salen de lo que pasa de verdad: los minutos que cumples suman y los intentos y los strikes restan. Gástalos en descansos, cuida tu racha y mira cómo crece tu mascota.
- Galería (arranque en negrita + una frase):
  1. **Así se ganan.** +1 punto por minuto de bloqueo cumplido, +2 por minuto concentrado en Study Mode y +20 si terminas una sesión sin ningún intento. _(visual: progress)_
  2. **Descansos ganados.** Canjea tus puntos por tiempo libre sin penalización, como 15 minutos de YouTube por 150 puntos. [7]
  3. **Una racha que cuidar.** Cada día que llegas a tu objetivo, 60 minutos concentrado si no lo cambias, tu racha suma un día.
  4. **Una mascota que crece contigo.** Pasa de brote a planta y de planta a árbol mientras te concentras, y se marchita si te rindes.
  5. **Puntos que nadie puede tocar.** Salen del registro del guardián, no se pueden editar en ningún sitio y el saldo puede quedar en números rojos.

## 7. Privacidad (`#privacidad`)

- Titular: **Tu cámara no sale de tu ordenador.**
- El Study Mode analiza la imagen en tu ordenador, unas pocas veces por segundo y a baja resolución, y la descarta al momento. No sabe quién eres: solo si hay alguien, hacia dónde mira y si hay un móvil o un libro.
- La cámara solo se enciende cuando empiezas una sesión, y mientras está encendida ves siempre el aviso «Cámara activa». Y como el código es abierto, cualquiera puede comprobarlo.
- Viñetas:
  - **No se guarda ninguna imagen.** Ni fotos ni vídeo: solo números, como los minutos que has estado concentrado.
  - **Todo se procesa en tu ordenador.** La IA va dentro de la app y funciona sin internet.
  - **Sin cuenta y sin cookies de seguimiento.** Ni en la app ni en esta web.
- Enlace: **Lee la política de privacidad** → `/privacidad`
- El icono animado de la cámara con candado es decorativo (`aria-hidden`).

## 8. Números como titulares (`#numeros`)

Nombre accesible de la sección: «Céntrate en números».

1. **−10 puntos por cada intento.** Si repites en menos de 5 minutos, se duplica: −20, −40, hasta −80. [2]
2. **60 minutos de castigo si no estudias.** Al tercer strike de una sesión, el guardián bloquea tus distracciones durante una hora. Cerrar la app no lo quita. [6]
3. **+2 puntos por cada minuto concentrado.** El doble que un minuto de bloqueo. Estudia 75 minutos y te habrás ganado 15 de YouTube. [7]

## 9. Y mucho más (`#mas-funciones`)

- Titular: **Y mucho más.**
- Funciones (nombre bajo un icono de 80 px, sin punto, y una frase):
  1. **Pomodoro.** 25/5, 50/10 o a tu medida, y en los descansos la cámara no vigila.
  2. **Horarios.** Bloqueos que se repiten solos, como las redes sociales de lunes a viernes de 16:00 a 19:00.
  3. **Límites diarios.** Como YouTube 30 minutos al día: cuando los gastas, queda bloqueado hasta medianoche.
  4. **Modo examen.** Solo tus webs de estudio y sin forma de cancelarlo hasta la hora que elijas.
  5. **Estadísticas.** Tu tiempo concentrado por día, semana y mes, con mapa de calor y exportación a CSV.
  6. **Sonidos.** Lluvia, ruido blanco o lo-fi, incluidos en la app y sin internet.
  7. **Extensión del navegador.** Para Chrome, Edge, Brave y Firefox: bloquea al instante y te enseña tu motivo.
  8. **Tu motivo.** Una frase tuya, como «Quiero aprobar mates», que aparece justo cuando intentas entrar.
  9. **Recordatorios.** «Es tu hora de estudiar» según tus horarios, y descansos para la vista con la regla 20-20-20.
  10. **Logros.** Tu primera sesión, 7 días de racha, 10 horas de Study Mode, una semana sin intentos…
- De reserva:
  - **Mini temporizador.** Una cuenta atrás pequeña y siempre visible que colocas donde quieras.
  - **Plantillas rápidas.** Deberes 1 h, Examen 3 h o Leer 30 min: un clic y Enter.
  - **Tareas de la sesión.** Apunta qué vas a hacer y, al terminar, di si lo has conseguido.

## 10. Preguntas frecuentes (`#preguntas`)

Titular: **Preguntas frecuentes.**

1. **¿Céntrate es gratis?**
   Sí, del todo: sin anuncios, sin cuenta y sin versión de pago. Es de código abierto, con licencia MIT, y puedes leer todo el código en GitHub.
2. **¿Se puede saltar un bloqueo?**
   Cerrar la app, terminarla desde el Administrador de tareas, reiniciar o cambiar la hora del ordenador no lo quitan. Aun así, seamos claros: en un ordenador del que eres administrador, ningún bloqueo es 100 % imposible de saltar. Céntrate te lo pone difícil y te cobra cada intento, porque está pensado para ayudarte a ti, no para encerrar a nadie.
3. **¿Y si de verdad necesito entrar?**
   En Normal y en Estricto tienes el desbloqueo de emergencia: escribes a mano «Acepto romper mi compromiso y perder mis puntos», esperas 10 minutos (30 en Estricto) y pierdes 200 puntos o la mitad de tu saldo, lo que sea más, además de tu racha. En Hardcore y en el modo examen no hay forma de cancelarlo, y Céntrate te lo avisa antes de confirmar.
4. **¿La cámara graba o envía algo?**
   No. Solo se enciende cuando empiezas el Study Mode, y mientras está encendida ves siempre el aviso «Cámara activa». Las imágenes se analizan en tu ordenador y se descartan al momento: ninguna se guarda, se sube ni sale del dispositivo. Si prefieres no usarla, hay un Study Mode sin cámara.
5. **¿Y si tapo la cámara o cierro la app en pleno Study Mode?**
   Tapar la cámara cuenta como que no estás, y al minuto suma un strike. Si cierras la app a la fuerza, a los 2 minutos cuenta como abandono y empieza el castigo. Los descansos del Pomodoro y las pausas no cuentan.
6. **¿Funciona sin internet?**
   Sí. Los bloqueos, los puntos y el Study Mode funcionan sin conexión, porque la IA va dentro de la app. Si hay internet, Céntrate solo lo usa para buscar actualizaciones en GitHub y comprobar que nadie ha adelantado el reloj.
7. **¿Por qué pide permiso de administrador?**
   Para instalar el guardián, el servicio del sistema que mantiene los bloqueos con la app cerrada. Lo pide una sola vez, y el guardián solo toca el archivo hosts, las apps de tu lista y su propia carpeta.
8. **¿Necesito la extensión? ¿Funciona en incógnito?**
   La extensión bloquea al instante en Chrome, Edge, Brave y Firefox, y te enseña la página de bloqueo con tu motivo. Sin ella, el guardián bloquea igual en todo el sistema, pero una web que ya estaba abierta puede tardar en cortarse. En incógnito solo funciona si se lo permites en los ajustes de la extensión; Céntrate lo detecta y te explica cómo hacerlo.
9. **Windows o macOS me avisan al abrirlo. ¿Es normal?**
   Sí. Los instaladores aún no están firmados con un certificado, que cuesta dinero cada año, así que el sistema no reconoce al autor. En Windows, pulsa «Más información» y después «Ejecutar de todas formas». En macOS, ve a Ajustes del Sistema → Privacidad y seguridad y pulsa «Abrir igualmente». Si quieres, [comprueba antes su SHA-256](/descargar#sha256).
10. **¿Por qué mi antivirus avisa del archivo hosts?**
    Porque Céntrate bloquea webs escribiendo en ese archivo, siempre dentro de su propia sección y con una copia previa, y algunos antivirus lo vigilan. Si el tuyo lo frena, permite el cambio para Céntrate: [los pasos están en la guía](/descargar#antivirus).
11. **¿Sirve como control parental?**
    No está hecho para eso. Céntrate ayuda a quien quiere concentrarse: no se esconde, su icono siempre está en la bandeja y se puede desinstalar cuando se quiera. Si lo va a usar tu hijo o tu hija, lo mejor es instalarlo juntos y que elija sus propios bloqueos.
12. **¿Cómo lo desinstalo?**
    Como cualquier programa y cuando quieras, también con un bloqueo activo: en ese caso, antes te avisa de que perderás los puntos y la racha. Al desinstalar se quitan el guardián, sus líneas del archivo hosts y todo lo que instaló. [Pasos para cada sistema](/descargar#desinstalar).

## 11. Descarga final (`#descargar`, sección oscura)

- Titular: **Céntrate es gratis.**
- Subtítulo: Sin cuenta, sin anuncios y de código abierto.
- Botones:
  - Descargar para Windows: `Centrate-Setup.exe`
  - Descargar para macOS: `Centrate.dmg`
  - Descargar para Linux (.deb): `Centrate.deb`
  - Descargar para Linux (AppImage): `Centrate.AppImage`
  - Enlace secundario: Extensión para Chrome, Edge y Brave: `Centrate-extension.zip`
- Requisitos:
  - Windows 10 u 11 de 64 bits.
  - macOS 12 o posterior, con Apple Silicon o Intel.
  - Ubuntu o Debian de 64 bits (.deb), u otra distribución de 64 bits (AppImage).
  - Permiso de administrador una vez, para instalar el guardián.
  - Chrome, Edge, Brave o Firefox, para la extensión.
  - Una webcam, solo para el Study Mode con cámara.
- Aviso: Windows y macOS mostrarán un aviso la primera vez que lo abras. [8]
- Enlaces: **Guía de instalación** → `/descargar` · **Novedades** → `/novedades` · «Versión {version}»

## 12. Notas al pie (`#notas`)

Título oculto a la vista: «Notas». Numeradas por orden de aparición en la página de inicio.

1. En un ordenador del que eres administrador no existe un bloqueo 100 % imposible de saltar. Céntrate te lo pone lo más difícil posible, sin esconderse y sin impedir nunca que lo desinstales.
2. Si repites un intento en menos de 5 minutos, la penalización se duplica (−10, −20, −40…) hasta un máximo de −80 puntos por intento. Si varias capas detectan el mismo servicio a la vez, o vuelve a aparecer en menos de 30 segundos, cuenta como un solo intento. El saldo puede quedar en negativo.
3. El Study Mode con cámara necesita una webcam. Sin ella puedes usar el Study Mode sin cámara, que solo tiene en cuenta la app o la web que tienes delante y tu actividad con el teclado y el ratón.
4. La página de bloqueo, con tu motivo y los puntos que pierdes, necesita la extensión de Céntrate para Chrome, Edge, Brave o Firefox. Sin ella, el guardián bloquea igual en todo el sistema, pero el navegador solo te dirá que la web no carga.
5. El desbloqueo de emergencia cuesta 200 puntos o la mitad de tu saldo, la cifra que sea mayor, además de tu racha. La espera se puede cancelar. No existe en Hardcore ni en el modo examen.
6. El castigo dura 60 minutos por defecto (de 15 a 120 en Ajustes) y bloquea todas tus distracciones; si quieres, puedes endurecerlo para dejar solo tus webs de estudio. Al empezar te resta 100 puntos, y cada strike, 15. Los descansos del Pomodoro y las pausas no cuentan.
7. Los precios de la tienda de recompensas son un ejemplo. Los descansos ganados no se pueden canjear durante un bloqueo Hardcore, el modo examen ni un castigo.
8. Los instaladores aún no están firmados con un certificado, así que Windows y macOS muestran un aviso la primera vez. En la guía de instalación te explicamos cómo abrirlos y cómo comprobar su SHA-256.

## 13. Textos de la ventana simulada (`AppWindow`)

Copias literales de la app (sección 10 del brief). Datos de ejemplo que cuadran: el bloqueo se confirma a las 16:42 para 1 h y el momento de la cuenta atrás son las 16:59:42.

- Título de la ventana: «Céntrate», «Céntrate · quedan 42 min», «Céntrate · estudiando»
- **Bloqueo en reposo:** «Bloqueo: ninguno» · «Próximo horario: 16:00»; campo «¿Qué quieres hacer?»; plantillas Deberes 1 h | Examen 3 h | Leer 30 min | Más…; ayuda «Escribe lo que quieres evitar y pulsa Enter.»
- **Escribiendo:** «no veo YouTube en una hora», con las fichas YouTube · 1 h · hasta 17:42
- **Confirmación** (la cabecera sigue en «Bloqueo: ninguno» hasta que el guardián confirma): YouTube · 1 h · termina a las 17:42; modos Normal | Estricto | Hardcore | Examen (seleccionado: Normal); ayuda «Normal: la emergencia tarda 10 min y cuesta al menos 200 puntos»; «Tu motivo»: Quiero aprobar mates; «Solo se puede ampliar, nunca acortar»; botones Editar… | Bloquear hasta 17:42
- **Cuenta atrás:** «Bloqueo: YouTube · Normal» · «hasta 17:42» con la píldora «Nuevo»; 42:18 (segundos atenuados; nombre accesible «Quedan 42 minutos»); motivo en cursiva «Quiero aprobar mates»; ampliar +15 min | +30 min | +1 h | Otro…; enlace «Desbloqueo de emergencia…»
- **Study Mode listo:** «Study Mode: listo» · «Con cámara · calibrado»; 25/5 | 50/10 | 1 h | Más…
- **Estudiando:** bloqueo plegado «Bloqueo: YouTube · 42 min»; «Study Mode: historia · 32:10» con la píldora «● Cámara activa»; medidor «Concentrado» y strikes («Strikes: 0 de 3»); Pausa (2) | Sonido: Lluvia | Vista previa | Terminar
- **Progreso:** «Nivel 7 · 1.240 puntos» · «Racha: 5 días»; «Hoy: 42 de 60 min»; Estadísticas… | Recompensas… | Logros…
- **Pie:** «● Guardián activo · ● Extensión conectada» · «v{version}»; Mini temporizador | Ajustes… | Salir
- **Página de bloqueo:** «YouTube: bloqueado» · «quedan 42 min»; motivo «Quiero aprobar mates»; «−10 puntos» en rojo; «YouTube seguirá ahí dentro de 42 minutos. Tus deberes, no.»; botón «Volver a lo mío»
- Nombre accesible por estado (`role="img"`):
  - `idle`: Ventana de Céntrate en reposo, con el campo «¿Qué quieres hacer?» y las plantillas Deberes 1 h, Examen 3 h y Leer 30 min.
  - `typing`: Ventana de Céntrate con «no veo YouTube en una hora» escrito en el campo. La app ha entendido YouTube, 1 hora, hasta las 17:42.
  - `confirm`: Tarjeta de confirmación de Céntrate: bloquear YouTube durante 1 hora, hasta las 17:42, en modo Normal y con el motivo «Quiero aprobar mates».
  - `countdown`: Ventana de Céntrate con YouTube bloqueado hasta las 17:42. Quedan 42 minutos.
  - `study`: Ventana de Céntrate en Study Mode, estudiando historia, con la cámara activa y el medidor en «Concentrado».
  - `progress`: Progreso en Céntrate: nivel 7, 1.240 puntos, racha de 5 días y 42 de 60 minutos hoy.
  - `blocked-page`: Página de bloqueo de Céntrate: YouTube bloqueado, quedan 42 minutos, motivo «Quiero aprobar mates» y −10 puntos.

## 14. Títulos y descripciones

| Página      | `<title>`                                          | Descripción                                                                                                                                                 |
| ----------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /           | Céntrate: la app gratis para dejar de procrastinar | Escribe «no veo YouTube en una hora» y Céntrate lo bloquea aunque cierres la app. Con Study Mode y puntos. Gratis y sin cuenta para Windows, macOS y Linux. |
| /descargar  | Descargar Céntrate para Windows, macOS y Linux     | Descarga Céntrate gratis. Pasos para cada sistema, la extensión del navegador, cómo pasar los avisos de seguridad, comprobar el SHA-256 y desinstalar.      |
| /novedades  | Novedades · Céntrate                               | Qué cambia en cada versión de Céntrate, tal y como se publica en GitHub.                                                                                    |
| /privacidad | Política de privacidad · Céntrate                  | Qué guarda Céntrate y dónde: todo en tu ordenador, la cámara al 100 % en local y sin cuenta ni cookies de seguimiento. Adaptada al RGPD.                    |
| 404         | Página no encontrada · Céntrate                    | Esta página no existe. Vuelve al inicio o descarga Céntrate.                                                                                                |

- `og:title` de la página de inicio: «Céntrate. Escríbelo. Y olvídate.»; `og:site_name`: Céntrate; `og:locale`: es_ES
- Texto alternativo de la imagen Open Graph: «La ventana de Céntrate con YouTube bloqueado hasta las 17:42 y una cuenta atrás.»

## 15. Página /descargar

- Titular: **Descarga Céntrate.**
- Entradilla: Gratis, sin cuenta y de código abierto. Elige tu sistema y sigue los pasos: son unos minutos.
- Versión: «Versión {version}» · «Publicada el {date}»; si falla: «Última versión disponible en GitHub.»
- En móvil: Céntrate es para ordenador. Abre esta página desde tu Windows, macOS o Linux.
- Índice («En esta página»): Windows (`#windows`) · macOS (`#macos`) · Linux (`#linux`) · Extensión (`#extension`) · Avisos de seguridad (`#avisos`) · Comprobar la descarga (`#sha256`) · Antivirus (`#antivirus`) · Qué se instala (`#que-instala`) · Problemas frecuentes (`#problemas`) · Desinstalar (`#desinstalar`) · Requisitos (`#requisitos`)

### Instalar en Windows.

Windows 10 u 11 de 64 bits. Botón: **Descargar Centrate-Setup.exe**.

1. Descarga **Centrate-Setup.exe** y ábrelo.
2. Si aparece «Windows protegió su PC», pulsa **Más información** y después **Ejecutar de todas formas**.
3. Cuando Windows pregunte si quieres permitir que la app haga cambios en el dispositivo, pulsa **Sí**. Es la única vez que te pide permiso de administrador, y sirve para instalar el guardián.
4. Termina el instalador y abre Céntrate. Su icono aparece en la bandeja del sistema, junto al reloj; si no lo ves, pulsa la flecha de los iconos ocultos.
5. Sigue la bienvenida: instala la extensión, prueba la cámara si quieres y crea tu primer bloqueo.

> - En Windows, Céntrate se actualiza solo cuando sale una versión nueva.

### Instalar en macOS.

macOS 12 o posterior. Una sola descarga para Apple Silicon e Intel. Botón: **Descargar Centrate.dmg**.

1. Descarga **Centrate.dmg**, ábrelo y arrastra Céntrate a la carpeta **Aplicaciones**.
2. Abre Céntrate desde Aplicaciones. macOS avisará de que no puede comprobar la app: cierra el aviso sin moverla a la Papelera.
3. Ve a **Ajustes del Sistema → Privacidad y seguridad**, baja hasta **Seguridad** y pulsa **Abrir igualmente** junto al mensaje sobre Céntrate. Confírmalo con tu contraseña. El botón solo aparece durante un rato después de intentar abrir la app.
4. La primera vez, Céntrate te pide la contraseña de administrador para instalar el guardián. Solo lo hace una vez.
5. Si vas a usar el Study Mode con cámara, permite el acceso a la cámara cuando te lo pida.

> - Opcional: con el permiso de **Grabación de pantalla**, Céntrate también detecta cuándo tienes delante algo bloqueado. Solo lee el título de la ventana activa y no graba nada. Sin ese permiso, todo lo demás funciona igual.
> - En macOS, Céntrate no se actualiza solo: cuando hay una versión nueva, te avisa y te trae a esta página.

### Instalar en Linux.

Ubuntu o Debian de 64 bits. La AppImage sirve para otras distribuciones.

**Paquete .deb.** Recomendado en Ubuntu y Debian. Botón: **Descargar Centrate.deb**.

1. Descarga **Centrate.deb**.
2. Instálalo con doble clic desde tu gestor de software o, en una terminal abierta en la carpeta de descargas, con `sudo apt install ./Centrate.deb`.
3. El guardián se instala y arranca solo. Abre Céntrate desde el menú de aplicaciones.

**AppImage.** Para otras distribuciones de 64 bits. Botón: **Descargar Centrate.AppImage**.

1. Descarga **Centrate.AppImage**.
2. Dale permiso de ejecución en Propiedades → **Permitir ejecutar como programa**, o con `chmod +x Centrate.AppImage`.
3. Ábrelo. La primera vez te pedirá tu contraseña para instalar el guardián.

> - Si la AppImage no se abre, instala FUSE 2: `sudo apt install libfuse2t64` en Ubuntu 24.04 o posterior, o `sudo apt install libfuse2` en versiones anteriores.

### Instalar la extensión.

La extensión bloquea al instante dentro del navegador y te enseña la página de bloqueo con tu motivo. Sin ella, el bloqueo del sistema sigue activo, pero una web puede tardar en dejar de cargar. Instálala en cada navegador que uses.

**Chrome, Edge y Brave.** De momento se instala a mano, como extensión descomprimida. Son un par de minutos. Botón: **Descargar Centrate-extension.zip**.

1. Descarga **Centrate-extension.zip** y descomprímelo en una carpeta que no vayas a mover ni borrar, por ejemplo en Documentos.
2. Abre la página de extensiones: `chrome://extensions` en Chrome, `edge://extensions` en Edge o `brave://extensions` en Brave.
3. Activa el **Modo de desarrollador**.
4. Pulsa **Cargar descomprimida** (en Edge, **Cargar desempaquetada**) y elige la carpeta.
5. Escribe el código de emparejamiento que te enseña Céntrate en la bienvenida o en **Ajustes… → Sistema**.
6. Para que funcione también en incógnito, pulsa **Detalles** en la extensión y activa **Permitir en modo incógnito** (en Edge, **Permitir en InPrivate**).

> - No borres ni muevas la carpeta: el navegador carga la extensión desde ahí.
> - Es normal que el navegador te recuerde que tienes extensiones en modo de desarrollador. No la desactives.
> - Para actualizarla, sustituye el contenido de la carpeta por el de la versión nueva y pulsa el botón de recargar de la extensión.

**Firefox.** Botón: **Ver la última versión en GitHub** (enlaza a la última Release).

1. Abre la última versión en GitHub y descarga el archivo que acaba en **.xpi**.
2. Arrástralo a una ventana de Firefox y pulsa **Añadir**.
3. Si te pide acceso a todos los sitios web, acéptalo: sin ese permiso no puede bloquear.
4. Escribe el código de emparejamiento que te enseña Céntrate.
5. Para las ventanas privadas, abre `about:addons` → Céntrate y, en **Ejecutar en ventanas privadas**, elige **Permitir**.

> - Si la última versión aún no trae el archivo .xpi, la extensión para Firefox llegará en la próxima. Mientras tanto, el guardián bloquea igual en todo el sistema.

### Por qué aparece un aviso.

Firmar los instaladores con un certificado cuesta dinero cada año, y Céntrate aún no lo hace. Por eso Windows y macOS avisan la primera vez que lo abres. No significa que el archivo tenga nada malo, sino que el sistema no conoce al autor. El código es abierto y cada versión publica su SHA-256 para que compruebes que el archivo es el original.

- **Windows (SmartScreen):** «Windows protegió su PC» → **Más información** → **Ejecutar de todas formas**.
- **macOS:** **Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente**.

### Comprueba que es el original.

Cada versión publica el archivo **SHA256SUMS.txt** con la huella SHA-256 de cada descarga. Funciona como una huella dactilar: si cambia un solo byte del archivo, la huella cambia por completo. Calcula la de tu archivo y compárala con la publicada.

Tabla: Archivo · Tamaño · SHA-256 · «Copiar». Sin dato: «No disponible». Enlace: **Descargar SHA256SUMS.txt**.

- Windows (PowerShell): `Get-FileHash .\Centrate-Setup.exe -Algorithm SHA256`
- macOS (Terminal): `shasum -a 256 Centrate.dmg`
- Linux: `sha256sum Centrate.deb`

Si no coinciden, no lo abras: bórralo y descárgalo otra vez desde esta página.

### Si tu antivirus avisa.

Céntrate bloquea webs escribiendo en el archivo hosts, siempre entre las líneas `# >>> CENTRATE START` y `# <<< CENTRATE END` y con una copia de seguridad previa. Algunos antivirus vigilan ese archivo.

- En Windows, abre **Seguridad de Windows → Protección antivirus y contra amenazas → Historial de protección**, elige el aviso sobre el archivo hosts y pulsa **Acciones → Permitir en el dispositivo**.
- En otros antivirus, añade una excepción para el guardián de Céntrate (`centrate-guardian`).

### Qué instala Céntrate.

- **La app**, que vive en la bandeja del sistema y siempre se ve.
- **El guardián**, un servicio del sistema que aplica los bloqueos aunque la app esté cerrada. Solo toca el archivo hosts, las apps que tú bloqueas y su propia carpeta.
- **Una sección del archivo hosts**, siempre entre `# >>> CENTRATE START` y `# <<< CENTRATE END`. El resto del archivo no lo toca.
- **Nada más, y nada oculto.** Lo puedes desinstalar cuando quieras.

### Problemas frecuentes.

- **«Guardián detenido».** Abre Céntrate y pulsa **Reparar**. Si sigue igual, vuelve a ejecutar el instalador.
- **La web bloqueada sigue cargando.** Comprueba que la extensión está instalada y emparejada. Sin ella, los navegadores con DNS seguro o con la web ya abierta pueden tardar en respetar el bloqueo; cerrar y volver a abrir el navegador ayuda.
- **El Study Mode no encuentra la cámara.** En Windows, ve a **Configuración → Privacidad y seguridad → Cámara** y activa el acceso de las aplicaciones de escritorio. En macOS, ve a **Ajustes del Sistema → Privacidad y seguridad → Cámara** y activa Céntrate.
- **No veo el icono en Linux.** En Debian con GNOME, instala y activa la extensión AppIndicator para que Céntrate aparezca en la barra.

### Desinstalar Céntrate.

Siempre se puede, también con un bloqueo activo. Se quitan el guardián, las líneas que Céntrate añadió al archivo hosts y todo lo que instaló. Si hay un bloqueo en marcha, te avisa antes: se quitará y perderás tus puntos y tu racha.

- **Windows 11:** **Configuración → Aplicaciones → Aplicaciones instaladas**, pulsa «···» junto a Céntrate y elige **Desinstalar**.
- **Windows 10:** **Configuración → Aplicaciones → Aplicaciones y características**, elige Céntrate y pulsa **Desinstalar**.
- **macOS:** En Céntrate, abre **Ajustes… → Sistema → Desinstalar Céntrate…** y confírmalo con tu contraseña. Así se quitan el guardián y sus líneas del archivo hosts. Después, arrastra Céntrate de Aplicaciones a la Papelera.
- **Linux (.deb):** Desde tu gestor de software o con `sudo apt remove centrate`.
- **Linux (AppImage):** En Céntrate, abre **Ajustes… → Sistema → Desinstalar Céntrate…**. Después, borra el archivo Centrate.AppImage.
- **Extensión:** En la página de extensiones de tu navegador, pulsa **Quitar**. En Chrome, Edge y Brave, borra después su carpeta.

> Si también quieres borrar tus estadísticas y ajustes, antes de desinstalar usa **Ajustes… → Datos → Borrar todos mis datos**.

### Requisitos.

- Windows 10 u 11 de 64 bits, macOS 12 o posterior (Apple Silicon o Intel), o Ubuntu o Debian de 64 bits.
- Permiso de administrador una vez, para instalar el guardián.
- Chrome, Edge, Brave o Firefox, para la extensión.
- Una webcam, solo para el Study Mode con cámara.
- No necesitas internet ni cuenta.

Cierre: **Todas las versiones en GitHub** · **Novedades** · ¿Algo no funciona? **Abre una incidencia en GitHub**.

## 16. Página /novedades

- Titular: **Novedades.**
- Entradilla: Qué cambia en cada versión de Céntrate, tal y como se publica en GitHub.
- Cada versión: «Versión {version}» · «Publicada el {date}». La más reciente lleva la píldora «Última versión» y el botón «Descargar»; todas, el enlace «Ver en GitHub».
- Versión más nueva que la página (la página se genera al publicar la web; si GitHub ya tiene otra posterior): «Hay una versión nueva: la {version}.» + enlace «Ver en GitHub»
- Cargando: «Cargando las novedades…»
- Error: «Ahora mismo no se pueden cargar las novedades desde GitHub.» + botón «Ver todas las versiones en GitHub»
- Vacío: «Aún no hay ninguna versión publicada. La primera está al caer.»
- Llamada final: **Descargar la última versión**

## 17. Página /privacidad

**Política de privacidad.**

Última actualización: 27 de septiembre de 2026.

Céntrate funciona sin cuenta, sin internet y sin enviarnos nada. Aquí tienes qué datos se tratan, dónde se guardan y qué derechos tienes, según el Reglamento General de Protección de Datos (RGPD) y la ley española de protección de datos (LOPDGDD).

**En resumen**

- Todo lo que usa la app se guarda en tu ordenador. No lo recibimos y no podemos verlo.
- La cámara se procesa al 100 % en tu ordenador: ninguna imagen se guarda, se sube ni sale del dispositivo.
- Sin cuenta, sin telemetría, sin anuncios y sin cookies de seguimiento.

**1. Quién es el responsable.**

Céntrate es un proyecto de código abierto, con licencia MIT, publicado en GitHub por su autor, titular de la cuenta [Imdlodoem23](https://github.com/Imdlodoem23), que es quien responde de esta web y de la app.

La app no nos envía tus datos: todo lo que se describe aquí lo guarda y lo trata tu propio ordenador. Para cualquier consulta, mira el apartado «Cambios y contacto».

**2. Qué guarda la app y dónde.**

Todo esto se guarda solo en tu ordenador:

- tus bloqueos, horarios, plantillas, ajustes y tu motivo;
- las tareas de tus sesiones de Study Mode;
- tus puntos, tu XP, tu racha y tus logros, y el registro de eventos del que salen: intentos, strikes, castigos, bloqueos cumplidos y desbloqueos de emergencia;
- tus estadísticas, como los minutos concentrado y el número de avisos;
- la calibración del Study Mode, que son solo números, nunca fotos;
- registros técnicos rotativos, sin datos personales, para diagnosticar fallos.

Una parte la guarda el guardián en una carpeta del sistema que solo él puede modificar, para que nadie pueda hacer trampa: `C:\ProgramData\Centrate\` en Windows, `/Library/Application Support/Centrate/` en macOS y `/var/lib/centrate/` en Linux. El resto está en la carpeta de datos de la app, dentro de tu usuario.

«Copiar diagnóstico», en Ajustes, solo copia esos registros técnicos a tu portapapeles: tú decides si los compartes.

**3. La cámara, 100 % en tu ordenador.**

- Solo se enciende cuando tú empiezas el Study Mode, después de que des tu consentimiento la primera vez. Mientras está encendida, ves siempre el aviso «Cámara activa».
- Analiza entre 2 y 4 imágenes por segundo, a baja resolución, con modelos de IA que van dentro de la app y funcionan sin internet.
- Cada imagen se descarta al momento: no se guarda, no se sube y no sale de tu ordenador. La vista previa es opcional y solo aparece en tu pantalla.
- No te identifica: no hay reconocimiento facial. Solo comprueba si hay alguien, hacia dónde mira, si tiene los ojos cerrados mucho rato y si aparece un móvil o un libro.
- La calibración y el botón «¡Estaba estudiando!» guardan números, como los ángulos de la cabeza o la probabilidad de que haya un móvil, nunca imágenes. Puedes recalibrar cuando quieras, y «Borrar todos mis datos» la elimina.
- Puedes usar el Study Mode sin cámara, que solo tiene en cuenta la app que tienes delante y tu actividad con el teclado y el ratón.

**4. La extensión del navegador.**

La extensión compara, dentro de tu navegador, cada web que abres con tu lista de bloqueos activos. Necesita permiso para todos los sitios web porque es la única forma de desviar los que bloqueas.

Solo se comunica con el guardián en tu propio ordenador (`127.0.0.1`): recibe la lista de lo que está bloqueado y le avisa de los intentos. No guarda tu historial ni lo envía a ningún sitio.

**5. Cuándo se conecta la app a internet.**

La app funciona sin conexión. Si hay internet, solo se conecta para:

- comprobar en GitHub si hay una versión nueva y, si la hay, descargarla (en macOS solo te avisa);
- contrastar la hora con un servidor de hora, para que adelantar el reloj del ordenador no acabe un bloqueo antes de tiempo.

Ninguna de las dos conexiones envía datos tuyos, aunque, como en cualquier conexión, el servidor ve tu dirección IP. No hay telemetría: la app no nos envía estadísticas de uso ni informes de errores.

**6. Esta web.**

- **Sin cookies.** No usamos cookies ni herramientas de analítica o publicidad, así que no verás un aviso de cookies. La web puede recordar en tu navegador alguna preferencia, como si has pausado el avance de las tarjetas, y ese dato no sale de él.
- **Tipografía propia.** Las fuentes se sirven desde esta misma web, sin conectar con servicios de terceros.
- **Alojamiento.** La web está alojada en Render. Como cualquier servidor, registra datos técnicos de cada visita (dirección IP, fecha, página pedida y navegador) para servirla y protegerla de abusos. No los usamos para saber quién eres ni los cruzamos con nada.
- **GitHub.** Para enseñarte la última versión, la web puede consultar desde tu navegador la API pública de GitHub, y las descargas salen de GitHub Releases. En los dos casos, GitHub recibe tu dirección IP, como en cualquier visita a su web.
- **La demo.** La prueba de la página de inicio funciona en tu navegador: lo que escribes no se envía a ningún sitio.

**7. Base legal.**

- **Datos de la app:** se tratan en tu ordenador y bajo tu control. Nosotros no accedemos a ellos.
- **Cámara:** tu consentimiento (artículo 6.1.a del RGPD), que das en la app la primera vez y puedes retirar cuando quieras dejando de usar la cámara o usando el Study Mode sin cámara.
- **Registros técnicos de la web:** nuestro interés legítimo en servirla y mantenerla segura (artículo 6.1.f del RGPD).

**8. Cuánto tiempo se guardan.**

Los datos de la app se quedan en tu ordenador hasta que los borras con **Ajustes → Datos → Borrar todos mis datos**. Al desinstalar Céntrate se quitan el guardián y su carpeta del sistema; para borrar también tus estadísticas y ajustes, usa antes esa opción.

Los registros técnicos de la web se conservan el tiempo que marque la política de Render.

**9. Con quién se comparten.**

Con nadie: no vendemos ni cedemos datos. Los únicos proveedores son Render, que aloja la web, y GitHub, que aloja el código, las descargas y las incidencias. Las dos son empresas con sede en Estados Unidos, así que esos datos técnicos pueden tratarse fuera de la Unión Europea, según sus propias políticas de privacidad.

**10. Tus derechos.**

Tienes derecho de acceso, rectificación, supresión, oposición, limitación del tratamiento y portabilidad, y a retirar tu consentimiento. Como los datos de la app están en tu ordenador, los ejerces tú mismo, sin pedirnos nada:

- **Acceso y portabilidad:** Ajustes → Datos → **Exportar**, en CSV.
- **Supresión:** Ajustes → Datos → **Borrar todos mis datos**, que te pide escribir BORRAR. Los bloqueos en curso no se borran: terminan a su hora.
- **Rectificación:** cambia tus ajustes, horarios y plantillas cuando quieras. Los puntos no se pueden editar, para que nadie haga trampas, pero sí se pueden borrar.

Para cualquier otra cosa, escríbenos (apartado «Cambios y contacto»). Si crees que no hemos respetado tus derechos, puedes reclamar ante la Agencia Española de Protección de Datos ([aepd.es](https://www.aepd.es)).

**11. Menores.**

Céntrate no pide cuenta ni datos personales a nadie, tampoco a menores. Si tienes menos de 14 años, lee esta política con tu madre, tu padre o tu tutor, y usa el Study Mode con cámara solo con su permiso.

**12. Seguridad.**

Solo el guardián se ejecuta como administrador, y únicamente hace lo imprescindible: el archivo hosts, las apps de tu lista y su propia carpeta. Escucha solo en tu propio ordenador (`127.0.0.1`), exige una clave para cualquier cambio, valida todo lo que recibe y no tiene ninguna forma de terminar un bloqueo antes de tiempo.

**13. Cambios y contacto.**

Si esta política cambia, lo verás aquí con la nueva fecha y en las [novedades](/novedades). Si algún día hay funciones en línea, como cuentas o estudiar con amigos, serán opcionales y esta política se actualizará antes de que existan.

Para cualquier consulta, abre una incidencia en [GitHub](https://github.com/Imdlodoem23/App-to-not-Procastinate/issues). Las incidencias son públicas: no escribas en ellas datos personales. Si necesitas tratar algo en privado, dilo en la incidencia y te indicaremos un canal privado.

## 18. Página 404

- Titular: **Esta página no existe.**
- Entradilla: No la hemos bloqueado, te lo prometemos: puede que el enlace esté mal escrito o que la página se haya movido.
- Botones: **Ir al inicio** · **Descargar Céntrate**

## Pendiente de confirmar antes de publicar

1. **Versión mínima de macOS.** «macOS 12 o posterior» viene de lo que exige Electron desde la versión 38. Hay que confirmarlo con Electron 44 y, si cambia, actualizar `download.requirements`, `pages.descargar.macos` y `pages.descargar.requirements`.
2. **Desinstalar en macOS y con AppImage.** Los pasos dan por hecho un botón **Ajustes… → Sistema → Desinstalar Céntrate…** que quita el guardián y la sección del hosts. El brief no lo define y el código aún no lo tiene. Si no se construye, hay que cambiar esos pasos por el comando de desinstalación del guardián cuando su ruta sea definitiva.
3. **Datos al desinstalar en Windows.** `apps/desktop/electron-builder.yml` tiene `deleteAppDataOnUninstall: false`, mientras que `PRIVACY.md` dice que al desinstalar «se borra todo lo que instaló». Hay que alinear los dos; la web ya evita prometerlo.
4. **Extensión para Firefox.** El `.xpi` firmado solo existe si están las claves de AMO, y su nombre lleva la versión. Por eso /descargar enlaza a la última Release y avisa por si aún no está. Si se quiere un enlace fijo, hay que renombrarlo en `release.yml` (por ejemplo, `Centrate-firefox.xpi`).
5. **Servidor de hora.** La política de privacidad habla de «un servidor de hora» sin nombrarlo. Si el guardián usa uno concreto, conviene nombrarlo; si no usa ninguno, hay que quitar esa línea aquí y en el FAQ «¿Funciona sin internet?».
6. **Versión en la web.** La política dice que la web «puede consultar desde tu navegador» la API de GitHub. Si la versión se lee solo al compilar, se puede quitar esa parte.
7. **Preferencias en el navegador.** La política dice que la web «puede recordar» si has pausado las tarjetas. Si ningún componente usa `localStorage`, se puede quitar la frase.
8. **Responsable en /privacidad.** Solo figura la cuenta de GitHub, y el artículo 13 del RGPD pide la identidad del responsable. Si el dueño quiere publicar un nombre o un correo de contacto, va a `PENDIENTE_PARA_MI.md`.
9. **Textos del sistema.** Conviene comprobar en un Windows en español «Windows protegió su PC», «Protección antivirus y contra amenazas» y «Permitir en el dispositivo», y en macOS que el aviso de una app sin firmar sigue permitiendo «Abrir igualmente».
10. **Demo.** Las frases de ejemplo nuevas («sin insta media hora», «nada de Discord hasta mañana a las 8», «no veo series 1h30») tienen que entrar en los tests del intérprete de `packages/shared`.
