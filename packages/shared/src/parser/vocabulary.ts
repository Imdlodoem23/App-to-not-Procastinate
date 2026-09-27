/**
 * Word lists for the parser, in folded form (lowercase, no accents, «ñ» → «n»).
 */

function words(list: string): ReadonlySet<string> {
  return new Set(list.split(/\s+/).filter((word) => word.length > 0));
}

/** Words that say «block this»: negations, imperatives and colloquial forms. */
export const TRIGGERS = words(`
  no ni nada sin nunca jamas tampoco cero fuera stop block
  bloquea bloqueame bloquear bloquearme bloqueo bloquee bloqueen bloqueas bloquealo bloqueala
  bloquealos bloquealas
  quita quitame quitar quitarme quitalo quitala quitalos quitalas quitate
  prohibido prohibida prohibidos prohibidas prohibe prohibeme prohibir prohibirme
  evita evitame evitar corta cortame cortar cierra cierrame cerrar apaga apagame apagar
  desactiva desactivame desactivar adios chao chau bye basta olvidate olvidarme
  bloquees
`);

/**
 * Words allowed between a block word and a weak alias right after it: «no veo x», «no me
 * dejes entrar en reddit», «no quiero jugar», «sin el mine».
 */
export const TRIGGER_BRIDGE = words(`
  el la los las lo un una unos unas de del d a al en me te le les nos mi mis tu tus su sus
  ver veo veas vea mirar miro mires usar uso uses use entrar entro entres abrir abro abras
  meter meterme meto metas echar echo leer leo lees lea leas escuchar escucho escuches
  navegar navego navegues comprar compro compres jugar juego juegues juegue juegas jugando
  quiero quieres quiera quisiera kiero kieres puedo puedes pueda dejes deje dejeis dejen mas
`);

/** Triggers only when followed by «de»: «paso de Instagram», «dejar de ver YouTube». */
export const TRIGGERS_BEFORE_DE = words('paso pasar deja dejar dejo');

/** «de», also in its texting spelling «d» («nada d redes»). */
export function isDe(word: string): boolean {
  return word === 'de' || word === 'd';
}

/** Words that add nothing on their own (articles, pronouns, filler verbs, politeness). */
export const SILENT = words(`
  el la los las lo un una unos unas de del d a al en por para pa pal con y e o u que q k
  me te se mi mis tu tus su sus nos le les yo
  ver veo veas vea mirar miro mires usar uso uses use entrar entro entres abrir abro abras
  meter meterme meto metas echar echo leo lees lea leas escuchar escucho escuches navegar
  navego navegues compro compres juegue juegues jugando jugar juego juegas comprar
  quiero quieres quiera quisiera kiero kieres voy vas va vamos ir
  tengo tienes tiene tenemos toca pongo poner ponerme ponga puedo puedes pueda poder
  necesito necesita ganas apetece falta permiteme dejeme dejes deje dejeis dejen dejame deja
  dejar dejo hacer hago haz estar estoy
  mas ya ahora hoy mismo porfa porfis porfi porfaa porfavor favor please pls plis plz xfa
  xfavor xfi xfis gracias vale ok okay
  oye venga eh bueno pues tio tia bro todo toda todos todas ningun ninguna ninguno ningunos
  ningunas algo esto este esta eso esa ese estos estas
  app apps aplicacion aplicaciones web webs pagina paginas online internet
  durante proximas proximos siguientes desde
  distracciones distraccion distraerme centrarme concentrarme centrar concentrar
  centrarse concentrarse enfocarme focus
`);

/**
 * Silent words kept at the start of an unparsed fragment because they carry its meaning
 * («en clase», «durante la cena»).
 */
export const FRAGMENT_KEEP_START = words(
  'en por para pa con durante desde sobre este esta estos estas todo toda todos todas',
);

/** Laughter and similar noise («jajaja», «xd», «lol» when it is not League of Legends). */
const LAUGHTER_RE = /^(?:(?:j[aeijos])+j?|(?:ha){2,}h?|x+d+|lo+l|lmao)$/;

/** True for words that add nothing on their own: `SILENT` words and laughter. */
export function isFiller(word: string): boolean {
  return SILENT.has(word) || LAUGHTER_RE.test(word);
}

/** Words that want to use something («quiero ver YouTube»), not block it. */
export const DESIRE = words(
  'quiero quiera quisiera kiero voy vamos necesito puedo dejame apetece ganas',
);
/**
 * Use verbs, infinitive and first person («ver», «veo», «jugar», «juego»…). Without a block
 * word, one of them before a target means the user wants to use it: «ver Netflix 2h».
 */
export const CONSUME = words(`
  ver veo mirar miro jugar juego usar uso entrar entro abrir abro abre abreme echar echo
  meterme meto leo escuchar escucho comprar compro navegar navego chatear
`);
/** Words that want a target right after them: «necesito el WhatsApp», «ganas de YouTube». */
export const DESIRE_BEFORE_TARGET = words(`
  necesito necesita necesitamos apetece ganas falta dejame dejeme permiteme
`);

/** Study verbs dropped from the task: «estudiar mates» → task «mates». */
export const STUDY_VERBS = words(`
  estudiar estudio estudia estudiando estudiare estudie estudiemos
  repasar repaso repasa repasando repasare repase
`);

/** Study nouns kept in the task: «hacer deberes de inglés» → task «deberes de inglés». */
export const STUDY_NOUNS = words('deberes tarea tareas leer lectura');

/**
 * Study nouns that count only after «hacer»: «hacer el trabajo de historia», «hacer
 * ejercicios de mates». Alone they are ordinary words («voy al trabajo»).
 */
export const STUDY_NOUNS_AFTER_HACER = words(`
  trabajo trabajos ejercicio ejercicios apuntes resumen resumenes esquema esquemas
  actividades redaccion
`);

/** Verbs that may introduce a study noun («hacer los deberes»). */
export const STUDY_NOUN_VERBS = words('hacer hago haz hacemos haciendo');
export const STUDY_NOUN_ARTICLES = words('el la los las mi mis un una unos unas');

/** Filler and time words never kept at either end of a task: «estudiar ya», «un rato». */
const TASK_FILLER = `
  ya ahora hoy rato ratito seguidas seguidos seguida seguido toda todo todas todos tarde noche
  mas menos poco bien entera entero asi
`;

/** Leading words removed from a task: «estudiar para el examen» → «examen». */
export const TASK_TRIM_START = words(`
  de del d el la los las lo un una unos unas para pa sobre a al un poco algo mi mis
  ${TASK_FILLER}
`);

/** Trailing words removed from a task. */
export const TASK_TRIM_END = words(`
  y e o u ni de del d el la los las un una a al para pa por en con durante que me esta este
  ${TASK_FILLER}
`);

/**
 * Other known words, never fuzzy-matched to a service («diario» must not become the
 * news category «diarios»).
 */
export const OTHER_KNOWN = words(`
  hasta asta manana tarde noche madrugada mediodia medianoche media medio cuarto cuartos
  punto menos hora horas horita horitas ora oras minuto minutos minutito minutitos dia dias
  semana semanas ayer luego despues antes rato ratito diario diaria clase clases movil tele
  ordenador examen examenes trabajo modo estricto hardcore normal cenar comer dormir
  insti instituto cole colegio tienda tiendecita compra super supermercado momento vida
  disco discos valorar valora valoro steams sports amazonas maximo entera entero seguidas
  seguidos excepto salvo quitando exceptuando pero cuando aqui aki sean
`);
