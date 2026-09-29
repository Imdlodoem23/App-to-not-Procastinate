# Cambios

Todos los cambios importantes de Céntrate. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [versionado semántico](https://semver.org/lang/es/).

## [Sin publicar]

## [0.3.0] - 2026-09-29

### Añadido

- **Mantener despierto**, como NoSleep o Caffeine: el ordenador no se suspende por inactividad durante 30 min, 1 h, 2 h, 4 h o hasta que lo desactives, aunque cierres la ventana, salgas de la app o reinicies, porque lo mantiene el guardián. Al acabar el tiempo se desactiva solo. Cerrar la tapa sigue haciendo lo que tenga configurado el sistema.
- Se activa desde el menú de la bandeja («Mantener despierto ▸»), desde el chip «Despierto · hasta las 18:30» del pie de la ventana o en Ajustes → Mantener despierto, que también tiene «Mantener también la pantalla encendida» (activado por defecto; la pantalla solo se mantiene mientras la app está abierta, también en la bandeja).
- Si el sistema no lo permite (por ejemplo, un Linux sin `systemd-inhibit`), la app avisa: «No se ha podido mantener despierto este equipo».
- No cambia los puntos ni ninguna regla de bloqueo, y activarlo o desactivarlo se aplica al momento, sin esperar 24 horas.
- Mantener despierto, en la web («Y mucho más»).

## [0.2.0] - 2026-09-29

### Añadido

- **Límites diarios** («YouTube máximo 30 minutos al día», «redes sociales 1 hora al día entre semana»): mientras te quede tiempo no se bloquea nada; cuando lo gastas, lo que hayas limitado queda bloqueado hasta las 0:00. Se escriben en el campo de la app (también en inglés: «limit YouTube to 30 min a day») o se editan en la sección «Límites diarios» de la ventana Bloqueos, con una barra de progreso («12 de 30 min hoy»).
- Avisos cuando te quedan 5 minutos y cuando has gastado el límite; la página de bloqueo de la extensión te dice «Has usado tus 30 min de YouTube de hoy. Vuelve mañana.».
- Estadísticas de los minutos usados de cada límite por día.
- Endurecer un límite (menos minutos, más webs o apps, más días o un modo más estricto) se aplica al momento; suavizarlo, desactivarlo o borrarlo espera 24 horas y nunca acorta el bloqueo de hoy.
- Los límites diarios, en la web («Y mucho más») y en su demo.

### Corregido

- El texto del chip de una web pendiente en la lista blanca se leía mal al pasar el ratón en modo oscuro.
- Las capturas en inglés mostraban la frase escrita en español.

## [0.1.2] - 2026-09-29

Primera versión pública (la 0.1.0 y la 0.1.1 no llegaron a publicarse: falló el instalador de macOS).

### Añadido

- **Bloqueo escribiendo lo que quieres hacer** («no veo YouTube en una hora»), con tarjeta de confirmación, modos Normal, Estricto, Hardcore y Examen, y ampliar con deshacer.
- **Guardián**: servicio del sistema que mantiene el bloqueo aunque cierres la app, la mates o reinicies; no se salta cambiando la hora.
- **Extensión** para Chrome, Edge, Brave y Firefox con la página de bloqueo, tu motivo y los puntos perdidos.
- Puntos, racha, niveles, recompensas, logros y mascota; estadísticas; horarios; Pomodoro y sonidos; mini temporizador y avisos grandes.
- App y web en español e inglés.

### Añadido

- Esqueleto del monorepo: app de escritorio, guardián, extensión, web y paquete compartido.
- CI en Windows, macOS y Linux.
- Marca de Céntrate, una «C» con un punto, igual en la app, la bandeja, la extensión y la web.
- Avisos de terceros (`third-party-notices.txt`) dentro de la app de escritorio y de la extensión.
