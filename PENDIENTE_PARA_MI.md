# Pendiente para ti

Cosas que dependen de ti (cuentas, credenciales, ajustes del repositorio o pruebas en tu ordenador). Mientras tanto, la app usa una alternativa temporal y el trabajo sigue.

## 1. Poner `main` como rama por defecto del repositorio

Ahora mismo la rama por defecto es `claude/magical-maxwell-h8t2nw`. Desde esta sesión no se puede cambiar.

1. Abre <https://github.com/Imdlodoem23/App-to-not-Procastinate/settings>.
2. En **General → Default branch**, pulsa el icono de las flechas, elige `main` y confirma con **Update**.

Mientras no lo hagas: el CI y las releases funcionan igual (`release.yml` también se lanza al fusionar en `main` un cambio de versión), pero el botón **Run workflow** de GitHub Actions solo aparece para los workflows de la rama por defecto.

## 2. Dominios bloqueados por la red de la sesión

La red de la sesión en la nube bloquea estos dominios. Las pruebas que los necesitan se hacen en GitHub Actions:

- `www.apple.com`: las capturas de referencia de la web las hace el workflow **Apple reference** (`apple-reference.yml`, manual). Hay que lanzarlo una vez (Actions → Apple reference → Run workflow) y pasar sus medidas a `docs/web/referencia-apple.md`; hasta entonces, la columna de apple.com de ese documento está pendiente.
- `cdn.jsdelivr.net`
- `api.render.com`: se usa el conector de Render, si está disponible.

## 3. Crear la web en Render (tu cuenta está en el límite de 25 servicios)

Al crear el Static Site `centrate`, Render respondió: «Hobby Tier is limited to 25 services». No he tocado ninguno de tus servicios.

1. En <https://dashboard.render.com>, borra algún servicio que ya no uses (por ejemplo, uno de los suspendidos: `shooter`, `temario` o `territorial-2-0`). **Borrar** libera el hueco; suspender no.
2. Render → **New → Blueprint** → elige `Imdlodoem23/App-to-not-Procastinate` → rama `main` → **Apply**. El archivo `render.yaml` ya trae el build, la carpeta publicada, las cabeceras de seguridad y de caché y el despliegue automático.
3. La URL será `https://centrate.onrender.com` (o parecida si el nombre está cogido).

Si prefieres no borrar nada, la siguiente sesión de trabajo volverá a intentar crearlo con el conector de Render en cuanto haya un hueco.

## 4. Firmar la extensión para Firefox (opcional)

Sin firma, Firefox borra la extensión al cerrarse. Para que `release.yml` la firme como «unlisted»:

1. Entra en <https://addons.mozilla.org/developers/addon/api/key/> con tu cuenta de Firefox y genera las credenciales.
2. En GitHub: **Settings → Secrets and variables → Actions → New repository secret**, crea `AMO_JWT_ISSUER` (el «JWT issuer») y `AMO_JWT_SECRET` (el «JWT secret»).
3. La siguiente release incluirá el `.xpi` firmado.

## 5. Activar la nube opcional: cuentas, amigos y coach (Fase 6)

Todo esto es opcional. Sin ello, la app funciona al 100 % sin cuenta y sin internet. El servidor (`apps/api`) arranca aunque falten claves: cada función se enciende sola cuando pones la suya, y `/health` dice cuáles están activas y por qué no lo están las demás. Pon las claves **solo** en el panel de Render (**centrate-api → Environment**), nunca en el repositorio.

**Antes de nada, el límite de Render.** Tu cuenta está en el límite de 25 servicios (punto 3). La API es un servicio más (`centrate-api`) y necesita también la base de datos `centrate-db`. Así que tienes que liberar un hueco borrando algún servicio que no uses (borrar, no suspender). Además, Render solo deja **una base de datos gratuita por workspace**: si ya tienes otra, bórrala o pon `centrate-db` en un plan de pago.

1. **Desplegar.** Render → **New → Blueprint** → `Imdlodoem23/App-to-not-Procastinate` → rama `main` → **Apply** (es el mismo Blueprint del punto 3; crea la web, `centrate-api` y `centrate-db`). Render te pedirá los valores marcados como secretos; deja vacíos los que aún no tengas.
2. **`BETTER_AUTH_SECRET`**: no tienes que hacer nada, Render lo genera solo. No lo cambies después: cerraría la sesión de todo el mundo. (Si despliegas en otro sitio: `openssl rand -base64 48`).
3. **`BETTER_AUTH_URL`**: la URL pública del servicio, sin barra final, tal como aparece en Render (por ejemplo `https://centrate-api.onrender.com`). Sin ella las cuentas siguen apagadas. Si la URL no es esa porque el nombre estaba cogido, dímelo para que la app apunte a la buena.
4. **Iniciar sesión con Google** (`GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`):
   1. En <https://console.cloud.google.com> crea un proyecto «Céntrate».
   2. **APIs y servicios → Pantalla de consentimiento de OAuth**: tipo «Externo», nombre «Céntrate», tu email de asistencia, permisos `openid`, `email` y `profile` (con solo estos no hace falta verificación de Google). Publica la aplicación («En producción»).
   3. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación web**. En «URI de redirección autorizados» añade `https://centrate-api.onrender.com/api/auth/callback/google` (con tu URL del paso 3).
   4. Copia el ID de cliente y el secreto a `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.
5. **Códigos de acceso por email y avisos a compañeros** (`RESEND_API_KEY` y `EMAIL_FROM`):
   1. Crea una cuenta en <https://resend.com>.
   2. **Domains → Add domain** con un dominio tuyo y añade en tu DNS los registros que te indique (SPF y DKIM). Sin dominio propio, Resend solo deja enviarte correos a ti mismo: sirve para probar, no para usuarios.
   3. **API Keys → Create API key** con permiso «Sending access» → `RESEND_API_KEY`.
   4. `EMAIL_FROM` = `Céntrate <hola@tu-dominio.com>` (con el dominio verificado).

   Sin Resend se puede entrar solo con Google, y los compañeros ven los avisos en la app, pero no por email.

6. **Coach con IA** (`ANTHROPIC_API_KEY`):
   1. En <https://console.anthropic.com> → **Settings → API keys → Create key** → `ANTHROPIC_API_KEY`. La clave solo vive en el servidor, nunca dentro de la app.
   2. Pon un límite de gasto mensual en **Settings → Limits** de la consola de Anthropic.
   3. El servidor ya limita el uso por usuario y día, y el gasto total a `AI_GLOBAL_DAILY_BUDGET_USD` (2 $ al día por defecto; déjalo vacío para usar ese valor).
   4. **Para apagar el coach** (por ejemplo, si el gasto se dispara): **centrate-api → Environment** → pon `AI_ENABLED` a `false` → **Save and deploy**. Tarda 1–2 minutos. Para encenderlo de nuevo, pon `true` o déjalo vacío. Render respeta lo que pongas ahí aunque cambie el Blueprint.
7. **`APP_ORIGINS`**: déjalo vacío (la app de escritorio no lo necesita).
8. **Comprobar**: abre `https://centrate-api.onrender.com/health` (con tu URL). En `capabilities` verás `"enabled": true` en lo que ya funciona y, en lo demás, el motivo (`missing_key` = falta una clave).

**Límites del plan gratuito de Render** (la app ya cuenta con ellos: nunca espera a la nube y reintenta sola):

- El servicio **se duerme tras 15 minutos sin uso**; la primera petición después tarda alrededor de un minuto. Las horas gratuitas del mes se comparten entre todos los servicios gratuitos de tu cuenta.
- La base de datos gratuita **caduca a los 30 días** de crearla (Render avisa por email) y tiene 1 GB. Al recrearla, la app vuelve a subir las estadísticas, pero se pierden los amigos, las invitaciones y los compañeros. Para que dure, cambia `centrate-db` a un plan de pago en Render (**centrate-db → Upgrade**).

## 6. Buscar la marca en los registros de marcas antes de publicar

La marca de Céntrate (una «C» con un punto en la boca, `assets/brand/icon.svg`) se rediseñó porque la primera versión se parecía a otras (`DECISIONS.md`, «Marca e iconos»). La comparación automática ya está hecha, pero las búsquedas de marcas figurativas necesitan una persona:

1. En <https://www.tmdn.org/tmview/> → **Búsqueda por imagen**: sube `apps/desktop/build/icons/512x512.png`, territorios UE y España, clases de Niza 9 y 42. Repite la búsqueda por códigos de Viena: 26.01 (círculos y elipses) y 27.05 (letras con grafismo especial), con la letra C.
2. En <https://branddb.wipo.int> → **Image** con la misma imagen y los mismos códigos de Viena.
3. Si algo se parece mucho (sobre todo en la clase 9, software), dímelo antes de la primera versión y ajusto la marca. Si no, apunta la fecha de la búsqueda en `DECISIONS.md`.

## 7. Material de la web: dejar que GitHub Actions abra su pull request

El workflow **Marketing assets** (`.github/workflows/marketing-assets.yml`) regenera las capturas y los vídeos de la web desde la app real con cada release (y cuando lo lanzas a mano), comprueba sus presupuestos de peso y abre un pull request contra `main` con ellos. Necesita un ajuste del repositorio y, mejor, un secreto:

1. **Obligatorio.** En <https://github.com/Imdlodoem23/App-to-not-Procastinate/settings/actions> → **General → Workflow permissions**, marca **Allow GitHub Actions to create and approve pull requests** y pulsa **Save**. Viene desactivado: sin él, cada release y cada ejecución manual fallan en el último paso («Open or update the pull request») y el material nuevo se queda en el artifact de la ejecución.
2. **Opcional, pero recomendado: el secreto `MARKETING_PR_TOKEN`.** GitHub no lanza otros workflows en un pull request abierto con el token automático de Actions, así que ese pull request no pasa el CI (lint, formato y los presupuestos de peso de la web). Con un token tuyo, sí:
   1. En <https://github.com/settings/personal-access-tokens/new> crea un **fine-grained token**: nombre «Céntrate marketing», la caducidad que quieras (al caducar, repite estos pasos), **Only select repositories** → `App-to-not-Procastinate` y, en **Repository permissions**, **Contents: Read and write** y **Pull requests: Read and write**.
   2. En el repositorio: **Settings → Secrets and variables → Actions → New repository secret**, nombre `MARKETING_PR_TOKEN`, y pega el token.

   Sin el secreto, el workflow funciona igual y ya comprueba los presupuestos antes de abrir el pull request; para que pase también el CI, ciérralo y vuelve a abrirlo.
